"""A stand-in for ODM 3.6.2's run.bat in tests (never shipped): see Task 3 of the ODM plan."""

from __future__ import annotations

import argparse
import json
import math
import os
import socket
import struct
import subprocess
import sys
import time
from pathlib import Path

import numpy as np

STAGES = ("dataset", "opensfm", "openmvs", "odm_filterpoints", "odm_meshing", "mvs_texturing",
          "odm_georeferencing", "odm_dem", "odm_orthophoto", "odm_report", "odm_postprocess")  # fmt: skip
END = {"dataset": 5, "opensfm": 25, "openmvs": 50, "odm_filterpoints": 52, "odm_meshing": 60,
       "mvs_texturing": 70, "odm_georeferencing": 80, "odm_dem": 90, "odm_orthophoto": 98,
       "odm_report": 99, "odm_postprocess": 100}  # fmt: skip
NODATA = -9999.0


def parse(argv: list[str]) -> argparse.Namespace:
    p = argparse.ArgumentParser()
    p.add_argument("--project-path", required=True)
    p.add_argument("--end-with", default="odm_postprocess")
    p.add_argument("--rerun-from")
    p.add_argument("--gcp")
    p.add_argument("--geo")
    p.add_argument("--force-gps", action="store_true")
    p.add_argument("--feature-type", default="dspsift")
    p.add_argument("--no-gpu", action="store_true")
    p.add_argument("--fast-orthophoto", action="store_true")
    p.add_argument("--skip-3dmodel", action="store_true")
    p.add_argument("--dtm", action="store_true")
    p.add_argument("--pc-classify", action="store_true")
    p.add_argument("--orthophoto-resolution", type=float, default=5.0)
    p.add_argument("--dem-resolution", type=float, default=5.0)
    # the project name is the last argument, as in ODM; every other ODM flag is accepted and ignored
    args, _ = p.parse_known_args(argv[:-1])
    args.name = argv[-1]
    return args


def udp(name: str, pct: float) -> None:
    port = int(os.environ.get("FAKE_ODM_UDP_PORT", "6367"))
    if not port:
        return
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
        try:  # noqa: SIM105
            s.sendto(f"PGUP/{os.getpid()}/{name}/{float(pct)}".encode(), ("127.0.0.1", port))
        except OSError:
            pass


def gpu_on(a: argparse.Namespace) -> bool:
    return a.feature_type == "sift" and not a.no_gpu


# ------------------------------------------------------------------------------ frames and files


def _crs():
    from aio_pipelines.photo import crs as C

    return C


def read_reconstruction(project: Path) -> tuple[dict, dict]:
    sfm = project / "opensfm"
    rec = json.loads((sfm / "reconstruction.topocentric.json").read_text("utf-8"))[0]
    ref = json.loads((sfm / "reference_lla.json").read_text("utf-8"))
    return rec, ref


def utm_points(project: Path) -> tuple[int, np.ndarray, np.ndarray]:
    """(UTM EPSG, points as easting, northing, height, colours) of the reconstruction."""
    C = _crs()
    rec, ref = read_reconstruction(project)
    enu = C.EnuFrame(ref["longitude"], ref["latitude"], ref["altitude"])
    xyz = np.array([p["coordinates"] for p in rec["points"].values()], dtype=np.float64).reshape(-1, 3)
    cols = np.array([p["color"] for p in rec["points"].values()], dtype=np.uint8).reshape(-1, 3)
    epsg = C.utm_epsg(enu.lon0, enu.lat0)
    lon, lat, h = enu.to_geodetic(xyz)
    e, n = C.geodetic_to_crs(epsg, lon, lat)
    return epsg, np.stack([e, n, h], axis=1), cols


def write_coords(project: Path, epsg: int, utm: np.ndarray) -> tuple[float, float]:
    ox, oy = math.floor(float(utm[:, 0].min())), math.floor(float(utm[:, 1].min()))
    zone = f"{epsg % 100}{'N' if epsg < 32700 else 'S'}"
    out = project / "odm_georeferencing"
    out.mkdir(parents=True, exist_ok=True)
    (out / "coords.txt").write_text(f"WGS84 UTM {zone}\n{ox} {oy}\n", "utf-8")
    return float(ox), float(oy)


