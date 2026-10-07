"""Texturing: the mesh coloured from the photos, written as a GLB.

Engines (``report/products.json`` names the one that ran):

1. **``texrecon``** (mvs-texturing, BSD-3-Clause; view selection by mapMAP, BSD-3, never the
   research-only gco): Waechter, Moehrle and Goesele 2014. The photos are undistorted onto pinhole
   cameras and written as a "scene folder" (one image and one ``.cam`` file each, in the run's local
   frame so single precision keeps millimetres), the mesh as a binary PLY; ``texrecon`` returns an
   OBJ with its texture atlases, which we read (our own OBJ reader) into the GLB.
2. **``ortho-drape``**: for a 2.5D mesh, the orthomosaic itself is the texture (planar UVs from
   easting and northing): one atlas, no seams, the same colours as the ortho layer.
3. **``views``**: per face the photo that sees it most squarely (and is not hidden: a z-buffer of
   the mesh per photo), one texture per photo cropped to its faces; colours balanced with the
   ortho's gains when it has them.

**G1 build recipe (texrecon):** ODM's BSD-3 fork ``OpenDroneMap/mvs-texturing`` (Windows and macOS
builds) or upstream ``nmoehrle/mvs-texturing`` at a pinned commit; CMake with ``-DRESEARCH=OFF``
(the default; it keeps the research-only gco out), Eigen from vcpkg ``eigen3`` 3.4 with
``EIGEN_MPL2_ONLY`` instead of the 3.3.2 tarball ``elibs/CMakeLists.txt`` downloads, TBB (Apache-2.0),
libpng, libjpeg-turbo and libtiff from vcpkg (no libraw, no libheif), mapMAP at the pinned
``fa526e0`` and rayint (BSD-3) as fetched. Install ``texrecon(.exe)`` into
``<pack>/tools/texrecon/`` with its DLLs beside it; the native licence gate lists mvs-texturing,
mapMAP (with ``dset``, zlib-style), rayint, the MVE libraries (BSD-3) and TBB.
"""

from __future__ import annotations

import io
import json
import math
from collections.abc import Callable
from pathlib import Path

import numpy as np

from ..runtime import JobError, StepContext
from ..volumetric.terrain import encode_glb
from .mesh import Mesh, enu_to_local, face_normals, vertex_normals
from .native import find_tool, run_tool
from .scene import Camera, View, load_image

GENERATOR = "Stratlas photo.products"
JPEG_QUALITY = 88


def _jpeg(img: np.ndarray) -> bytes:
    from PIL import Image

    buf = io.BytesIO()
    Image.fromarray(img).convert("RGB").save(buf, "JPEG", quality=JPEG_QUALITY, optimize=True)
    return buf.getvalue()


def glb_bytes(parts: list[dict], images: list[bytes], name: str = "mesh") -> bytes:
    """GLB of primitives ``{positions (scene frame), indices, uvs?, texture?, color?}``."""
    materials, prims = [], []
    for i, p in enumerate(parts):
        mat: dict = {"name": f"{name}-{i}"}
        if p.get("texture") is not None:
            mat["texture"] = p["texture"]
        else:
            mat["color"] = p.get("color", [0.7, 0.7, 0.7, 1.0])
        materials.append(mat)
        pos = np.asarray(p["positions"], np.float64)
        prims.append(
            {
                "material": i,
                "positions": pos.astype(np.float32),
                "normals": vertex_normals(pos, p["indices"]).astype(np.float32),
                "uvs": None if p.get("uvs") is None else np.asarray(p["uvs"], np.float32),
                "indices": np.asarray(p["indices"], np.uint32).ravel(),
            }
        )
    return encode_glb(
        [{"name": name, "mesh": 0}],
        [0],
        [{"name": name, "primitives": prims}],
        materials,
        [("image/jpeg", b) for b in images],
        GENERATOR,
    )


# ----------------------------------------------------------------------------------- ortho drape


