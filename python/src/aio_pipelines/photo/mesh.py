"""Meshes: screened Poisson from the dense cloud, or a 2.5D surface from the DSM.

Engines, in order (``report/products.json`` names the one that ran):

1. **``meshlab-poisson``**: Kazhdan's screened Poisson reconstruction as MeshLab ships it
   (``pymeshlab``, the PyPI wheel; GPL-3.0, accepted for the pack on 8 Oct 2026). The oriented
   dense cloud goes in as a binary PLY in the run's local frame (metres from the project origin, so
   float32 keeps millimetres); a child Python runs the reconstruction (``poisson_meshlab``: a native
   crash or a cancel never takes the pipeline down, and a failed attempt runs again
   single-threaded), and the mesh is trimmed by the reconstruction's own sampling density, as
   SurfaceTrimmer does. **``poissonrecon``**: the same reconstruction with the ``PoissonRecon`` and
   ``SurfaceTrimmer`` tools of github.com/mkazhdan/PoissonRecon, when ``AIO_POISSONRECON`` names
   them (or they are on the PATH and pymeshlab is not installed); each of the two stands in for the
   other when it fails, and when both fail the mesh falls back to (3).
2. **``grid-25d``**: for nadir surveys (most photos within 20 degrees of straight down) and the
   Fast preset, two triangles per DSM cell (cells without height are left open). Exact on the
   ground, no overhangs.
3. **``poisson-fft``**: our own Poisson reconstruction on a regular grid (Kazhdan 2005's FFT form):
   normals splatted into a vector field, its divergence solved with the FFT, the indicator's
   level set at the samples extracted with marching cubes (scikit-image, BSD-3) and trimmed where
   no samples are near. Coarser than (1): the grid fits the memory budget. Used for oblique and
   close-range runs when no screened Poisson engine is installed or it failed.

The site-view GLB is decimated to ``meshTriangles`` by vertex clustering; the full mesh is kept
for ``tiles.mesh``. GLB vertices are in the project's local frame (x east, y up, z south from the
manifest origin, data-conventions section 1) and the layer's ``transform`` is the identity.

The pack's pymeshlab is a PyPI wheel (``python/pyproject.toml``); no PoissonRecon build ships
since the decision of 8 Oct 2026 (``AIO_POISSONRECON`` still points a run at a local build).
"""

from __future__ import annotations

import importlib.util
import math
import os
import sys
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from ..runtime import JobError, StepContext, replace_over
from . import native
from .surface import GridSpec, read_grid


@dataclass
class Mesh:
    """Vertices in the run's local ENU frame (metres from the project origin: E, N, H)."""

    vertices: np.ndarray  # (n, 3) float64
    faces: np.ndarray  # (m, 3) int64
    colours: np.ndarray | None = None  # (n, 3) uint8

    @property
    def triangles(self) -> int:
        return len(self.faces)


# ------------------------------------------------------------------------------------- 2.5D


def mesh_25d(dsm_path: Path, spec: GridSpec, origin: np.ndarray, max_triangles: int) -> Mesh:
    """Two triangles per cell of the DSM, coarsened until the triangle budget holds."""
    f = max(1, math.ceil(math.sqrt(2 * spec.width * spec.height / max(1, max_triangles))))
    while True:
        h, w = math.ceil(spec.height / f), math.ceil(spec.width / f)
        if 2 * (h - 1) * (w - 1) <= max_triangles or f > 4096:
            break
        f += 1
    z = read_grid(dsm_path, (h, w) if f > 1 else None)
    h, w = z.shape
    res_x, res_y = spec.width * spec.res / w, spec.height * spec.res / h
    xs = spec.x0 + (np.arange(w) + 0.5) * res_x - origin[0]
    ys = spec.y1 - (np.arange(h) + 0.5) * res_y - origin[1]
    gx, gy = np.meshgrid(xs, ys)
    verts = np.column_stack([gx.ravel(), gy.ravel(), (z - origin[2]).ravel()])
    idx = np.arange(h * w).reshape(h, w)
    a, b, c, d = idx[:-1, :-1], idx[:-1, 1:], idx[1:, :-1], idx[1:, 1:]
    ok = np.isfinite(z)
    # rows go south: (a, c, b) is counter-clockwise seen from above
    t1 = np.stack([a, c, b], -1)[ok[:-1, :-1] & ok[1:, :-1] & ok[:-1, 1:]]
    t2 = np.stack([b, c, d], -1)[ok[:-1, 1:] & ok[1:, :-1] & ok[1:, 1:]]
    faces = np.concatenate([t1, t2]).reshape(-1, 3)
    return compact(Mesh(verts, faces))