def read_offset(project: Path) -> tuple[float, float]:
    line = (project / "odm_georeferencing" / "coords.txt").read_text("utf-8").splitlines()[1]
    ox, oy = line.split()[:2]
    return float(ox), float(oy)


def write_stats(project: Path, gcp_errors: dict | None = None) -> None:
    stats: dict = {
        "reconstruction_statistics": {"reprojection_error_pixels": 0.5, "average_track_length": 3.0}
    }
    if gcp_errors is not None:
        stats["gcp_errors"] = gcp_errors
    (project / "opensfm" / "stats").mkdir(parents=True, exist_ok=True)
    (project / "opensfm" / "stats" / "stats.json").write_text(json.dumps(stats), "utf-8")


# --------------------------------------------------------------------------------- the stages


def _rotvec_matrix(v):
    from scipy.spatial.transform import Rotation

    return Rotation.from_rotvec(v).as_matrix()


def _moved_truth(truth: dict, with_gcp: bool) -> dict:
    """The truth, or the truth moved by its bias (an ODM run without ground control)."""
    rec = {k: truth[k] for k in ("cameras", "shots", "points")}
    b = np.asarray(truth.get("bias", [0.0, 0.0, 0.0]), dtype=np.float64)
    if with_gcp or not b.any():
        return rec
    shots = {}
    for name, s in rec["shots"].items():
        r = _rotvec_matrix(s["rotation"])
        shots[name] = {
            **s,
            "translation": [float(v) for v in np.asarray(s["translation"]) - r @ b],
            "gps_position": [float(v) for v in np.asarray(s["gps_position"]) + b],
        }
    points = {
        k: {**p, "coordinates": [float(x) for x in np.asarray(p["coordinates"]) + b]}
        for k, p in rec["points"].items()
    }
    return {"cameras": rec["cameras"], "shots": shots, "points": points}


#: How far the fake moves the reference from the control points' mean (east, north, up, metres).
REFERENCE_SHIFT = (3.0, -2.0, 1.0)


def _gcp_points(path: str) -> dict[str, tuple[float, float, float]]:
    """Longitude, latitude and height of each control point in a gcp_list.txt."""
    from pyproj import CRS, Transformer

    lines = [ln for ln in Path(path).read_text("utf-8").splitlines() if ln.strip()]
    if len(lines) < 2:
        return {}
    to_ll = Transformer.from_crs(CRS.from_user_input(lines[0].strip()), CRS.from_epsg(4326), always_xy=True)
    out = {}
    for ln in lines[1:]:
        f = ln.split()
        lon, lat = to_ll.transform(float(f[0]), float(f[1]))
        out[f[6] if len(f) > 6 else f"{f[0]},{f[1]}"] = (lon, lat, float(f[2]))
    return out


def _gcp_reference(gcps: dict[str, tuple[float, float, float]]) -> dict:
    C = _crs()
    lon, lat, h = (float(np.mean([p[i] for p in gcps.values()])) for i in range(3))
    lon2, lat2, h2 = C.EnuFrame(lon, lat, h).to_geodetic(np.array([REFERENCE_SHIFT]))
    return {"latitude": float(lat2[0]), "longitude": float(lon2[0]), "altitude": float(h2[0])}


