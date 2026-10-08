"""tiles.mesh: a GLB or OBJ mesh to a 3D Tiles 1.1 tileset placed through the project CRS.

Parameters as ``TilesMeshParams`` in ``@aio/schema`` ``jobs.ts``: a mesh layer (its file and its
``transform``) or a mesh file inside the project (in the project local frame, as a processing run
writes its full-resolution mesh). Writes ``tiles/<id>/tileset.json`` and ``content/*.glb``, then
adds the entry to ``tilesets.json`` (``.bak`` kept; data-conventions section 22).

- Every vertex goes to ECEF through the project CRS in float64 (``transform.py``), so the site view
  and the Globe agree; content is stored relative to each tile's centre.
- The tree splits space (the axes longer than half the longest, so a flat site becomes a quadtree
  and a tower an octree) until a tile holds at most ``maxTrianglesPerTile`` triangles at full
  resolution. Every tile above the leaves holds the same surface simplified by vertex clustering
  at a cell half its parent's (the cell is its geometric error; leaves are exact, error 0), with
  ``REPLACE`` refinement.
- Textures are cropped to what a tile uses and scaled down (Pillow) with the tile's level, at most
  ``textureMaxPx`` at the leaves.
- ``compression``: Meshopt and Draco are not in this pack yet; tiles are written without
  compression (a warning says so).
"""

from __future__ import annotations

import io
import math
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np

from ..params import known_keys, number, text
from ..runtime import JobError, Step, StepContext, atomic_write_bytes, atomic_write_json, safe_project_path
from .gltf import Part, write_glb
from .tileset import Tile, is_tileset_id, replace_folder, safe_tileset_id, tileset_json, upsert_tileset
from .transform import SiteFrame, box_of, enu_to_gltf

KEYS = {"layer", "src", "id", "name", "run", "compression", "maxTrianglesPerTile", "textureMaxPx"}
COMPRESSION = ("meshopt", "draco", "none")
DEFAULT_MAX_TRIANGLES = 100_000
DEFAULT_TEXTURE_PX = 2048
MAX_DEPTH = 14
GENERATOR = "Quadrion AI tiles.mesh"


@dataclass
class SrcPart:
    """One surface of the source with one material, in the root's east-north-up frame."""

    enu: np.ndarray  # (n, 3) float64
    faces: np.ndarray  # (m, 3) int64
    uvs: np.ndarray | None
    colors: np.ndarray | None  # (n, 4) uint8
    image: Any  # PIL image or None
    base_color: tuple[float, float, float, float]
    #: Texture units per metre along edges (median), to size texture cells when simplifying.
    uv_per_m: float = 0.0


def _material(
    visual: Any,
) -> tuple[np.ndarray | None, Any, np.ndarray | None, tuple[float, float, float, float]]:
    """uvs, image, vertex colours and base colour of a trimesh visual."""
    uvs = image = colors = None
    base = (1.0, 1.0, 1.0, 1.0)
    kind = getattr(visual, "kind", None)
    if kind == "texture":
        uv = getattr(visual, "uv", None)
        mat = getattr(visual, "material", None)
        img = getattr(mat, "baseColorTexture", None) or getattr(mat, "image", None)
        factor = getattr(mat, "baseColorFactor", None)
        if factor is not None:
            f = np.asarray(factor, dtype=np.float64).ravel()
            f = f / 255.0 if f.max() > 1.0 else f
            if f.size >= 3:
                base = (float(f[0]), float(f[1]), float(f[2]), float(f[3]) if f.size > 3 else 1.0)
        if uv is not None and img is not None:
            uvs = np.asarray(uv, dtype=np.float64)
            image = img
    elif kind == "vertex":
        colors = np.asarray(visual.vertex_colors, dtype=np.uint8)
    elif kind == "face":
        fc = np.asarray(visual.face_colors, dtype=np.uint8)
        if len(fc):
            c = fc[0]
            base = (c[0] / 255, c[1] / 255, c[2] / 255, c[3] / 255)
    return uvs, image, colors, base