def compact(mesh: Mesh) -> Mesh:
    """Drop vertices no face uses (and faces with a vertex that is not finite)."""
    if not len(mesh.faces):
        return Mesh(np.zeros((0, 3)), np.zeros((0, 3), np.int64))
    good = np.isfinite(mesh.vertices).all(1)
    faces = mesh.faces[good[mesh.faces].all(1)]
    used = np.unique(faces)
    remap = np.full(len(mesh.vertices), -1, np.int64)
    remap[used] = np.arange(len(used))
    cols = mesh.colours[used] if mesh.colours is not None else None
    return Mesh(mesh.vertices[used], remap[faces], cols)


# ------------------------------------------------------------------------------- decimation


def cluster(mesh: Mesh, max_triangles: int) -> Mesh:
    """Vertex clustering: merge vertices per cube until at most ``max_triangles`` remain."""
    if mesh.triangles <= max_triangles:
        return mesh
    lo, hi = mesh.vertices.min(0), mesh.vertices.max(0)
    area = float(np.sum(np.linalg.norm(np.cross(*_edges(mesh)), axis=1)) / 2)
    cell = math.sqrt(2 * area / max(1, max_triangles))
    for _ in range(40):
        q = np.floor((mesh.vertices - lo) / cell).astype(np.int64)
        span = (np.floor((hi - lo) / cell).astype(np.int64)) + 1
        key = (q[:, 0] * span[1] + q[:, 1]) * span[2] + q[:, 2]
        _, inv, cnt = np.unique(key, return_inverse=True, return_counts=True)
        n = len(cnt)
        verts = (
            np.stack([np.bincount(inv, weights=mesh.vertices[:, k], minlength=n) for k in range(3)], 1)
            / cnt[:, None]
        )
        faces = inv[mesh.faces]
        faces = faces[
            (faces[:, 0] != faces[:, 1]) & (faces[:, 1] != faces[:, 2]) & (faces[:, 0] != faces[:, 2])
        ]
        # one face per vertex triple, keeping its winding
        _, first = np.unique(np.sort(faces, axis=1), axis=0, return_index=True)
        faces = faces[np.sort(first)]
        if len(faces) <= max_triangles:
            cols = None
            if mesh.colours is not None:
                cols = (
                    np.stack(
                        [
                            np.bincount(inv, weights=mesh.colours[:, k].astype(float), minlength=n)
                            for k in range(3)
                        ],
                        1,
                    )
                    / cnt[:, None]
                )
                cols = np.clip(np.round(cols), 0, 255).astype(np.uint8)
            return compact(Mesh(verts, faces, cols))
        cell *= 1.25
    raise JobError("The mesh could not be reduced to the triangle budget.")


def _edges(mesh: Mesh) -> tuple[np.ndarray, np.ndarray]:
    v = mesh.vertices[mesh.faces]
    return v[:, 1] - v[:, 0], v[:, 2] - v[:, 0]


# ------------------------------------------------------------------------- Poisson (own FFT)