def _reframed(rec: dict, old: dict, new: dict) -> dict:
    """The reconstruction moved from the topocentric frame of ``old`` to that of ``new``."""
    if old == new:
        return rec
    from scipy.spatial.transform import Rotation

    C = _crs()
    f_old = C.EnuFrame(old["longitude"], old["latitude"], old["altitude"])
    f_new = C.EnuFrame(new["longitude"], new["latitude"], new["altitude"])

    def conv(p):
        return f_new.from_geodetic(*f_old.to_geodetic(np.asarray(p, dtype=np.float64).reshape(-1, 3)))

    names = list(rec["shots"])
    rs = np.array([_rotvec_matrix(rec["shots"][n]["rotation"]) for n in names])
    cs = np.array([-r.T @ np.asarray(rec["shots"][n]["translation"]) for n, r in zip(names, rs, strict=True)])
    c2, r2 = C.transform_rotations(conv, cs, rs)
    shots = {}
    for i, n in enumerate(names):
        shots[n] = {
            **rec["shots"][n],
            "rotation": [float(v) for v in Rotation.from_matrix(r2[i]).as_rotvec()],
            "translation": [float(v) for v in -r2[i] @ c2[i]],
            "gps_position": [float(v) for v in conv(rec["shots"][n]["gps_position"])[0]],
        }
    pts = list(rec["points"])
    xyz = conv([rec["points"][k]["coordinates"] for k in pts]) if pts else np.zeros((0, 3))
    points = {k: {**rec["points"][k], "coordinates": [float(v) for v in xyz[i]]} for i, k in enumerate(pts)}
    return {"cameras": rec["cameras"], "shots": shots, "points": points}


def _exif_position(path: Path):
    from PIL import Image

    with Image.open(path) as im:
        gps = im.getexif().get_ifd(0x8825)
    if not gps or 2 not in gps or 4 not in gps:
        return None

    def deg(v, ref):
        d = float(v[0]) + float(v[1]) / 60 + float(v[2]) / 3600
        return -d if ref in ("S", "W") else d

    alt = float(gps[6]) if 6 in gps else 0.0
    return deg(gps[4], gps.get(3, "E")), deg(gps[2], gps.get(1, "N")), alt


def _geo_positions(path: str) -> dict[str, tuple[float, float, float]]:
    out = {}
    for line in Path(path).read_text("utf-8").splitlines()[1:]:
        f = line.split()
        if len(f) >= 4:
            out[f[0]] = (float(f[1]), float(f[2]), float(f[3]))
    return out


