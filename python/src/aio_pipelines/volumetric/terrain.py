"""Terrain mesh of one survey date as a GLB, in the layout the native volumetric workspace reads.

Ported from the app's Masafi importer (``packages/project/src/import/terrain.ts``
``buildTerrain``, ``masafi.ts`` ``terrainGlb`` and ``toeLine``, ``glb.ts`` ``encodeGlb``), so a
project built from raw data looks and behaves like the imported Masafi project:

- a height lattice (block mean of the 10 cm DSM, 0.5 m by default) meshed at twice its spacing
  for the ground, and at its own spacing within ``region_buffer`` metres of each pile zone;
  fine and coarse cells meet without cracks (edge midpoints snapped onto the coarse edge);
- one node per pile and date named ``<pile>_<epoch>`` (``extras.type = "stockpile"``) holding
  its surface and the toe line as a line primitive 0.15 m above the surface; the ground node
  ``Terrain_<epoch>`` carries ``extras.type = "terrain"``;
- the site photo as the texture of every surface (u right from the grid's west edge, v down
  from its north edge).

Local frame (data-conventions section 1): ``x = E - E0``, ``y = H - H0``, ``z = -(N - N0)``.
"""

from __future__ import annotations

import json
import struct
import warnings
from dataclasses import dataclass

import numpy as np

TOE_COLOR = [1.0, 0.552, 0.0, 1.0]  # linear RGB of #ffc400
TOE_LIFT_M = 0.15


@dataclass
class HeightGrid:
    """North-up grid: cell (i, j) centre at E = x0 + (i + 0.5) res, N = y1 - (j + 0.5) res."""

    z: np.ndarray  # (h, w) float, NaN = no data
    res: float
    x0: float
    y1: float

    @property
    def h(self) -> int:
        return self.z.shape[0]

    @property
    def w(self) -> int:
        return self.z.shape[1]


def block_mean(
    z10: np.ndarray, res: float, x0: float, y1: float, f: int, min_frac: float = 0.5
) -> HeightGrid:
    """Mean of each f x f block; blocks with fewer than ``min_frac`` valid samples are no data."""
    H, W = z10.shape[0] // f, z10.shape[1] // f
    b = np.asarray(z10[: H * f, : W * f], dtype=np.float64).reshape(H, f, W, f)
    n = np.sum(~np.isnan(b), axis=(1, 3))
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)
        m = np.nanmean(b, axis=(1, 3))
    need = max(1, int(np.ceil(min_frac * f * f)))
    m[n < need] = np.nan
    return HeightGrid(m.astype(np.float32), res * f, x0, y1)