def drape_ortho(mesh: Mesh, origin: np.ndarray, ortho_tif: Path, max_px: int = 4096) -> bytes:
    """GLB of a 2.5D mesh with the orthomosaic as its texture."""
    import rasterio
    from rasterio.enums import Resampling

    with rasterio.open(ortho_tif) as ds:
        f = max(1.0, max(ds.width, ds.height) / max_px)
        h, w = max(1, round(ds.height / f)), max(1, round(ds.width / f))
        rgb = ds.read([1, 2, 3], out_shape=(3, h, w), resampling=Resampling.average)
        b = ds.bounds
    img = np.moveaxis(rgb, 0, -1)
    e = mesh.vertices[:, 0] + origin[0]
    n = mesh.vertices[:, 1] + origin[1]
    uv = np.column_stack([(e - b.left) / (b.right - b.left), (b.top - n) / (b.top - b.bottom)])
    part = {"positions": enu_to_local(mesh.vertices), "indices": mesh.faces, "uvs": uv, "texture": 0}
    return glb_bytes([part], [_jpeg(img)])


# --------------------------------------------------------------------------------- per photo


def _face_visibility(
    mesh: Mesh, view: View, cam: Camera, origin: np.ndarray
) -> tuple[np.ndarray, np.ndarray]:
    """Per face: whether ``view`` sees it unhidden, and the cosine of its viewing angle."""
    world = mesh.vertices + origin
    cen = world[mesh.faces].mean(1)
    x, y, z = view.project(cen, cam)
    inside = (z > 0) & (x >= 0) & (y >= 0) & (x < cam.width) & (y < cam.height)
    # z-buffer of the mesh in this photo at the buffer size (centroids and vertices splatted)
    depth = np.full(cam.width * cam.height, np.inf)
    allp = np.concatenate([cen, world])
    px, py, pz = view.project(allp, cam)
    ok = (pz > 0) & (px >= 0) & (py >= 0) & (px < cam.width) & (py < cam.height)
    idx = np.floor(py[ok]).astype(np.int64) * cam.width + np.floor(px[ok]).astype(np.int64)
    np.minimum.at(depth, idx, pz[ok])
    xi = np.clip(np.floor(x).astype(np.int64), 0, cam.width - 1)
    yi = np.clip(np.floor(y).astype(np.int64), 0, cam.height - 1)
    with np.errstate(invalid="ignore"):
        front = z <= depth[yi * cam.width + xi] * 1.01 + 0.05
    fn = face_normals(world, mesh.faces)
    to_cam = view.centre - cen
    cos = np.sum(fn * to_cam, 1) / np.maximum(np.linalg.norm(to_cam, axis=1), 1e-9)
    return inside & front & (cos > 0.05), cos


def texture_views(
    mesh: Mesh,
    views: list[View],
    origin: np.ndarray,
    gains: dict[int, np.ndarray] | None = None,
    max_px: int = 2048,
    image_scale: float = 1.0,
    check: Callable[[], None] = lambda: None,
) -> tuple[bytes, dict]:
    """GLB with one texture per photo; each face from the photo that sees it most squarely."""
    nf = len(mesh.faces)
    best = np.full(nf, -1, np.int64)
    score = np.full(nf, -np.inf)
    for k, v in enumerate(views):
        check()
        vis, cos = _face_visibility(mesh, v, v.camera.scaled(0.25), origin)
        s = np.where(vis, cos, -np.inf)
        better = s > score
        best[better], score[better] = k, s[better]
    parts: list[dict] = []
    images: list[bytes] = []
    world = mesh.vertices + origin
    for k in np.unique(best[best >= 0]):
        check()
        v = views[int(k)]
        faces = mesh.faces[best == k]
        cam = v.camera.scaled(image_scale) if image_scale != 1 else v.camera
        tri = world[faces].reshape(-1, 3)
        x, y, _ = v.project(tri, cam)
        x0, y0 = max(0, math.floor(x.min()) - 2), max(0, math.floor(y.min()) - 2)
        x1, y1 = min(cam.width, math.ceil(x.max()) + 2), min(cam.height, math.ceil(y.max()) + 2)
        img = load_image(v.path, image_scale)[y0:y1, x0:x1].astype(np.float64)
        if gains and v.id in gains:
            img = img * gains[v.id]
        f = max(1.0, max(img.shape[0], img.shape[1]) / max_px)
        if f > 1:
            from PIL import Image

            small = Image.fromarray(np.clip(img, 0, 255).astype(np.uint8)).resize(
                (max(1, round(img.shape[1] / f)), max(1, round(img.shape[0] / f))), Image.Resampling.LANCZOS
            )
            tex = np.asarray(small)
        else:
            tex = np.clip(np.round(img), 0, 255).astype(np.uint8)
        uv = np.column_stack([(x - x0) / max(1, x1 - x0), (y - y0) / max(1, y1 - y0)])
        local = enu_to_local(tri - origin)
        parts.append(
            {
                "positions": local,
                "indices": np.arange(len(tri)).reshape(-1, 3),
                "uvs": uv,
                "texture": len(images),
            }
        )
        images.append(_jpeg(tex))
    unseen = mesh.faces[best < 0]
    if len(unseen):
        tri = mesh.vertices[unseen].reshape(-1, 3)
        parts.append({"positions": enu_to_local(tri), "indices": np.arange(len(tri)).reshape(-1, 3)})
    if not parts:
        raise JobError("No photo sees the mesh; it cannot be textured.")
    return glb_bytes(parts, images), {"photos": len(images), "unseenFaces": len(unseen)}