def stage_opensfm(project: Path, a: argparse.Namespace, gpu_bad: str) -> None:
    if gpu_on(a):
        if "features-fallback" in gpu_bad:
            print("[WARNING] GPU SIFT extraction failed, fallback to CPU", flush=True)
        else:
            print("[INFO]    Using GPU for extracting SIFT features", flush=True)
    sfm = project / "opensfm"
    sfm.mkdir(parents=True, exist_ok=True)
    truth_file = project / ".fake" / "truth.json"
    if truth_file.is_file():
        truth = json.loads(truth_file.read_text("utf-8"))
        # ODM's OpenSfM setup runs only without image_list.txt (or with --rerun-from up to opensfm);
        # only then are config.yaml and the GCP copy written, so only then does --gcp count
        setup = not (sfm / "image_list.txt").is_file() or (
            a.rerun_from is not None and STAGES.index(a.rerun_from) <= STAGES.index("opensfm")
        )
        with_gcp = bool(a.gcp) and setup
        gcps = _gcp_points(a.gcp) if with_gcp else {}
        ref_file = sfm / "reference_lla.json"
        old_ref = truth.get("reference") or json.loads(ref_file.read_text("utf-8"))
        if gcps:  # centred on the control points (ODM rounds to its UTM offset; the fake moves it more)
            ref = _gcp_reference(gcps)
        elif ref_file.is_file():
            ref = json.loads(ref_file.read_text("utf-8"))
        else:  # rewritten after an invalidation
            ref = old_ref
        rec = _reframed(_moved_truth(truth, with_gcp), old_ref, ref)
        for name in ("reconstruction.topocentric.json", "reconstruction.json"):
            (sfm / name).write_text(json.dumps([rec]), "utf-8")
        ref_file.write_text(json.dumps(ref), "utf-8")
        if setup:
            (sfm / "image_list.txt").write_text(
                "".join(f"{p}\n" for p in sorted((project / "images").iterdir())), "utf-8"
            )
            yes = {True: "yes", False: "no"}
            (sfm / "config.yaml").write_text(
                f"bundle_use_gcp: {yes[with_gcp]}\nbundle_use_gps: {yes[not with_gcp or a.force_gps]}\n",
                "utf-8",
            )
            if with_gcp:
                (sfm / "gcp_list.txt").write_bytes(Path(a.gcp).read_bytes())
        errors = None
        if gcps and not os.environ.get("FAKE_ODM_NO_GCP_ERRORS"):
            errors = {"average_error": 0.0, "points": {pid: {"error": 0.0} for pid in gcps}}
        write_stats(project, errors)
        epsg, utm, _ = utm_points(project)
        write_coords(project, epsg, utm)
        return
    from PIL import Image
    from scipy.spatial.transform import Rotation

    C = _crs()
    geo = _geo_positions(a.geo) if a.geo else {}
    drop = {n for n in os.environ.get("FAKE_ODM_DROP", "").split(",") if n}  # images ODM cannot place
    placed = {}
    for img in sorted((project / "images").iterdir()):
        if img.name in drop:
            continue
        pos = geo.get(img.name) or _exif_position(img)
        if pos is not None:
            placed[img.name] = pos
    if not placed:
        print("[ERROR]   fake: no photo has a position", flush=True)
        raise SystemExit(1)
    lon0, lat0, h0 = (float(np.mean([p[i] for p in placed.values()])) for i in range(3))
    enu = C.EnuFrame(lon0, lat0, h0)
    r_down = np.array([[1.0, 0, 0], [0, -1.0, 0], [0, 0, -1.0]])
    rotvec = [float(v) for v in Rotation.from_matrix(r_down).as_rotvec()]
    cameras, shots, centres = {}, {}, {}
    for name, (lon, lat, h) in placed.items():
        with Image.open(project / "images" / name) as im:
            w, h_px = im.size
        cid = f"cam{w}x{h_px}"
        cameras[cid] = {
            "projection_type": "perspective",
            "width": w,
            "height": h_px,
            "focal": 0.85,
            "k1": 0.0,
            "k2": 0.0,
        }
        c = enu.from_geodetic([lon], [lat], [h])[0]
        centres[name] = c
        shots[name] = {
            "camera": cid,
            "rotation": rotvec,
            "translation": [float(v) for v in -r_down @ c],
            "gps_position": [float(v) for v in c],
        }
    cs = np.array(list(centres.values()))
    lo, hi = cs.min(axis=0) - 15.0, cs.max(axis=0) + 15.0
    z = float(cs[:, 2].mean()) - 40.0
    points = {}
    for i, x in enumerate(np.linspace(lo[0], hi[0], 10)):
        for j, y in enumerate(np.linspace(lo[1], hi[1], 10)):
            points[str(i * 10 + j)] = {
                "coordinates": [float(x), float(y), z],
                "color": [90 + 6 * i, 100 + 5 * j, 80],
            }
    rec = {"cameras": cameras, "shots": shots, "points": points}
    for name in ("reconstruction.topocentric.json", "reconstruction.json"):
        (sfm / name).write_text(json.dumps([rec]), "utf-8")
    (sfm / "reference_lla.json").write_text(
        json.dumps({"latitude": lat0, "longitude": lon0, "altitude": h0}), "utf-8"
    )
    write_stats(project)
    epsg, utm, _ = utm_points(project)
    write_coords(project, epsg, utm)


UNDISTORTED = "opensfm/undistorted"


def undistorted_ok(project: Path) -> bool:
    return (project / UNDISTORTED / "reconstruction.nvm").is_file()


def undistort(project: Path) -> None:
    """Like ODM's opensfm stage: the undistorted photos and reconstruction, written again whenever
    they are missing, even when the stage itself is not rerun (seen on ODM 3.6.2, 14 Oct 2026)."""
    print(f"[INFO]    Undistorting {project / 'opensfm'} ...", flush=True)
    und = project / UNDISTORTED
    (und / "images").mkdir(parents=True, exist_ok=True)
    for img in sorted((project / "images").iterdir()):
        (und / "images" / f"{img.name}.jpg").write_bytes(b"undistorted")
    (und / "reconstruction.json").write_bytes((project / "opensfm" / "reconstruction.json").read_bytes())
    (und / "reconstruction.nvm").write_text("NVM_V3\n", "utf-8")