def load_parts(path: Path, layer_transform: list[float] | None, frame: SiteFrame) -> list[SrcPart]:
    import trimesh

    try:
        scene = trimesh.load(str(path), force="scene", process=False)
    except Exception as e:
        raise JobError(f"The model {path.name} could not be read: {e}") from e
    layer = np.array(layer_transform, dtype=np.float64).reshape(4, 4).T if layer_transform else np.eye(4)
    parts: list[SrcPart] = []
    for node in scene.graph.nodes_geometry:
        mat, gname = scene.graph[node]
        g = scene.geometry.get(gname)
        if not isinstance(g, trimesh.Trimesh) or not len(g.faces):
            continue
        m = layer @ np.asarray(mat, dtype=np.float64)
        v = np.asarray(g.vertices, dtype=np.float64)
        local = v @ m[:3, :3].T + m[:3, 3]
        uvs, image, colors, base = _material(g.visual)
        faces = np.asarray(g.faces, dtype=np.int64)
        parts.append(
            SrcPart(
                enu=frame.local_to_enu(local),
                faces=faces,
                uvs=uvs,
                colors=colors,
                image=image,
                base_color=base,
                uv_per_m=uv_scale(local, faces, uvs),
            )
        )
    if not parts:
        raise JobError(f"The model {path.name} has no surfaces.")
    return parts


# ---------------------------------------------------------------- geometry


def uv_scale(pos: np.ndarray, faces: np.ndarray, uvs: np.ndarray | None) -> float:
    if uvs is None or not len(faces):
        return 0.0
    a, b = faces[:, 0], faces[:, 1]
    dp = np.linalg.norm(pos[a] - pos[b], axis=1)
    du = np.linalg.norm(uvs[a] - uvs[b], axis=1)
    ok = dp > 1e-9
    return float(np.median(du[ok] / dp[ok])) if ok.any() else 0.0


def compact(
    part: SrcPart, faces_idx: np.ndarray
) -> tuple[np.ndarray, np.ndarray, np.ndarray | None, np.ndarray | None]:
    """The vertices used by some faces, with the faces renumbered."""
    f = part.faces[faces_idx]
    used, inv = np.unique(f.ravel(), return_inverse=True)
    faces = inv.reshape(-1, 3)
    uvs = part.uvs[used] if part.uvs is not None else None
    cols = part.colors[used] if part.colors is not None else None
    return part.enu[used], faces, uvs, cols


def cluster(
    enu: np.ndarray,
    faces: np.ndarray,
    uvs: np.ndarray | None,
    cols: np.ndarray | None,
    cell: float,
    lo: np.ndarray,
    uv_cell: float,
) -> tuple[np.ndarray, np.ndarray, np.ndarray | None, np.ndarray | None]:
    """Vertex clustering: vertices sharing a cell (and a texture cell) merge to their mean."""
    k = np.floor((enu - lo) / cell).astype(np.int64)
    if uvs is not None:
        k = np.concatenate([k, np.floor(uvs / uv_cell).astype(np.int64)], axis=1)
    _, inv = np.unique(k, axis=0, return_inverse=True)
    inv = inv.ravel()
    n = int(inv.max()) + 1 if inv.size else 0
    count = np.bincount(inv, minlength=n).astype(np.float64)

    def mean(a: np.ndarray) -> np.ndarray:
        return (
            np.stack([np.bincount(inv, weights=a[:, i], minlength=n) for i in range(a.shape[1])], axis=1)
            / count[:, None]
        )

    new_enu = mean(enu)
    new_uv = mean(uvs) if uvs is not None else None
    new_col = (
        np.clip(np.rint(mean(cols.astype(np.float64))), 0, 255).astype(np.uint8) if cols is not None else None
    )
    f = inv[faces]
    keep = (f[:, 0] != f[:, 1]) & (f[:, 1] != f[:, 2]) & (f[:, 0] != f[:, 2])
    f = f[keep]
    if len(f):
        _, first = np.unique(np.sort(f, axis=1), axis=0, return_index=True)
        f = f[np.sort(first)]
    return new_enu, f.reshape(-1, 3), new_uv, new_col


def vertex_normals(pos: np.ndarray, faces: np.ndarray) -> np.ndarray:
    n = np.zeros_like(pos)
    if len(faces):
        a, b, c = pos[faces[:, 0]], pos[faces[:, 1]], pos[faces[:, 2]]
        fn = np.cross(b - a, c - a)
        for i in range(3):
            np.add.at(n, faces[:, i], fn)
    length = np.linalg.norm(n, axis=1, keepdims=True)
    n = np.where(length > 0, n / np.maximum(length, 1e-12), np.array([0.0, 1.0, 0.0]))
    return n.astype(np.float32)


