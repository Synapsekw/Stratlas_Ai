"""ODM's outputs read into the project: rasters in the project CRS, the cloud as COPC, the mesh as GLB.

Paths and frames are the ones measured on ODM 3.6.2 (see the plan's constants C8 and C9): the
georeferenced cloud and the textured OBJ hold UTM easting and northing minus the offset on line 2
of ``coords.txt`` (x and y), and absolute heights.
"""

from __future__ import annotations

import json
import re
import shutil
import struct
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from ...runtime import JobError, StepContext
from .. import cloud_out, glb, native, surface
from ..surface import GridSpec

ORTHO = "odm_orthophoto/odm_orthophoto.tif"
DSM = "odm_dem/dsm.tif"
DTM = "odm_dem/dtm.tif"
CLOUDS = (
    "odm_georeferencing/odm_georeferenced_model.copc.laz",
    "odm_georeferencing/odm_georeferenced_model.laz",
    "odm_georeferencing/odm_georeferenced_model.las",
)
MESHES = (
    "odm_texturing/odm_textured_model_geo.obj",
    "odm_texturing_25d/odm_textured_model_geo.obj",
)
COORDS = "odm_georeferencing/coords.txt"
REPORT_PDF = "odm_report/report.pdf"
STATS = "odm_report/stats.json"


def output_path(odm_dir: Path, rel: str | tuple[str, ...]) -> Path:
    """The first of ``rel`` that exists under ``odm_dir``, else a plain error naming the file."""
    options = (rel,) if isinstance(rel, str) else rel
    for r in options:
        p = odm_dir / r
        if p.is_file():
            return p
    raise JobError(f"ODM did not write {Path(options[0]).name}; look at the job log.")


def read_coords(odm_dir: Path) -> tuple[int, tuple[float, float]]:
    """The UTM EPSG code and the (x, y) offset from ODM's ``coords.txt``."""
    err = JobError("ODM's coords.txt is not WGS84 UTM; this build cannot place its outputs.")
    try:
        lines = output_path(odm_dir, COORDS).read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError as e:
        raise err from e
    if len(lines) < 2:
        raise err
    m = re.fullmatch(r"\s*WGS\s?84\s+UTM\s+(\d{1,2})\s*([NS])\s*", lines[0], re.IGNORECASE)
    if not m or not 1 <= int(m.group(1)) <= 60:
        raise err
    try:
        x, y = (float(t) for t in lines[1].split()[:2])
    except ValueError as e:
        raise err from e
    base = 32600 if m.group(2).upper() == "N" else 32700
    return base + int(m.group(1)), (x, y)


def dem_to_project(src: Path, dst: Path, epsg: int) -> GridSpec:
    """A height raster as float32 with NaN for no data, north-up in the project CRS."""
    import rasterio
    from rasterio.enums import Resampling
    from rasterio.warp import calculate_default_transform, reproject

    with rasterio.open(src) as ds:
        if ds.crs is not None and ds.crs.to_epsg() == epsg:
            spec = GridSpec(ds.transform.c, ds.transform.f, ds.transform.a, ds.width, ds.height)
            data = ds.read(1).astype(np.float32)
            if ds.nodata is not None:
                data[data == np.float32(ds.nodata)] = np.nan
        else:
            res = abs(ds.transform.a)
            transform, width, height = calculate_default_transform(
                ds.crs, f"EPSG:{epsg}", ds.width, ds.height, *ds.bounds, resolution=res
            )
            spec = GridSpec(transform.c, transform.f, transform.a, width, height)
            data = np.full((height, width), np.nan, np.float32)
            reproject(
                source=rasterio.band(ds, 1),
                destination=data,
                src_transform=ds.transform,
                src_crs=ds.crs,
                src_nodata=ds.nodata,
                dst_transform=transform,
                dst_crs=f"EPSG:{epsg}",
                dst_nodata=np.nan,
                resampling=Resampling.bilinear,
            )
    with surface.write_tif(dst, spec, epsg, 1, "float32", nodata=np.nan) as out:
        out.write(data[None])
    return spec