def need_undistorted(project: Path, stage: str) -> None:
    if not undistorted_ok(project):
        print(f"[ERROR]   fake: {stage} needs {UNDISTORTED}, which is missing", flush=True)
        raise SystemExit(1)


def stage_openmvs(project: Path, a: argparse.Namespace, gpu_bad: str) -> None:
    if a.fast_orthophoto:
        return
    need_undistorted(project, "openmvs")
    out = project / UNDISTORTED / "openmvs"  # where ODM keeps OpenMVS's scene and depth maps
    (out / "depthmaps").mkdir(parents=True, exist_ok=True)
    (out / "depthmaps" / "00000.dmap").write_bytes(b"DMAP-fake")
    (out / "scene_dense.mvs").write_bytes(b"MVSI-fake")
    if gpu_on(a):
        if "dense-fallback" in gpu_bad:
            print("[WARNING] OpenMVS failed with GPU, Falling back to CPU", flush=True)
        elif "dense-cuda" in gpu_bad:
            print("[INFO]    CUDA device 0 initialized: Fake GPU", flush=True)


def stage_texturing(project: Path, a: argparse.Namespace, gpu_bad: str) -> None:
    from PIL import Image

    need_undistorted(project, "mvs_texturing")
    _, utm, _ = utm_points(project)
    ox, oy = read_offset(project)
    x0, x1 = utm[:, 0].min() - ox, utm[:, 0].max() - ox
    y0, y1 = utm[:, 1].min() - oy, utm[:, 1].max() - oy
    z = float(np.median(utm[:, 2]))
    folder = project / ("odm_texturing_25d" if a.skip_3dmodel or a.fast_orthophoto else "odm_texturing")
    folder.mkdir(parents=True, exist_ok=True)
    tex = "odm_textured_model_geo_material0000_map_Kd.png"
    (folder / "odm_textured_model_geo.mtl").write_text(f"newmtl material0000\nmap_Kd {tex}\n", "utf-8")
    Image.fromarray(np.full((64, 64, 3), 128, np.uint8)).save(folder / tex)
    obj = (
        "mtllib odm_textured_model_geo.mtl\n"
        f"v {x0} {y0} {z}\nv {x1} {y0} {z}\nv {x1} {y1} {z}\nv {x0} {y1} {z}\n"
        "vt 0 0\nvt 1 0\nvt 1 1\nvt 0 1\n"
        "usemtl material0000\nf 1/1 2/2 3/3\nf 1/1 3/3 4/4\n"
    )
    (folder / "odm_textured_model_geo.obj").write_text(obj, "utf-8")


def stage_georeferencing(project: Path, a: argparse.Namespace, gpu_bad: str) -> None:
    _, utm, cols = utm_points(project)
    n = len(utm)
    scale = 0.001
    off = np.floor(utm.min(axis=0))
    lo, hi = utm.min(axis=0), utm.max(axis=0)
    header = b"".join([
        b"LASF", struct.pack("<HH", 0, 0), b"\0" * 16, struct.pack("<BB", 1, 2),
        b"fake-odm".ljust(32, b"\0"), b"fake-odm".ljust(32, b"\0"),
        struct.pack("<HHH", 1, 2026, 227), struct.pack("<I", 227), struct.pack("<I", 0),
        struct.pack("<BHI", 2, 26, n), struct.pack("<5I", n, 0, 0, 0, 0),
        struct.pack("<3d", scale, scale, scale), struct.pack("<3d", *off),
        struct.pack("<6d", hi[0], lo[0], hi[1], lo[1], hi[2], lo[2]),
    ])  # fmt: skip
    assert len(header) == 227
    xyz = np.round((utm - off) / scale).astype(np.int32)
    rec = np.zeros(n, dtype=[("xyz", "<i4", 3), ("i", "<u2"), ("f", "u1"), ("c", "u1"), ("a", "i1"), ("u", "u1"),
                             ("p", "<u2"), ("rgb", "<u2", 3)])  # fmt: skip
    rec["xyz"], rec["f"], rec["rgb"] = xyz, 0x09, cols.astype(np.uint16) * 257
    rec["c"] = 1  # unclassified
    if (a.dtm or a.pc_classify) and os.environ.get("FAKE_ODM_NO_GROUND") != "1":
        # ground classification (ODM runs SMRF under --dtm or --pc-classify): the lowest third
        rec["c"][utm[:, 2] <= np.percentile(utm[:, 2], 33)] = 2
    assert rec.dtype.itemsize == 26
    out = project / "odm_georeferencing"
    out.mkdir(parents=True, exist_ok=True)
    (out / "odm_georeferenced_model.las").write_bytes(header + rec.tobytes())
    (out / "odm_georeferenced_model.laz").write_bytes(header + rec.tobytes())  # what the DTM mark points at