# ------------------------------------------------------------------------------------- texrecon


def write_cam(path: Path, view: View, cam: Camera, origin: np.ndarray) -> None:
    """An mvs-texturing ``.cam`` file (world to camera in the run's local frame, pinhole)."""
    t = view.t + view.r @ origin
    r = view.r.ravel()
    f = cam.fx / max(cam.width, cam.height)
    lines = [
        " ".join(f"{v:.10g}" for v in (*t, *r)),
        f"{f:.10g} 0 0 {cam.fy / cam.fx:.10g} {cam.cx / cam.width:.10g} {cam.cy / cam.height:.10g}",
    ]
    path.write_text("\n".join(lines) + "\n", "ascii")


def undistort_image(img: np.ndarray, cam: Camera) -> np.ndarray:
    """The photo resampled onto the pinhole camera of the same intrinsics (no lens distortion)."""
    from scipy import ndimage

    if not cam.distorted:
        return img
    ys, xs = np.mgrid[0 : cam.height, 0 : cam.width].astype(np.float64)
    u, v = (xs + 0.5 - cam.cx) / cam.fx, (ys + 0.5 - cam.cy) / cam.fy
    du, dv = cam.distort(u, v)
    sx, sy = du * cam.fx + cam.cx - 0.5, dv * cam.fy + cam.cy - 0.5
    return np.stack(
        [
            ndimage.map_coordinates(img[..., c], [sy, sx], order=1, mode="nearest")
            for c in range(img.shape[2])
        ],
        -1,
    ).astype(np.uint8)


def write_ply_mesh(path: Path, mesh: Mesh) -> None:
    head = (
        "ply\nformat binary_little_endian 1.0\n"
        f"element vertex {len(mesh.vertices)}\nproperty float x\nproperty float y\nproperty float z\n"
        f"element face {len(mesh.faces)}\nproperty list uchar int vertex_indices\nend_header\n"
    )
    rec = np.zeros(len(mesh.faces), dtype=[("n", "u1"), ("v", "<i4", 3)])
    rec["n"], rec["v"] = 3, mesh.faces
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "wb") as f:
        f.write(head.encode("ascii"))
        f.write(mesh.vertices.astype("<f4").tobytes())
        f.write(rec.tobytes())