def ortho_to_project(src: Path, dst: Path, epsg: int) -> Path:
    """``src`` when it is already in ``epsg``, else an RGBA GeoTIFF warped into it at ``dst``."""
    import rasterio
    from rasterio.enums import Resampling
    from rasterio.vrt import WarpedVRT

    with rasterio.open(src) as ds:
        if ds.crs is not None and ds.crs.to_epsg() == epsg:
            return src
        with WarpedVRT(ds, crs=f"EPSG:{epsg}", resampling=Resampling.bilinear) as vrt:
            profile = {
                "driver": "GTiff",
                "width": vrt.width,
                "height": vrt.height,
                "count": vrt.count,
                "dtype": vrt.dtypes[0],
                "crs": vrt.crs,
                "transform": vrt.transform,
                "tiled": True,
                "blockxsize": 256,
                "blockysize": 256,
                "compress": "deflate",
                "BIGTIFF": "IF_SAFER",
            }
            dst.parent.mkdir(parents=True, exist_ok=True)
            with rasterio.open(dst, "w", **profile) as out:
                for _, window in out.block_windows(1):
                    out.write(vrt.read(window=window), window=window)
                if vrt.count == 4:
                    out.colorinterp = ds.colorinterp
    return dst


def ground_height(dem: Path) -> float:
    """The median of the valid heights, read on a grid of at most 1024 x 1024."""
    import rasterio

    with rasterio.open(dem) as ds:
        shape = (min(ds.height, 1024), min(ds.width, 1024))
    a = surface.read_grid(dem, shape)
    a = a[np.isfinite(a)]
    if a.size == 0:
        raise JobError("ODM's height model has no valid heights.")
    return float(np.median(a))


def las_point_count(path: Path) -> int:
    """The point count a LAS or LAZ header declares (64-bit for LAS 1.4 when set)."""
    with open(path, "rb") as f:
        head = f.read(375)
    if head[:4] != b"LASF" or len(head) < 111:
        raise JobError(f"{path.name} is not a LAS file.")
    minor = head[25]
    if head[24] == 1 and minor >= 4 and len(head) >= 255:
        (n64,) = struct.unpack_from("<Q", head, 247)
        if n64:
            return int(n64)
    return int(struct.unpack_from("<I", head, 107)[0])


def cloud_to_copc(ctx: StepContext, odm_dir: Path, dst: Path, epsg: int, temp: Path, budget: int) -> dict:
    """ODM's georeferenced cloud as the project's COPC: copied when ODM's already fits, else PDAL
    reprojects (when the CRS differs) and untwine or PDAL writes it. Answers points, writer, source."""
    from ... import pointcloud

    src = output_path(odm_dir, CLOUDS)
    utm, _ = read_coords(odm_dir)
    if src.name.endswith(".copc.laz") and utm == epsg:
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(src, dst)
        return {"points": las_point_count(dst), "writer": "odm", "source": src.name}
    pdal = pointcloud.find_pdal()
    if pdal is None:
        raise JobError(cloud_out.NO_COPC_TOOL)
    temp.mkdir(parents=True, exist_ok=True)
    las = temp / "cloud.las"
    stages: list[dict] = [{"type": "readers.las", "filename": str(src)}]
    if utm != epsg:
        stages.append({"type": "filters.reprojection", "in_srs": f"EPSG:{utm}", "out_srs": f"EPSG:{epsg}"})
    stages.append(
        {"type": "writers.las", "filename": str(las), "compression": False, "a_srs": f"EPSG:{epsg}"}
    )
    pipeline = temp / "odm-cloud-pipeline.json"
    pipeline.write_text(json.dumps(stages), encoding="utf-8")
    native.run_tool(
        ctx, [pdal, "pipeline", str(pipeline)], "Point cloud", temp, env=pointcloud.pdal_env(pdal)
    )
    points = las_point_count(las)
    writer = cloud_out.write_copc(ctx, las, dst, points, epsg, temp, budget)
    return {"points": points, "writer": writer, "source": src.name}


# ------------------------------------------------------------------------------------------- mesh


@dataclass
class ObjPart:
    positions: np.ndarray  # (3 * triangles, 3), per corner
    uvs: np.ndarray | None  # (3 * triangles, 2), per corner
    texture: Path | None