def _raster_grid(utm: np.ndarray, res_cm: float):
    from rasterio.transform import from_origin

    res = res_cm / 100.0
    x0, y1 = float(utm[:, 0].min()), float(utm[:, 1].max())
    w = max(1, math.ceil((float(utm[:, 0].max()) - x0) / res))
    h = max(1, math.ceil((y1 - float(utm[:, 1].min())) / res))
    xs = x0 + (np.arange(w) + 0.5) * res
    ys = y1 - (np.arange(h) + 0.5) * res
    gx, gy = np.meshgrid(xs, ys)
    return from_origin(x0, y1, res, res), gx, gy


def stage_dem(project: Path, a: argparse.Namespace, gpu_bad: str) -> None:
    import rasterio
    from rasterio.crs import CRS
    from scipy.interpolate import griddata

    epsg, utm, _ = utm_points(project)
    transform, gx, gy = _raster_grid(utm, a.dem_resolution)
    z = griddata(utm[:, :2], utm[:, 2], (gx, gy), method="linear")
    z = np.where(np.isfinite(z), z, NODATA).astype(np.float32)
    out = project / "odm_dem"
    out.mkdir(parents=True, exist_ok=True)
    for name in ("dsm.tif", "dtm.tif"):  # the DTM equals the DSM
        with rasterio.open(out / name, "w", driver="GTiff", height=z.shape[0], width=z.shape[1], count=1,
                           dtype="float32", crs=CRS.from_epsg(epsg), transform=transform, nodata=NODATA) as ds:  # fmt: skip
            ds.write(z, 1)


def stage_orthophoto(project: Path, a: argparse.Namespace, gpu_bad: str) -> None:
    import rasterio
    from rasterio.crs import CRS
    from scipy.spatial import Delaunay, cKDTree

    epsg, utm, cols = utm_points(project)
    transform, gx, gy = _raster_grid(utm, a.orthophoto_resolution)
    grid = np.stack([gx.ravel(), gy.ravel()], axis=1)
    inside = (Delaunay(utm[:, :2]).find_simplex(grid) >= 0).reshape(gx.shape)
    _, nearest = cKDTree(utm[:, :2]).query(grid)
    rgb = cols[nearest].reshape(*gx.shape, 3)
    out = project / "odm_orthophoto"
    out.mkdir(parents=True, exist_ok=True)
    with rasterio.open(out / "odm_orthophoto.tif", "w", driver="GTiff", height=gx.shape[0], width=gx.shape[1],
                       count=4, dtype="uint8", crs=CRS.from_epsg(epsg), transform=transform) as ds:  # fmt: skip
        for b in range(3):
            ds.write(np.where(inside, rgb[..., b], 0).astype(np.uint8), b + 1)
        ds.write(np.where(inside, 255, 0).astype(np.uint8), 4)