def poisson_fft(
    pts: np.ndarray,
    normals: np.ndarray,
    budget: int,
    max_n: int = 384,
    trim_cells: float = 2.0,
    check: Callable[[], None] = lambda: None,
) -> Mesh:
    """Poisson surface of oriented points on a regular grid (``pts`` in the local frame)."""
    from scipy import fft, ndimage
    from skimage import measure

    if len(pts) < 100:
        raise JobError("Too few dense points for a mesh.")
    lo, hi = pts.min(0), pts.max(0)
    span = float((hi - lo).max())
    # complex FFT of float64 (16 B) plus the field (3 x 8 B) and temporaries: about 64 B per cell
    n = int(min(max_n, max(32, (budget / 64) ** (1 / 3))))
    n -= n % 2
    pad = span * 0.1
    cell = (span + 2 * pad) / (n - 1)
    base = lo - pad - (n * cell - (hi - lo + 2 * pad)) / 2
    g = (pts - base) / cell
    i0 = np.floor(g).astype(np.int64)
    fr = g - i0
    field = np.zeros((3, n, n, n))
    dens = np.zeros((n, n, n))
    for dx in (0, 1):
        for dy in (0, 1):
            for dz in (0, 1):
                w = (
                    (fr[:, 0] if dx else 1 - fr[:, 0])
                    * (fr[:, 1] if dy else 1 - fr[:, 1])
                    * (fr[:, 2] if dz else 1 - fr[:, 2])
                )
                ix = np.clip(i0 + np.array([dx, dy, dz]), 0, n - 1)
                lin = np.ravel_multi_index((ix[:, 0], ix[:, 1], ix[:, 2]), (n, n, n))
                for k in range(3):
                    np.add.at(field[k].reshape(-1), lin, w * normals[:, k])
                np.add.at(dens.reshape(-1), lin, w)
    check()
    for k in range(3):
        field[k] = ndimage.gaussian_filter(field[k], 1.0)
    div = np.gradient(field[0], axis=0) + np.gradient(field[1], axis=1) + np.gradient(field[2], axis=2)
    del field
    check()
    k1 = 2 * np.cos(2 * np.pi * np.fft.fftfreq(n)) - 2
    lap = k1[:, None, None] + k1[None, :, None] + k1[None, None, :]
    lap[0, 0, 0] = 1.0
    chi_hat = fft.fftn(div) / lap
    chi_hat[0, 0, 0] = 0
    chi = np.real(fft.ifftn(chi_hat))
    del chi_hat, div
    check()
    iso = float(np.mean(ndimage.map_coordinates(chi, g.T, order=1, mode="nearest")))
    verts, faces, _, _ = measure.marching_cubes(chi, level=iso)
    # trim: keep faces near samples
    near = ndimage.gaussian_filter(dens, 1.0) > 0
    near = ndimage.binary_dilation(near, iterations=max(1, round(trim_cells)))
    vi = np.clip(np.round(verts).astype(np.int64), 0, n - 1)
    keep_v = near[vi[:, 0], vi[:, 1], vi[:, 2]]
    faces = faces[keep_v[faces].all(1)]
    world = verts * cell + base
    mesh = compact(Mesh(world, faces.astype(np.int64)))
    # face normals point the same way as the samples' normals
    if mesh.triangles:
        e1, e2 = _edges(mesh)
        fn = np.cross(e1, e2)
        cen = mesh.vertices[mesh.faces].mean(1)
        from scipy.spatial import cKDTree

        _, nn = cKDTree(pts).query(cen, k=1)
        if np.mean(np.sum(fn * normals[nn], axis=1)) < 0:
            mesh = Mesh(mesh.vertices, mesh.faces[:, ::-1].copy(), mesh.colours)
    return mesh


# ---------------------------------------------------------------------------- PoissonRecon tool


def write_ply_points(
    path: Path, pts: np.ndarray, normals: np.ndarray, colours: np.ndarray | None = None
) -> None:
    header = [
        "ply",
        "format binary_little_endian 1.0",
        f"element vertex {len(pts)}",
        "property float x",
        "property float y",
        "property float z",
        "property float nx",
        "property float ny",
        "property float nz",
    ]
    if colours is not None:
        header += ["property uchar red", "property uchar green", "property uchar blue"]
    header.append("end_header")
    dt = [("p", "<f4", 3), ("n", "<f4", 3)] + ([("c", "u1", 3)] if colours is not None else [])
    rec = np.zeros(len(pts), dtype=dt)
    rec["p"], rec["n"] = pts, normals
    if colours is not None:
        rec["c"] = colours
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "wb") as f:
        f.write(("\n".join(header) + "\n").encode("ascii"))
        f.write(rec.tobytes())