def read_obj(path: Path) -> tuple[list[dict], list[bytes]]:
    """An OBJ with ``usemtl`` groups and ``map_Kd`` textures as GLB parts (vertices as written)."""
    v: list[list[float]] = []
    vt: list[list[float]] = []
    groups: dict[str, list[list[tuple[int, int]]]] = {}
    current = "default"
    mtllib = None
    for line in path.read_text("utf-8", errors="replace").splitlines():
        p = line.split()
        if not p:
            continue
        if p[0] == "v":
            v.append([float(a) for a in p[1:4]])
        elif p[0] == "vt":
            vt.append([float(a) for a in p[1:3]])
        elif p[0] == "usemtl":
            current = p[1]
        elif p[0] == "mtllib":
            mtllib = " ".join(p[1:])
        elif p[0] == "f":
            corners = []
            for c in p[1:4]:
                ids = c.split("/")
                corners.append((int(ids[0]) - 1, int(ids[1]) - 1 if len(ids) > 1 and ids[1] else -1))
            groups.setdefault(current, []).append(corners)
    maps: dict[str, Path] = {}
    if mtllib:
        mat = None
        for line in (path.parent / mtllib).read_text("utf-8", errors="replace").splitlines():
            p = line.split()
            if p[:1] == ["newmtl"]:
                mat = p[1]
            elif p[:1] == ["map_Kd"] and mat:
                maps[mat] = path.parent / " ".join(p[1:])
    va, ta = np.array(v, np.float64).reshape(-1, 3), np.array(vt, np.float64).reshape(-1, 2)
    parts: list[dict] = []
    images: list[bytes] = []
    for name, faces in groups.items():
        arr = np.array(faces, np.int64)  # (m, 3, 2)
        pos = va[arr[:, :, 0].ravel()]
        part: dict = {"positions": pos, "indices": np.arange(len(pos)).reshape(-1, 3)}
        if name in maps and (arr[:, :, 1] >= 0).all():
            uv = ta[arr[:, :, 1].ravel()]
            part["uvs"] = np.column_stack([uv[:, 0], 1 - uv[:, 1]])  # OBJ v up, glTF v down
            from PIL import Image

            with Image.open(maps[name]) as im:
                images.append(_jpeg(np.asarray(im.convert("RGB"))))
            part["texture"] = len(images) - 1
        parts.append(part)
    return parts, images


def texture_texrecon(
    ctx: StepContext, work: Path, mesh: Mesh, views: list[View], origin: np.ndarray, image_scale: float = 1.0
) -> tuple[bytes, dict]:
    exe = find_tool("texrecon")
    if exe is None:
        raise JobError("texrecon is not in this pipeline pack.")
    scene = work / "scene"
    scene.mkdir(parents=True, exist_ok=True)
    from PIL import Image

    for i, v in enumerate(views):
        ctx.check()
        cam = v.camera.scaled(image_scale) if image_scale != 1 else v.camera
        stem = f"view{v.id:05d}"
        if not (scene / f"{stem}.cam").exists():
            img = undistort_image(load_image(v.path, image_scale), cam)
            Image.fromarray(img).save(scene / f"{stem}.png")
            write_cam(scene / f"{stem}.cam", v, cam.pinhole(), origin)
        ctx.progress(0.3 * (i + 1) / len(views), "Undistorting photos for texturing")
    ply = work / "mesh.ply"
    write_ply_mesh(ply, mesh)
    out = work / "out"
    out.mkdir(exist_ok=True)
    args = [
        exe,
        "--keep_unseen_faces",
        "--no_intermediate_results",
        "-o",
        "gauss_clamping",
        str(scene),
        str(ply),
        str(out / "textured"),
    ]
    run_tool(
        ctx,
        args,
        "Texturing (texrecon)",
        work,
        expected_s=max(60.0, mesh.triangles / 5e4),
        progress=(0.3, 0.9),
    )
    obj = out / "textured.obj"
    if not obj.is_file():
        raise JobError("texrecon finished without writing a textured mesh.")
    parts, images = read_obj(obj)
    for p in parts:
        p["positions"] = enu_to_local(np.asarray(p["positions"]))
    return glb_bytes(parts, images), {"textures": len(images)}


def glb_untextured(mesh: Mesh) -> bytes:
    cols = mesh.colours
    part: dict = {"positions": enu_to_local(mesh.vertices), "indices": mesh.faces}
    if cols is not None:
        part["color"] = [float(c) / 255 for c in np.median(cols, 0)] + [1.0]
    return glb_bytes([part], [])


def glb_info(data: bytes) -> dict:
    """The JSON chunk of a GLB (for checks)."""
    length = int.from_bytes(data[12:16], "little")
    return json.loads(data[20 : 20 + length])