def stage_report(project: Path, a: argparse.Namespace, gpu_bad: str) -> None:
    out = project / "odm_report"
    out.mkdir(parents=True, exist_ok=True)
    (out / "report.pdf").write_bytes(b"%PDF-1.4\n% fake odm report\n")
    stats = {"reconstruction_statistics": {"reprojection_error_pixels": 0.8}, "gcp_errors": []}
    (out / "stats.json").write_text(json.dumps(stats), "utf-8")


def stage_postprocess(project: Path, a: argparse.Namespace, gpu_bad: str) -> None:
    (project / "log.json").write_text(json.dumps({"success": True}), "utf-8")


def stage_none(project: Path, a: argparse.Namespace, gpu_bad: str) -> None:
    return None


STAGE_FNS = {
    "dataset": stage_none,
    "opensfm": stage_opensfm,
    "openmvs": stage_openmvs,
    "odm_filterpoints": stage_none,
    "odm_meshing": stage_none,
    "mvs_texturing": stage_texturing,
    "odm_georeferencing": stage_georeferencing,
    "odm_dem": stage_dem,
    "odm_orthophoto": stage_orthophoto,
    "odm_report": stage_report,
    "odm_postprocess": stage_postprocess,
}


def missing_output(project: Path, stage: str) -> bool:
    """ODM runs a stage again when its main output is gone (after an invalidation)."""
    return stage == "opensfm" and not (project / "opensfm" / "reconstruction.json").is_file()


def main(argv: list[str]) -> int:
    if os.environ.get("FAKE_ODM_ARGS_LOG"):
        with open(os.environ["FAKE_ODM_ARGS_LOG"], "a", encoding="utf-8") as f:
            f.write(json.dumps(argv) + "\n")
    a = parse(argv)
    project = Path(a.project_path) / a.name
    fake = project / ".fake"
    fake.mkdir(parents=True, exist_ok=True)
    fail = os.environ.get("FAKE_ODM_FAIL", "")
    hang = os.environ.get("FAKE_ODM_HANG", "")
    gpu_bad = os.environ.get("FAKE_ODM_GPU", "ok")
    say = os.environ.get("FAKE_ODM_SAY", "")  # <stage>:<line>, printed during that stage
    busy = os.environ.get("FAKE_ODM_BUSY", "")  # a stage that works silently (OpenMVS's densify, -v 0)
    for stage in STAGES[: STAGES.index(a.end_with) + 1]:
        forced = a.rerun_from is not None and STAGES.index(stage) >= STAGES.index(a.rerun_from)
        print(f"[INFO]    Running {stage} stage", flush=True)
        if say.startswith(f"{stage}:"):
            print(say.split(":", 1)[1], flush=True)
        if fail.startswith(f"{stage}:"):
            print(f"[ERROR]   fake failure in {stage}", flush=True)
            return int(fail.split(":")[1])
        if hang == stage:
            child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(3600)"])
            Path(os.environ["FAKE_ODM_PIDS"]).write_text(f"{os.getpid()}\n{child.pid}\n")
            time.sleep(3600)
        if busy == stage:  # one core busy, no line and no datagram for FAKE_ODM_BUSY_S seconds
            end = time.monotonic() + float(os.environ.get("FAKE_ODM_BUSY_S", "10"))
            while time.monotonic() < end:
                pass
        if forced or not (fake / f"{stage}.done.json").exists() or missing_output(project, stage):
            half = float(os.environ.get("FAKE_ODM_STAGE_S", "0")) / 2
            time.sleep(half)  # the Running line is read before the midpoint datagram arrives
            STAGE_FNS[stage](project, a, gpu_bad)
            udp(
                a.name, (END[stage] + (END[STAGES[STAGES.index(stage) - 1]] if stage != "dataset" else 0)) / 2
            )
            time.sleep(half)  # and the midpoint holds long enough to be seen
            (fake / f"{stage}.done.json").write_text("{}")
        if stage == "opensfm" and not undistorted_ok(project):
            undistort(project)
        udp(a.name, END[stage])
        print(f"[INFO]    Finished {stage} stage", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