def write_ply_chunks(path: Path, chunks, count: int) -> int:
    """Oriented, coloured points as a binary PLY, chunk by chunk (``(pts, normals, colours)``);
    ``count`` must be the total, as the header comes first. Returns the points written."""
    header = [
        "ply",
        "format binary_little_endian 1.0",
        f"element vertex {count}",
        *(f"property float {a}" for a in ("x", "y", "z", "nx", "ny", "nz")),
        *(f"property uchar {c}" for c in ("red", "green", "blue")),
        "end_header",
    ]
    dt = np.dtype([("p", "<f4", 3), ("n", "<f4", 3), ("c", "u1", 3)])
    written = 0
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "wb") as f:
        f.write(("\n".join(header) + "\n").encode("ascii"))
        for pts, nrm, cols in chunks:
            take = min(len(pts), count - written)
            rec = np.zeros(take, dt)
            rec["p"], rec["n"], rec["c"] = pts[:take], nrm[:take], cols[:take]
            f.write(rec.tobytes())
            written += take
    if written != count:
        raise JobError(f"The dense cloud changed while it was written ({written} of {count} points).")
    return written


_PLY_TYPES = {
    "char": "i1", "int8": "i1", "uchar": "u1", "uint8": "u1", "short": "<i2", "int16": "<i2",
    "ushort": "<u2", "uint16": "<u2", "int": "<i4", "int32": "<i4", "uint": "<u4", "uint32": "<u4",
    "float": "<f4", "float32": "<f4", "double": "<f8", "float64": "<f8",
}  # fmt: skip


def read_ply_mesh(path: Path) -> Mesh:
    """A binary little-endian or ASCII PLY mesh with float vertices and triangle faces (our own
    reader: plyfile is GPL-3.0)."""
    data = path.read_bytes()
    end = data.index(b"end_header") + len(b"end_header")
    end += 2 if data[end : end + 2] == b"\r\n" else 1
    lines = data[:end].decode("ascii", errors="replace").splitlines()
    fmt = next((ln.split()[1] for ln in lines if ln.startswith("format")), "")
    elements: list[tuple[str, int, list[tuple[str, ...]]]] = []
    for ln in lines:
        p = ln.split()
        if p[:1] == ["element"]:
            elements.append((p[1], int(p[2]), []))
        elif p[:1] == ["property"] and elements:
            elements[-1][2].append(tuple(p[1:]))
    verts = np.zeros((0, 3))
    faces = np.zeros((0, 3), np.int64)
    colours = None
    if fmt == "ascii":
        body = data[end:].decode("ascii").split("\n")
        row = 0
        for name, count, props in elements:
            rows = [body[row + i].split() for i in range(count)]
            row += count
            if name == "vertex":
                names = [p[-1] for p in props]
                arr = np.array(rows, dtype=np.float64).reshape(count, len(names))
                verts = arr[:, [names.index(a) for a in ("x", "y", "z")]]
            elif name == "face":
                faces = np.array(
                    [[int(v) for v in r[1:4]] for r in rows if int(r[0]) == 3], np.int64
                ).reshape(-1, 3)
        return Mesh(verts, faces)
    if fmt != "binary_little_endian":
        raise JobError(f"The mesh {path.name} is a {fmt} PLY; expected binary little endian or ASCII.")
    off = end
    for name, count, props in elements:
        if props and props[0][0] == "list":
            _, ct, it, _pname = props[0]
            if len(props) != 1:
                raise JobError(f"The mesh {path.name} has face properties this reader does not know.")
            cdt, idt = np.dtype(_PLY_TYPES[ct]), np.dtype(_PLY_TYPES[it])
            if name == "face":
                rec = np.dtype([("n", cdt), ("v", idt, 3)])
                arr = np.frombuffer(data, rec, count, off)
                if count and not (arr["n"] == 3).all():
                    raise JobError(f"The mesh {path.name} has faces that are not triangles.")
                faces = arr["v"].astype(np.int64)
                off += rec.itemsize * count
            continue
        dt = np.dtype([(p[1], _PLY_TYPES[p[0]]) for p in props])
        arr = np.frombuffer(data, dt, count, off)
        off += dt.itemsize * count
        if name == "vertex":
            verts = np.column_stack([arr["x"], arr["y"], arr["z"]]).astype(np.float64)
            if {"red", "green", "blue"} <= set(arr.dtype.names or ()):
                colours = np.column_stack([arr["red"], arr["green"], arr["blue"]]).astype(np.uint8)
    return Mesh(verts, faces, colours)