def _mtl_textures(mtl: Path) -> dict[str, Path]:
    out: dict[str, Path] = {}
    if not mtl.is_file():
        return out
    name = None
    for line in mtl.read_text(encoding="utf-8", errors="replace").splitlines():
        tok = line.strip().split(None, 1)
        if len(tok) < 2:
            continue
        if tok[0] == "newmtl":
            name = tok[1].strip()
        elif tok[0] == "map_Kd" and name is not None and name not in out:
            out[name] = mtl.parent / tok[1].strip().split()[-1]
    return out


def read_obj(path: Path) -> list[ObjPart]:
    """An OBJ as one part per material, in order of first use; polygons are fanned into triangles."""
    verts: list[list[float]] = []
    vts: list[list[float]] = []
    textures: dict[str, Path] = {}
    order: list[str] = []
    corners: dict[str, list[tuple[int, int]]] = {}  # material -> (v index, vt index or -1)
    current = ""
    with open(path, encoding="utf-8", errors="replace") as f:
        for line in f:
            if line.startswith("v "):
                verts.append([float(t) for t in line.split()[1:4]])
            elif line.startswith("vt "):
                vts.append([float(t) for t in line.split()[1:3]])
            elif line.startswith("f "):
                refs = []
                for tok in line.split()[1:]:
                    p = tok.split("/")
                    vi = int(p[0])
                    vi = vi - 1 if vi > 0 else len(verts) + vi
                    ti = -1
                    if len(p) > 1 and p[1]:
                        t = int(p[1])
                        ti = t - 1 if t > 0 else len(vts) + t
                    refs.append((vi, ti))
                if current not in corners:
                    corners[current] = []
                    order.append(current)
                bucket = corners[current]
                for k in range(1, len(refs) - 1):
                    bucket.extend((refs[0], refs[k], refs[k + 1]))
            elif line.startswith("usemtl "):
                current = line.split(None, 1)[1].strip()
            elif line.startswith("mtllib "):
                textures.update(_mtl_textures(path.parent / line.split(None, 1)[1].strip()))
    v = np.asarray(verts, np.float64).reshape(-1, 3)
    vt = np.asarray(vts, np.float64).reshape(-1, 2)
    parts = []
    for mat in order:
        c = np.asarray(corners[mat], np.int64).reshape(-1, 2)
        uvs = None
        if len(vt) and (c[:, 1] >= 0).all():
            uvs = vt[c[:, 1]]
        parts.append(ObjPart(v[c[:, 0]], uvs, textures.get(mat)))
    return parts


def mesh_to_glb(
    odm_dir: Path, epsg: int, origin: np.ndarray, max_texture_px: int = 8192
) -> tuple[bytes, dict]:
    """ODM's textured OBJ as a GLB in the scene frame around ``origin`` (easting, northing, height)."""
    from PIL import Image

    obj = output_path(odm_dir, MESHES)
    utm, (ox, oy) = read_coords(odm_dir)
    transformer = None
    if utm != epsg:
        import pyproj

        transformer = pyproj.Transformer.from_crs(utm, epsg, always_xy=True)
    parts: list[dict] = []
    images: list[bytes] = []
    triangles = 0
    for part in read_obj(obj):
        e = part.positions[:, 0] + ox
        n = part.positions[:, 1] + oy
        h = part.positions[:, 2]
        if transformer is not None:
            e, n = transformer.transform(e, n)
        local = glb.enu_to_local(np.column_stack([e - origin[0], n - origin[1], h - origin[2]]))
        count = len(local) // 3
        triangles += count
        item: dict = {"positions": local, "indices": np.arange(len(local), dtype=np.uint32).reshape(-1, 3)}
        if part.uvs is not None and part.texture is not None and part.texture.is_file():
            with Image.open(part.texture) as im:
                im = im.convert("RGB")
                if max(im.size) > max_texture_px:
                    im.thumbnail((max_texture_px, max_texture_px), Image.Resampling.LANCZOS)
                images.append(glb.jpeg_bytes(np.asarray(im)))
            item["uvs"] = np.column_stack([part.uvs[:, 0], 1.0 - part.uvs[:, 1]])
            item["texture"] = len(images) - 1
        parts.append(item)
    if not parts:
        raise JobError("ODM's textured model has no faces.")
    source = "2.5d" if obj.parent.name == "odm_texturing_25d" else "3d"
    return glb.glb_bytes(parts, images), {"triangles": triangles, "textures": len(images), "source": source}