def texture_for(image: Any, uvs: np.ndarray, max_px: int) -> tuple[bytes, str, np.ndarray]:
    """The part of a texture some faces use (when their UVs stay in 0..1), scaled to ``max_px``."""
    from PIL import Image

    img: Image.Image = image if isinstance(image, Image.Image) else Image.open(io.BytesIO(image))
    w, h = img.size
    new_uv = uvs.copy()
    if len(uvs) and uvs.min() >= -1e-6 and uvs.max() <= 1 + 1e-6:
        # glTF v runs down the image; crop by pixel box with a one-pixel margin.
        u0, u1 = float(uvs[:, 0].min()), float(uvs[:, 0].max())
        v0, v1 = float(uvs[:, 1].min()), float(uvs[:, 1].max())
        x0, x1 = max(0, math.floor(u0 * w) - 1), min(w, math.ceil(u1 * w) + 1)
        y0, y1 = max(0, math.floor(v0 * h) - 1), min(h, math.ceil(v1 * h) + 1)
        if x1 - x0 >= 2 and y1 - y0 >= 2 and (x1 - x0) * (y1 - y0) < w * h:
            img = img.crop((x0, y0, x1, y1))
            new_uv[:, 0] = (uvs[:, 0] * w - x0) / (x1 - x0)
            new_uv[:, 1] = (uvs[:, 1] * h - y0) / (y1 - y0)
    scale = min(1.0, max_px / max(img.size))
    if scale < 1.0:
        img = img.resize(
            (max(1, round(img.size[0] * scale)), max(1, round(img.size[1] * scale))), Image.Resampling.LANCZOS
        )
    buf = io.BytesIO()
    if img.mode in ("RGBA", "LA") and img.getextrema()[-1][0] < 255:
        img.save(buf, "PNG")
        return buf.getvalue(), "image/png", new_uv
    img.convert("RGB").save(buf, "JPEG", quality=85)
    return buf.getvalue(), "image/jpeg", new_uv


# ---------------------------------------------------------------- tree


@dataclass
class TreeOptions:
    max_triangles: int
    texture_px: int
    #: Cells across a tile's longest side for its simplified surface.
    grid: int


def split_axes(lo: np.ndarray, hi: np.ndarray) -> list[int]:
    """The axes a tile splits along: those at least half as long as its longest."""
    ext = hi - lo
    return [i for i in range(3) if ext[i] >= 0.5 * ext.max()]


def child_code(points: np.ndarray, axes: list[int], mid: np.ndarray) -> np.ndarray:
    code = np.zeros(len(points), dtype=np.int64)
    for k, a in enumerate(axes):
        code |= (points[:, a] >= mid[a]).astype(np.int64) << k
    return code


def child_box(
    lo: np.ndarray, hi: np.ndarray, axes: list[int], mid: np.ndarray, code: int
) -> tuple[np.ndarray, np.ndarray]:
    c_lo, c_hi = lo.copy(), hi.copy()
    for k, a in enumerate(axes):
        if code >> k & 1:
            c_lo[a] = mid[a]
        else:
            c_hi[a] = mid[a]
    return c_lo, c_hi