def poisson_tool(
    ctx: StepContext,
    work: Path,
    pts: np.ndarray,
    normals: np.ndarray,
    depth: int,
    colours: np.ndarray | None = None,
    src: Path | None = None,
    count: int | None = None,
) -> Mesh:
    """Screened Poisson with the native tools; ``pts`` in the local frame. With ``src`` (a PLY
    already written, ``write_ply_chunks``, of ``count`` points) ``pts`` is only a sample of the
    cloud, used when the mesh has to be trimmed without SurfaceTrimmer."""
    exe = native.find_tool("PoissonRecon")
    if exe is None:
        raise JobError("PoissonRecon is not in this pipeline pack.")
    raw, out = work / "poisson.ply", work / "poisson-trimmed.ply"
    if src is None:
        src = work / "dense.ply"
        write_ply_points(src, pts, normals, colours)
    n = count or len(pts)
    args = [
        exe,
        "--in",
        str(src),
        "--out",
        str(raw),
        "--depth",
        str(depth),
        "--density",
        "--samplesPerNode",
        "1.5",
    ]
    if colours is not None:
        args.append("--colors")
    native.run_tool(ctx, args, "Poisson meshing", work, expected_s=max(30.0, n / 2e5), progress=(0.0, 0.8))
    trimmer = native.find_tool("SurfaceTrimmer")
    if trimmer is not None:
        native.run_tool(
            ctx,
            [trimmer, "--in", str(raw), "--out", str(out), "--trim", "7"],
            "Trimming the mesh",
            work,
            20.0,
            (0.8, 0.95),
        )
        return read_ply_mesh(out)
    ctx.log(
        "SurfaceTrimmer is not in this pipeline pack; the mesh is trimmed by distance to the points.", "warn"
    )
    m = read_ply_mesh(raw)
    from scipy.spatial import cKDTree

    dist, _ = cKDTree(pts).query(m.vertices, k=1)
    spacing = float(np.median(cKDTree(pts).query(pts[:: max(1, len(pts) // 5000)], k=2)[0][:, 1]))
    keep = dist <= 4 * max(spacing, 1e-6)
    return compact(Mesh(m.vertices, m.faces[keep[m.faces].all(1)], m.colours))


# --------------------------------------------------------------------- MeshLab screened Poisson

#: ``AIO_PYMESHLAB=0`` turns MeshLab's Poisson off (tests and engine comparisons).
MESHLAB_ENV = "AIO_PYMESHLAB"
#: Faces whose vertices' sampling density is below this are trimmed: SurfaceTrimmer's ``--trim 7``
#: on the same scale (the octree depth the samples support; MeshLab keeps it as vertex quality),
#: and never more than four levels below the reconstruction's depth (shallow test runs).
DENSITY_TRIM = 7.0
#: Bytes MeshLab holds per input point while it reconstructs (its vertex record and the octree),
#: measured on the synthetic sets with margin; the cloud is thinned to fit the memory budget.
MESHLAB_BYTES_PER_POINT = 400
#: Peak bytes of a screened Poisson reconstruction per vertex of its mesh (MeshLab's octree and
#: solver). Measured on G8's mini set (1.5 M points, 230 m): 1.2 GB for 143 k vertices at depth 9,
#: 20 GB for 2.5 M at depth 11; with margin.
POISSON_BYTES_PER_VERTEX = 10_000


def meshlab_available() -> bool:
    """True when pymeshlab is installed (looked up, not imported: it loads Qt)."""
    if os.environ.get(MESHLAB_ENV) == "0":
        return False
    return importlib.util.find_spec("pymeshlab") is not None


def poisson_engine() -> str | None:
    """The screened Poisson engine here: ``poissonrecon`` when ``AIO_POISSONRECON`` names the tool
    (an explicit override), else ``meshlab`` when pymeshlab is installed (the pack's engine), else
    ``poissonrecon`` when the pack's ``tools/`` or the PATH has the tool, else None."""
    if os.environ.get("AIO_POISSONRECON") and native.find_tool("PoissonRecon"):
        return "poissonrecon"
    if meshlab_available():
        return "meshlab"
    return "poissonrecon" if native.find_tool("PoissonRecon") else None


def poisson_depth(
    pts: np.ndarray, max_depth: int, memory_budget: int, spacing: float | None = None
) -> tuple[int, str]:
    """The octree depth for a screened Poisson reconstruction of ``pts`` (a sample of the cloud),
    and why: at most ``max_depth``; no finer than the cloud's ``spacing`` (cells smaller than the
    points' spacing add memory, not detail); and small enough that the mesh's estimated memory
    (``POISSON_BYTES_PER_VERTEX`` times the surface's cells, the surface measured as the cells the
    sample occupies at a coarse depth) fits ``memory_budget``. Depth 11 on G8's mini set needed
    20 GB, which put the 7 GB and 16 GB CI runners into swap for half an hour."""
    if len(pts) < 10:
        return max(6, min(max_depth, 8)), "few points"
    lo, hi = pts.min(0), pts.max(0)
    size = float((hi - lo).max()) * 1.1  # MeshLab's bounding cube (scale 1.1)
    if size <= 0:
        return max(6, min(max_depth, 8)), "no extent"
    coarse = 7
    cell7 = size / 2**coarse
    area = len(np.unique(np.floor((pts - lo) / cell7).astype(np.int64), axis=0)) * cell7**2
    depth, why = max_depth, "preset"
    if spacing and spacing > 0:
        fit = math.floor(math.log2(size / spacing))
        if fit < depth:
            depth, why = fit, f"point spacing {spacing:.3f} m"
    while depth > 6 and area / (size / 2**depth) ** 2 * POISSON_BYTES_PER_VERTEX > memory_budget:
        depth, why = depth - 1, f"memory budget {memory_budget / 1e9:.1f} GB"
    return max(6, depth), why


def read_ply_points(path: Path, max_points: int = 0) -> tuple[np.ndarray, np.ndarray]:
    """Points and normals of a binary little-endian PLY (``write_ply_chunks``), every n-th point
    when it has more than ``max_points`` (0: all)."""
    with open(path, "rb") as f:
        head = f.read(65536)
    end = head.index(b"end_header") + len(b"end_header")
    end += 2 if head[end : end + 2] == b"\r\n" else 1
    lines = head[:end].decode("ascii", errors="replace").splitlines()
    if not any(ln.split()[:2] == ["format", "binary_little_endian"] for ln in lines):
        raise JobError(f"The cloud {path.name} is not a binary little-endian PLY.")
    count, props, inside = 0, [], False
    for ln in lines:
        p = ln.split()
        if p[:1] == ["element"]:
            inside = p[1] == "vertex"
            if inside:
                count = int(p[2])
            elif count:
                break
        elif p[:1] == ["property"] and inside:
            props.append((p[2], _PLY_TYPES[p[1]]))
    dt = np.dtype(props)
    arr = np.memmap(path, dt, "r", end, (count,))
    step = max(1, math.ceil(count / max_points)) if max_points else 1
    arr = arr[::step]
    pts = np.column_stack([arr["x"], arr["y"], arr["z"]]).astype(np.float64)
    nrm = np.column_stack([arr["nx"], arr["ny"], arr["nz"]]).astype(np.float64)
    del arr
    return pts, nrm


def _meshlab_child(src: str, out: str, depth: int, threads: int, max_points: int) -> None:
    """In the child Python: the oriented cloud of ``src`` through MeshLab's screened Poisson, the
    mesh with its per-vertex density to ``out`` (npz)."""
    import pymeshlab

    pts, nrm = read_ply_points(Path(src), max_points)
    ms = pymeshlab.MeshSet()
    ms.add_mesh(pymeshlab.Mesh(vertex_matrix=pts, v_normals_matrix=nrm))
    del pts, nrm
    kw: dict = {"depth": depth, "samplespernode": 1.5, "pointweight": 4.0, "preclean": False}
    if threads > 0:
        kw["threads"] = threads
    ms.generate_surface_reconstruction_screened_poisson(**kw)
    m = ms.current_mesh()
    tmp = Path(out).with_name(Path(out).stem + ".tmp.npz")
    np.savez(
        tmp,
        vertices=m.vertex_matrix().astype(np.float64),
        faces=m.face_matrix().astype(np.int64),
        density=m.vertex_scalar_array().astype(np.float64),
    )
    replace_over(tmp, out)


#: Variables that make the loader put extra libraries into a process. MeshLab's child drops them:
#: an OpenMP runtime preloaded there would meet the libomp the pymeshlab wheel bundles, and two
#: initialised copies abort the process on macOS ("OMP: Error #15").
MESHLAB_DROPPED_ENV = ("DYLD_INSERT_LIBRARIES", "DYLD_LIBRARY_PATH", "LD_PRELOAD")


def meshlab_command(src: Path, out: Path, depth: int, threads: int, max_points: int) -> list[str]:
    """The child Python that runs MeshLab's Poisson (``_meshlab_child``). MeshLab always runs in a
    process of its own: pymeshlab and pycolmap each bundle libomp, and two copies in one process
    abort on macOS. The child is isolated (``-I``) like the app's pipeline process, so no user
    site-packages, ``.pth`` file or ``PYTHONPATH`` can import another native library into it."""
    isolated = ["-I"] if sys.flags.isolated else []
    return [
        sys.executable,
        *isolated,
        "-m",
        "aio_pipelines.photo.mesh",
        "meshlab-poisson",
        str(src),
        str(out),
        str(depth),
        str(threads),
        str(max_points),
    ]


def meshlab_env(threads: int) -> dict[str, str]:
    """The environment of MeshLab's child: this process's, without ``MESHLAB_DROPPED_ENV``, with
    OpenMP held to ``threads`` and OpenBLAS to one thread."""
    env = {k: v for k, v in os.environ.items() if k.upper() not in MESHLAB_DROPPED_ENV}
    env["OMP_NUM_THREADS"] = str(threads)
    env["OPENBLAS_NUM_THREADS"] = "1"
    return env


def poisson_meshlab(
    ctx: StepContext,
    work: Path,
    src: Path,
    depth: int,
    count: int,
    memory_budget: int,
    attempts: int = 2,
) -> Mesh:
    """Screened Poisson with MeshLab (pymeshlab) in a child Python, so a native crash or a cancel
    never takes the pipeline down; trimmed by density as SurfaceTrimmer does. The child runs with
    ``native.tool_threads`` threads and is stopped above ``memory_budget``; a run stopped for memory
    is tried again one octree level coarser, any other failure single-threaded (the reconstruction
    has crashed nondeterministically before)."""
    work.mkdir(parents=True, exist_ok=True)
    out = work / "meshlab-poisson.npz"
    max_points = max(100_000, memory_budget // MESHLAB_BYTES_PER_POINT)
    if count > max_points:
        ctx.log(f"MeshLab meshes {max_points:,} of the {count:,} dense points (memory budget).")
    last: JobError | None = None
    threads = native.tool_threads()
    for attempt in range(attempts):
        if attempt > 0 and not isinstance(last, native.ToolMemoryExceeded):
            threads = 1
        out.unlink(missing_ok=True)
        args = meshlab_command(src, out, depth, threads, max_points)
        env = meshlab_env(threads)
        try:
            native.run_tool(
                ctx,
                args,
                "Poisson meshing",
                work,
                expected_s=max(30.0, count / 2e5),
                progress=(0.0, 0.9),
                memory_limit=memory_budget,
                env=env,
            )
        except JobError as e:
            last = e
            if isinstance(e, native.ToolMemoryExceeded) and depth > 6:
                depth -= 1  # the next attempt one octree level coarser
            ctx.log(f"MeshLab's Poisson stopped ({e}); attempt {attempt + 2} of {attempts}.", "warn")
            continue
        if not out.is_file():
            last = JobError("MeshLab's Poisson finished without a mesh.")
            continue
        with np.load(out) as z:
            verts, faces, density = z["vertices"], z["faces"], z["density"]
        keep = density >= min(DENSITY_TRIM, depth - 4.0)
        mesh = compact(Mesh(verts, faces[keep[faces].all(1)]))
        if mesh.triangles:
            return mesh
        last = JobError("MeshLab's Poisson made an empty mesh.")
    raise last or JobError("MeshLab's Poisson did not run.")


def poisson_mesh(
    ctx: StepContext,
    work: Path,
    pts: np.ndarray,
    normals: np.ndarray,
    depth: int,
    src: Path,
    count: int,
    memory_budget: int,
    spacing: float | None = None,
) -> tuple[Mesh, str]:
    """Screened Poisson of the cloud in ``src`` (``count`` points; ``pts`` and ``normals`` a sample
    of it) with the engine of ``poisson_engine``, then the other one when that one fails, at most
    at ``depth`` (``poisson_depth`` lowers it for the cloud's spacing and the memory budget).
    Returns the mesh and the engine that made it; raises ``JobError`` when none could."""
    depth, why = poisson_depth(pts, depth, memory_budget, spacing)
    ctx.log(f"Screened Poisson at octree depth {depth} ({why}).")
    engine = poisson_engine()
    order = [engine] + [e for e in ("meshlab", "poissonrecon") if e != engine]
    errors: list[str] = []
    for name in order:
        if name == "meshlab" and meshlab_available():
            try:
                return poisson_meshlab(ctx, work, src, depth, count, memory_budget), "meshlab-poisson"
            except JobError as e:
                errors.append(f"MeshLab: {e}")
        elif name == "poissonrecon" and native.find_tool("PoissonRecon"):
            try:
                return poisson_tool(ctx, work, pts, normals, depth, None, src, count), "poissonrecon"
            except JobError as e:
                errors.append(f"PoissonRecon: {e}")
    raise JobError("; ".join(errors) or "No screened Poisson engine in this pipeline pack.")


# -------------------------------------------------------------------------------------- frames


def enu_to_local(v: np.ndarray) -> np.ndarray:
    """Run-local ENU (metres from the origin: E, N, H) to the scene frame (x east, y up, z south)."""
    return np.column_stack([v[:, 0], v[:, 2], -v[:, 1]])


def face_normals(vertices: np.ndarray, faces: np.ndarray) -> np.ndarray:
    v = vertices[faces]
    n = np.cross(v[:, 1] - v[:, 0], v[:, 2] - v[:, 0])
    return n / np.maximum(np.linalg.norm(n, axis=1, keepdims=True), 1e-12)


def vertex_normals(vertices: np.ndarray, faces: np.ndarray) -> np.ndarray:
    v = vertices[faces]
    n = np.cross(v[:, 1] - v[:, 0], v[:, 2] - v[:, 0])
    out = np.zeros_like(vertices)
    for k in range(3):
        np.add.at(out, faces[:, k], n)
    ln = np.linalg.norm(out, axis=1, keepdims=True)
    return np.where(ln > 1e-12, out / np.maximum(ln, 1e-12), [0.0, 0.0, 1.0])


def nadir_share(views, limit_deg: float = 20.0) -> float:
    """Fraction of photos looking within ``limit_deg`` of straight down."""
    if not views:
        return 0.0
    down = np.array([0.0, 0.0, -1.0])
    ok = [math.degrees(math.acos(float(np.clip(np.dot(v.axis, down), -1, 1)))) <= limit_deg for v in views]
    return sum(ok) / len(ok)


def ply_header_count(path: Path) -> int:
    """Number of faces a PLY declares (for logs and tests)."""
    with open(path, "rb") as f:
        head = f.read(4096).split(b"end_header")[0].decode("ascii", errors="replace")
    for ln in head.splitlines():
        p = ln.split()
        if p[:2] == ["element", "face"]:
            return int(p[2])
    return 0


if __name__ == "__main__":
    # the child of ``poisson_meshlab``: meshlab-poisson <src.ply> <out.npz> <depth> <threads> <max points>
    if len(sys.argv) != 7 or sys.argv[1] != "meshlab-poisson":
        sys.exit("usage: python -m aio_pipelines.photo.mesh meshlab-poisson SRC OUT DEPTH THREADS MAXPOINTS")
    _meshlab_child(sys.argv[2], sys.argv[3], int(sys.argv[4]), int(sys.argv[5]), int(sys.argv[6]))