def sample_height(g: HeightGrid, e: float, n: float) -> float | None:
    """Bilinear height between cell centres; None outside the grid or next to no data."""
    fx = (e - g.x0) / g.res - 0.5
    fy = (g.y1 - n) / g.res - 0.5
    i, j = int(np.floor(fx)), int(np.floor(fy))
    if i < 0 or j < 0 or i >= g.w - 1 or j >= g.h - 1:
        return None
    a, b, c, d = g.z[j, i], g.z[j, i + 1], g.z[j + 1, i], g.z[j + 1, i + 1]
    if np.isnan(a) or np.isnan(b) or np.isnan(c) or np.isnan(d):
        return None
    tx, ty = fx - i, fy - j
    return float((a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty)


def height_near(g: HeightGrid, e: float, n: float) -> float | None:
    """Height at (E, N), or at the nearest lattice cell with data within 3 cells."""
    h = sample_height(g, e, n)
    if h is not None:
        return h
    ci = int(np.floor((e - g.x0) / g.res))
    cj = int(np.floor((g.y1 - n) / g.res))
    for r in range(4):
        for dj in range(-r, r + 1):
            for di in range(-r, r + 1):
                i, j = ci + di, cj + dj
                if 0 <= i < g.w and 0 <= j < g.h and not np.isnan(g.z[j, i]):
                    return float(g.z[j, i])
    return None


def _inside(x: np.ndarray, y: np.ndarray, ring: np.ndarray) -> np.ndarray:
    """Even-odd point in polygon (terrain.ts pointInRing), vectorised over points."""
    out = np.zeros(x.shape, bool)
    n = len(ring)
    for i in range(n):
        xi, yi = ring[i]
        xj, yj = ring[i - 1]
        cross = (yi > y) != (yj > y)
        with np.errstate(divide="ignore", invalid="ignore"):
            xint = (xj - xi) * (y - yi) / (yj - yi) + xi
        out ^= cross & (x < xint)
    return out


def _dist(x: np.ndarray, y: np.ndarray, ring: np.ndarray) -> np.ndarray:
    best = np.full(x.shape, np.inf)
    n = len(ring)
    for i in range(n):
        ax, ay = ring[i - 1]
        bx, by = ring[i]
        dx, dy = bx - ax, by - ay
        l2 = dx * dx + dy * dy
        t = np.clip(((x - ax) * dx + (y - ay) * dy) / l2, 0, 1) if l2 > 0 else np.zeros(x.shape)
        best = np.minimum(best, np.hypot(x - ax - t * dx, y - ay - t * dy))
    return best


@dataclass
class Part:
    name: str
    positions: np.ndarray  # (n, 3) float32
    normals: np.ndarray
    uvs: np.ndarray
    indices: np.ndarray  # (m,) uint32


def build_terrain(
    g: HeightGrid,
    origin: tuple[float, float, float],
    regions: list[tuple[str, list[list[float]]]],
    region_buffer: float,
    uv_window: tuple[float, float, float, float],
) -> tuple[Part, list[Part]]:
    """terrain.ts ``buildTerrain``: returns the ground part and the region parts that have
    triangles. ``uv_window`` is (x0, y0, x1, y1) of the ground the texture spans."""
    cw, ch = (g.w - 1) // 2, (g.h - 1) // 2
    cj_idx, ci_idx = np.mgrid[0:ch, 0:cw]
    cx = g.x0 + (2 * ci_idx + 1 + 0.5) * g.res
    cy = g.y1 - (2 * cj_idx + 1 + 0.5) * g.res

    owner = np.full((ch, cw), -1, np.int32)
    best_d = np.full((ch, cw), np.inf)
    for k, (_, ring_l) in enumerate(regions):
        ring = np.asarray(ring_l, dtype=np.float64)
        b = region_buffer
        x0, y0 = ring[:, 0].min() - b, ring[:, 1].min() - b
        x1, y1 = ring[:, 0].max() + b, ring[:, 1].max() + b
        sel = (cx >= x0) & (cx <= x1) & (cy >= y0) & (cy <= y1) & ~((owner >= 0) & (best_d == 0))
        if not sel.any():
            continue
        px, py = cx[sel], cy[sel]
        d = np.where(_inside(px, py, ring), 0.0, _dist(px, py, ring))
        take = (d <= region_buffer) & (d < best_d[sel])
        o = owner[sel]
        bd = best_d[sel]
        o[take] = k
        bd[take] = d[take]
        owner[sel] = o
        best_d[sel] = bd

    def owner_at(ci: np.ndarray, cj: np.ndarray) -> np.ndarray:
        ok = (ci >= 0) & (cj >= 0) & (ci < cw) & (cj < ch)
        out = np.full(ci.shape, -1, np.int32)
        out[ok] = owner[cj[ok], ci[ok]]
        return out

    Z = g.z.astype(np.float64)
    valid = ~np.isnan(Z)

    def height(i: np.ndarray, j: np.ndarray) -> np.ndarray:
        h = Z[j, i].copy()
        odd_i, odd_j = i % 2 == 1, j % 2 == 1
        a = odd_i & ~odd_j
        if a.any():
            ia, ja = i[a], j[a]
            ci = (ia - 1) // 2
            snap = (owner_at(ci, ja // 2 - 1) < 0) | (owner_at(ci, ja // 2) < 0)
            hv = h[a]
            hv[snap] = (Z[ja[snap], ia[snap] - 1] + Z[ja[snap], ia[snap] + 1]) / 2
            h[a] = hv
        b = ~odd_i & odd_j
        if b.any():
            ib, jb = i[b], j[b]
            cj = (jb - 1) // 2
            snap = (owner_at(ib // 2 - 1, cj) < 0) | (owner_at(ib // 2, cj) < 0)
            hv = h[b]
            hv[snap] = (Z[jb[snap] - 1, ib[snap]] + Z[jb[snap] + 1, ib[snap]]) / 2
            h[b] = hv
        return h

    def slope(i: np.ndarray, j: np.ndarray, di: int, dj: int) -> np.ndarray:
        def ok(a, b):
            r = (a >= 0) & (b >= 0) & (a < g.w) & (b < g.h)
            out = np.zeros(a.shape, bool)
            out[r] = valid[b[r], a[r]]
            return out

        def zat(a, b):
            out = np.zeros(a.shape)
            r = (a >= 0) & (b >= 0) & (a < g.w) & (b < g.h)
            out[r] = Z[b[r], a[r]]
            return out

        p, m = ok(i + di, j + dj), ok(i - di, j - dj)
        zp, zm, z0 = zat(i + di, j + dj), zat(i - di, j - dj), Z[j, i]
        return np.where(p & m, (zp - zm) / 2, np.where(p, zp - z0, np.where(m, z0 - zm, 0.0)))

    e0, n0, h0 = origin
    ux0, uy0, ux1, uy1 = uv_window

    def part(name: str, quads: list[tuple[np.ndarray, np.ndarray, int]]) -> Part:
        tris = []
        for i, j, s in quads:
            ok = valid[j, i] & valid[j, i + s] & valid[j + s, i] & valid[j + s, i + s]
            i, j = i[ok], j[ok]
            a = j * g.w + i
            r = j * g.w + i + s
            c = (j + s) * g.w + i
            d = (j + s) * g.w + i + s
            # counter-clockwise seen from above (+Y): x east, z south
            tris.append(np.stack([a, c, r, r, c, d], axis=1).reshape(-1))
        keys = np.concatenate(tris) if tris else np.zeros(0, np.int64)
        if not keys.size:
            z3 = np.zeros((0, 3), np.float32)
            return Part(name, z3, z3, np.zeros((0, 2), np.float32), np.zeros(0, np.uint32))
        uniq, inv = np.unique(keys, return_inverse=True)
        vj, vi = np.divmod(uniq, g.w)
        e = g.x0 + (vi + 0.5) * g.res
        n = g.y1 - (vj + 0.5) * g.res
        dzdx = slope(vi, vj, 1, 0) / g.res
        dzdn = -slope(vi, vj, 0, 1) / g.res  # row index grows southwards
        nx, nz = -dzdx, dzdn  # local z points south: dH/dz = -dH/dN
        ln = np.sqrt(nx * nx + 1 + nz * nz)
        pos = np.stack([e - e0, height(vi, vj) - h0, -(n - n0)], axis=1)
        nor = np.stack([nx / ln, 1 / ln, nz / ln], axis=1)
        uv = np.stack([(e - ux0) / (ux1 - ux0), (uy1 - n) / (uy1 - uy0)], axis=1)
        return Part(
            name,
            pos.astype(np.float32),
            nor.astype(np.float32),
            uv.astype(np.float32),
            inv.astype(np.uint32).reshape(-1),
        )

    ground_cj, ground_ci = np.nonzero(owner < 0)
    ground = part("ground", [(2 * ground_ci, 2 * ground_cj, 2)])
    out = []
    for k, (name, _) in enumerate(regions):
        cj, ci = np.nonzero(owner == k)
        i, j = 2 * ci, 2 * cj
        p = part(name, [(i, j, 1), (i + 1, j, 1), (i, j + 1, 1), (i + 1, j + 1, 1)])
        if p.indices.size:
            out.append(p)
    return ground, out


def toe_line(ring: list[list[float]], g: HeightGrid, origin) -> tuple[np.ndarray, np.ndarray] | None:
    """Closed toe line as line-segment pairs, lifted above the surface (masafi.ts toeLine)."""
    pts = [list(p) for p in ring]
    if len(pts) > 1 and pts[0] == pts[-1]:
        pts.pop()
    e0, n0, h0 = origin
    pos, keep = [], []
    for e, n in pts:
        h = height_near(g, e, n)
        keep.append(h is not None)
        pos.append([e - e0, (h or 0.0) + TOE_LIFT_M - h0, -(n - n0)])
    idx = []
    for i in range(len(pts)):
        j = (i + 1) % len(pts)
        if keep[i] and keep[j]:
            idx += [i, j]
    if not idx:
        return None
    return np.asarray(pos, np.float32), np.asarray(idx, np.uint32)


# ------------------------------------------------------------------ GLB (glb.ts encodeGlb)

FLOAT, U16, U32 = 5126, 5123, 5125
ARRAY_BUFFER, ELEMENT_ARRAY_BUFFER = 34962, 34963


def encode_glb(
    nodes: list[dict], scene: list[int], meshes: list[dict], materials: list[dict], images, generator
):
    """``meshes``: [{name, primitives: [{material, mode?, positions, normals?, uvs?, indices}]}];
    ``images``: [(mime, bytes)]."""
    chunks: list[bytes] = []
    offset = 0
    views: list[dict] = []
    accessors: list[dict] = []

    def view(b: bytes, target: int | None = None) -> int:
        nonlocal offset
        pad = (4 - offset % 4) % 4
        if pad:
            chunks.append(b"\0" * pad)
            offset += pad
        chunks.append(b)
        v = {"buffer": 0, "byteOffset": offset, "byteLength": len(b)}
        if target:
            v["target"] = target
        views.append(v)
        offset += len(b)
        return len(views) - 1

    def float_acc(a: np.ndarray, n: int, bounds: bool) -> int:
        a = np.ascontiguousarray(a, dtype="<f4").reshape(-1, n)
        acc = {"bufferView": view(a.tobytes(), ARRAY_BUFFER), "componentType": FLOAT, "count": len(a)}
        acc["type"] = "VEC3" if n == 3 else "VEC2"
        if bounds and len(a):
            acc["min"] = [float(v) for v in a.min(axis=0)]
            acc["max"] = [float(v) for v in a.max(axis=0)]
        accessors.append(acc)
        return len(accessors) - 1

    def index_acc(idx: np.ndarray, count: int) -> int:
        small = count <= 0xFFFF
        data = idx.astype("<u2" if small else "<u4")
        accessors.append(
            {
                "bufferView": view(data.tobytes(), ELEMENT_ARRAY_BUFFER),
                "componentType": U16 if small else U32,
                "count": int(idx.size),
                "type": "SCALAR",
            }
        )
        return len(accessors) - 1

    jmeshes = []
    for m in meshes:
        prims = []
        for p in m["primitives"]:
            count = len(p["positions"]) if p["positions"].ndim == 2 else p["positions"].size // 3
            attrs = {"POSITION": float_acc(p["positions"], 3, True)}
            if p.get("normals") is not None:
                attrs["NORMAL"] = float_acc(p["normals"], 3, False)
            if p.get("uvs") is not None:
                attrs["TEXCOORD_0"] = float_acc(p["uvs"], 2, False)
            prim = {"attributes": attrs, "indices": index_acc(p["indices"], count), "material": p["material"]}
            if p.get("mode") == "lines":
                prim["mode"] = 1
            prims.append(prim)
        jmeshes.append({"name": m["name"], "primitives": prims})
    jimages = [{"bufferView": view(data), "mimeType": mime} for mime, data in images]
    mats = []
    for m in materials:
        pbr: dict = {}
        if "color" in m:
            pbr["baseColorFactor"] = m["color"]
        if "texture" in m:
            pbr["baseColorTexture"] = {"index": m["texture"]}
        pbr["metallicFactor"] = 0
        pbr["roughnessFactor"] = 1
        mats.append({"name": m["name"], "pbrMetallicRoughness": pbr})
    doc: dict = {
        "asset": {"version": "2.0", "generator": generator},
        "scene": 0,
        "scenes": [{"nodes": scene}],
        "nodes": nodes,
        "meshes": jmeshes,
        "materials": mats,
        "accessors": accessors,
        "bufferViews": views,
        "buffers": [{"byteLength": offset}],
    }
    if jimages:
        # linear filtering with mipmaps, clamped at the edges
        doc["samplers"] = [{"magFilter": 9729, "minFilter": 9987, "wrapS": 33071, "wrapT": 33071}]
        doc["textures"] = [{"sampler": 0, "source": i} for i in range(len(jimages))]
        doc["images"] = jimages
    js = json.dumps(doc, separators=(",", ":")).encode("utf-8")
    js += b" " * ((4 - len(js) % 4) % 4)
    binary = b"".join(chunks)
    binary += b"\0" * ((4 - len(binary) % 4) % 4)
    total = 12 + 8 + len(js) + 8 + len(binary)
    return b"".join(
        [
            struct.pack("<III", 0x46546C67, 2, total),
            struct.pack("<II", len(js), 0x4E4F534A),
            js,
            struct.pack("<II", len(binary), 0x004E4942),
            binary,
        ]
    )


def terrain_glb(epoch: str, ground: Part, regions: list[Part], texture_jpeg: bytes | None, toe) -> bytes:
    """masafi.ts ``terrainGlb``: root ``Stockyard_<e>``, ground ``Terrain_<e>``, one node per pile."""
    meshes: list[dict] = []
    nodes: list[dict] = [{"name": f"Stockyard_{epoch}", "children": []}]

    def surface(p: Part) -> dict:
        d = {"material": 0, "positions": p.positions, "normals": p.normals, "indices": p.indices}
        if texture_jpeg is not None:
            d["uvs"] = p.uvs
        return d

    if ground.indices.size:
        meshes.append({"name": f"Terrain_{epoch}", "primitives": [surface(ground)]})
        nodes.append({"name": f"Terrain_{epoch}", "mesh": len(meshes) - 1, "extras": {"type": "terrain"}})
    for r in regions:
        line = toe(r.name)
        prims = [surface(r)]
        if line is not None:
            prims.append({"material": 1, "mode": "lines", "positions": line[0], "indices": line[1]})
        meshes.append({"name": r.name, "primitives": prims})
        nodes.append({"name": r.name, "mesh": len(meshes) - 1, "extras": {"type": "stockpile"}})
    nodes[0]["children"] = list(range(1, len(nodes)))
    ground_mat: dict = {"name": f"Ground_Ortho_{epoch}"}
    if texture_jpeg is not None:
        ground_mat["texture"] = 0
    else:
        ground_mat["color"] = [0.46, 0.44, 0.4, 1.0]
    return encode_glb(
        nodes,
        [0],
        meshes,
        [ground_mat, {"name": "Toe_Line", "color": TOE_COLOR}],
        [("image/jpeg", texture_jpeg)] if texture_jpeg is not None else [],
        "Quadrion AI pipelines (Volumetric Survey Kit terrain)",
    )