class MeshTiler:
    def __init__(self, parts: list[SrcPart], opts: TreeOptions, out: Path, ctx: StepContext | None = None):
        self.parts = parts
        self.opts = opts
        self.out = out
        self.ctx = ctx
        self.total = sum(len(p.faces) for p in parts)
        self.done = 0
        self.centroids = [p.enu[p.faces].mean(axis=1) for p in parts]
        self.depth_estimate = max(0, math.ceil(math.log(max(1, self.total / opts.max_triangles), 4)))

    def run(self) -> Tile:
        allv = np.concatenate([p.enu for p in self.parts])
        lo, hi = allv.min(axis=0), allv.max(axis=0)
        span = float((hi - lo).max()) or 1.0
        # A cube-ish start so the cells are square on the ground.
        lo_c, hi_c = lo.copy(), lo + np.maximum(hi - lo, 1e-6)
        sel = [np.arange(len(p.faces)) for p in self.parts]
        root = self._node("0", lo_c, hi_c, sel, 0, span / self.opts.grid)
        return root

    def _content_box(self, sel: list[np.ndarray]) -> list[float]:
        pts = [p.enu[np.unique(p.faces[s].ravel())] for p, s in zip(self.parts, sel, strict=True) if len(s)]
        return box_of(np.concatenate(pts), pad=1e-3)

    def _node(
        self, key: str, lo: np.ndarray, hi: np.ndarray, sel: list[np.ndarray], depth: int, cell: float
    ) -> Tile:
        if self.ctx is not None:
            self.ctx.check()
        n = sum(len(s) for s in sel)
        box = self._content_box(sel)
        leaf = n <= self.opts.max_triangles or depth >= MAX_DEPTH or cell < 1e-4
        full = self.opts.texture_px
        tex_px = full if leaf else max(min(256, full), full >> max(0, self.depth_estimate - depth))
        parts_out: list[Part] = []
        count = 0
        for p, s in zip(self.parts, sel, strict=True):
            if not len(s):
                continue
            enu, faces, uvs, cols = compact(p, s)
            if not leaf:
                # Texture coordinates merge within a chart (a cell's worth of UV) but never across
                # a seam, where the same place jumps to another part of the atlas.
                uv_cell = max(2.0 * cell * p.uv_per_m, 1.0 / tex_px)
                enu, faces, uvs, cols = cluster(enu, faces, uvs, cols, cell, lo, uv_cell)
            if not len(faces):
                continue
            count += len(faces)
            parts_out.append(self._part(p, enu, faces, uvs, cols, tex_px))
        content = None
        if parts_out:
            content = f"content/{key}.glb"
            centre = np.asarray(box[:3])
            glb = write_glb(
                [self._recentre(pt, centre) for pt in parts_out],
                enu_to_gltf(centre[None])[0],
            )
            atomic_write_bytes(self.out / content, glb)
        tile = Tile(key=key, box=box, error=0.0 if leaf else cell, content=content, count=count)
        if leaf:
            self.done += n
            if self.ctx is not None:
                self.ctx.progress(self.done / max(1, self.total), f"{self.done} of {self.total} triangles")
            return tile
        axes = split_axes(lo, hi)
        mid = (lo + hi) / 2
        codes = [child_code(c[s], axes, mid) for c, s in zip(self.centroids, sel, strict=True)]
        for code in range(1 << len(axes)):
            child_sel = [s[k == code] for s, k in zip(sel, codes, strict=True)]
            if sum(len(s) for s in child_sel):
                b_lo, b_hi = child_box(lo, hi, axes, mid, code)
                tile.children.append(self._node(f"{key}-{code}", b_lo, b_hi, child_sel, depth + 1, cell / 2))
        return tile

    def _part(
        self,
        p: SrcPart,
        enu: np.ndarray,
        faces: np.ndarray,
        uvs: np.ndarray | None,
        cols: np.ndarray | None,
        tex_px: int,
    ) -> Part:
        image = mime = None
        if p.image is not None and uvs is not None:
            image, mime, uvs = texture_for(p.image, uvs, tex_px)
        pos = enu_to_gltf(enu)
        return Part(
            positions=pos,  # absolute for now; recentred when written
            indices=faces.astype(np.uint32),
            normals=vertex_normals(pos, faces),
            uvs=uvs.astype(np.float32) if uvs is not None and image is not None else None,
            colors=cols,
            image=image,
            mime=mime or "image/jpeg",
            base_color=p.base_color,
        )

    @staticmethod
    def _recentre(part: Part, centre_enu: np.ndarray) -> Part:
        c = enu_to_gltf(centre_enu[None])[0]
        part.positions = (np.asarray(part.positions, dtype=np.float64) - c).astype(np.float32)
        return part


# ---------------------------------------------------------------- pipeline


class TilesMesh:
    name = "tiles.mesh"
    title = "Mesh to 3D Tiles"
    description = "A large mesh to a 3D Tiles tileset for the site view and the Globe."

    def validate(self, params: dict[str, Any]) -> dict[str, Any]:
        known_keys(params, KEYS, self.name)
        if (params.get("layer") is None) == (params.get("src") is None):
            raise JobError("Give a mesh layer or a mesh file, not both.")
        text(params, "layer")
        text(params, "src")
        text(params, "name")
        text(params, "run")
        tid = params.get("id")
        if tid is not None and not is_tileset_id(tid):
            raise JobError("id must be letters, digits, dot, dash or underscore.")
        if params.get("compression", "none") not in COMPRESSION:
            raise JobError(f"compression must be one of: {', '.join(sorted(COMPRESSION))}.")
        number(params, "maxTrianglesPerTile", None, lo=1000, hi=5_000_000, integer=True)
        number(params, "textureMaxPx", None, lo=64, hi=16_384, integer=True)
        return dict(params)

    def inputs(self, params: dict[str, Any]) -> list[str]:
        return [params["src"]] if params.get("src") else []

    def plan(self, params: dict[str, Any]) -> list[Step]:
        def read(ctx: StepContext) -> dict[str, Any]:
            from ..change.derived import find_layer, layer_file, read_manifest

            m = read_manifest(ctx.project)
            if params.get("layer"):
                layer = find_layer(m, params["layer"], "mesh", "mesh layer")
                path = layer_file(ctx.project, layer)
                default_id, default_name = layer["id"], layer.get("name") or layer["id"]
                transform = layer.get("transform")
                capture = layer.get("capture")
            else:
                path = safe_project_path(ctx.project, params["src"])
                if not path.is_file():
                    raise JobError(f'The mesh file "{params["src"]}" does not exist.')
                default_id, default_name = path.stem, path.stem
                transform = capture = None
            tid = params.get("id") or safe_tileset_id(f"{default_id}-tiles")
            return {
                "path": str(path),
                "id": tid,
                "name": params.get("name") or default_name,
                "transform": transform,
                "capture": capture,
            }

        def tile(ctx: StepContext) -> dict[str, Any]:
            from ..change.derived import read_manifest

            info = ctx.outputs("read")
            if params.get("compression") in ("meshopt", "draco"):
                ctx.log(
                    f"{params['compression']} compression is not in this pipeline pack yet; the tiles are written uncompressed.",
                    "warn",
                )
            m = read_manifest(ctx.project)
            frame = SiteFrame.of(m)
            t0 = time.monotonic()
            parts = load_parts(Path(info["path"]), info["transform"], frame)
            max_tri = int(params.get("maxTrianglesPerTile", DEFAULT_MAX_TRIANGLES))
            opts = TreeOptions(
                max_triangles=max_tri,
                texture_px=int(params.get("textureMaxPx", DEFAULT_TEXTURE_PX)),
                grid=max(8, int(math.sqrt(max_tri / 2))),
            )
            out = ctx.stage(f"tiles/{info['id']}/tileset.json").parent
            root = MeshTiler(parts, opts, out, ctx).run()
            ts = tileset_json(
                root,
                transform=frame.root_transform(),
                refine="REPLACE",
                generator=GENERATOR,
                extras=frame.extras(m),
            )
            atomic_write_json(out / "tileset.json", ts)
            tiles = root.walk()
            ctx.log(
                f"{len(tiles)} tiles, {root.count} triangles at the root, in {time.monotonic() - t0:.1f} s"
            )
            return {"tiles": len(tiles), "triangles": sum(len(p.faces) for p in parts)}

        def commit(ctx: StepContext) -> dict[str, Any]:
            from ..runtime import commit_tree

            info = ctx.outputs("read")
            rel = f"tiles/{info['id']}"
            replace_folder(ctx.project, rel)
            commit_tree(ctx, rel, rel)
            entry: dict[str, Any] = {
                "id": info["id"],
                "name": info["name"],
                "kind": "mesh",
                "src": f"{rel}/tileset.json",
                "visible": True,
            }
            if params.get("layer"):
                entry["from"] = params["layer"]
            if params.get("run"):
                entry["run"] = params["run"]
            if info.get("capture"):
                entry["capture"] = info["capture"]
            upsert_tileset(ctx.project, entry)
            ctx.artifact("tilesets.json")
            return {"tileset": entry["id"], "entry": entry, **ctx.outputs("tile")}

        return [
            Step("read", "Find the mesh", read, 0.02),
            Step("tile", "Make the tiles", tile, 0.93),
            Step("commit", "Add the tileset", commit, 0.05),
        ]
