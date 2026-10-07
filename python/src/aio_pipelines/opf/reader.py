"""Reads a checked OPF project with pyopf into what ``opf.import`` writes (the import plan).

The plan is plain JSON (kept in the job's staging, so a resumed job does not read the OPF again):
the photos with their resolved files and poses in the project frame, the camera groups, the
control points as an ``aio.gcp/1`` document, the point clouds and rasters to bring in, and every
note for the report. The sparse model (COLMAP, project CRS) is returned beside it.
"""

from __future__ import annotations

import re
import warnings
from collections.abc import Callable
from importlib.metadata import PackageNotFoundError, version
from pathlib import Path
from typing import Any
from urllib.parse import unquote

import numpy as np

from ..runtime import JobError, now_iso
from . import colmap
from .geometry import (
    GLTF_TO_ZUP,
    Lens,
    SceneFrame,
    lens_to_colmap,
    local_pose,
    north_first,
    opf_to_colmap,
    opk_matrix,
    project_crs,
    read_crs,
    same_crs,
)
from .safety import check_project, resource_path

DSM_WORDS = re.compile(r"dsm|dtm|dem|surface|elevation|height", re.I)
ORTHO_WORDS = re.compile(r"ortho", re.I)
MESH_EXT = (".obj", ".glb", ".ply", ".fbx", ".dae", ".slpk", ".b3dm", ".gltf")
TIFF_EXT = (".tif", ".tiff")
#: Tie points kept in the sparse model (the full set stays in the OPF project).
MAX_TIE_POINTS = 5_000_000
GEOIDS = {"5773": "egm96", "3855": "egm2008"}


def _pyopf_version() -> str:
    try:
        return version("pyopf")
    except PackageNotFoundError:
        return "unknown"


def _photo_id(name: str, taken: set[str]) -> str:
    stem = re.sub(r"[^A-Za-z0-9_-]+", "-", Path(name).stem).strip("-_")[:60] or "photo"
    if not stem[0].isalnum():
        stem = f"p{stem}"
    out, n = stem, 2
    while out in taken:
        out, n = f"{stem}-{n}", n + 1
    taken.add(out)
    return out


def _lens(internals: Any, size) -> Lens | None:
    if getattr(internals, "type", None) != "perspective":
        return None
    w, h = (int(v) for v in size)
    return Lens(
        w,
        h,
        float(internals.focal_length_px),
        float(internals.principal_point_px[0]),
        float(internals.principal_point_px[1]),
        tuple(float(v) for v in internals.radial_distortion),  # type: ignore[arg-type]
        tuple(float(v) for v in internals.tangential_distortion),  # type: ignore[arg-type]
    )


def _iso(t: Any) -> str | None:
    if t is None or getattr(t, "tzinfo", None) is None:
        return None
    return t.isoformat(timespec="seconds").replace("+00:00", "Z")


def _geolocated(geo: Any, project: Any, log: list[str]) -> np.ndarray | None:
    """A geolocation's coordinates as project E, N, H (heights as they are), or None."""
    info = read_crs(geo.crs.definition)
    if info.arbitrary:
        return None
    c = np.asarray(geo.coordinates, dtype=np.float64)
    x, y = (c[1], c[0]) if north_first(info.horizontal) else (c[0], c[1])
    if same_crs(info.horizontal, project):
        return np.array([x, y, c[2]])
    from rasterio.warp import transform

    try:
        xs, ys = transform(info.horizontal, project, [x], [y])
    except Exception as e:
        log.append(f"A position in {info.definition[:40]} could not be reprojected: {e}")
        return None
    out = np.array([xs[0], ys[0], c[2]])
    return out if np.all(np.isfinite(out)) else None


def cloud_points(pcl: Any) -> tuple[np.ndarray, np.ndarray | None]:
    """Processing-frame positions (float64) and RGB (uint8) of an OPF glTF point cloud."""
    xyz_all, rgb_all, has_rgb = [], [], True
    for node in pcl.nodes:
        pos = np.asarray(node.position, dtype=np.float64)
        m = np.asarray(node.matrix, dtype=np.float64) if node.matrix is not None else np.eye(4)
        if m.shape != (4, 4):
            m = np.eye(4)
        t = GLTF_TO_ZUP @ m
        xyz_all.append(pos @ t[:3, :3].T + t[:3, 3])
        if node.color is None:
            has_rgb = False
        else:
            rgb_all.append(np.asarray(node.color)[:, :3].astype(np.uint8))
    xyz = np.vstack(xyz_all) if xyz_all else np.zeros((0, 3))
    rgb = np.vstack(rgb_all) if has_rgb and rgb_all else None
    return xyz, rgb


def read_opf(
    src: Path,
    photos_root: Path | None,
    manifest: dict[str, Any],
    want: set[str],
    check: Callable[[], None],
) -> tuple[dict[str, Any], colmap.Model]:
    from pyopf.formats import CoreFormat
    from pyopf.io import load
    from pyopf.project import ProjectObjects
    from pyopf.project.types import CoreProjectItemType
    from pyopf.resolve import resolve

    checked = check_project(src)
    opf_dir = src.parent.resolve()
    notes: list[str] = []
    skipped_items: list[dict[str, str]] = [
        {"what": f"file {m}", "reason": "named by the OPF project but missing"} for m in checked.missing
    ]
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        try:
            project = load(str(src))
            objs: ProjectObjects = resolve(project)
        except Exception as e:
            raise JobError(f"pyopf could not read {src.name}: {e}") from e
    for w in caught:
        notes.append(f"pyopf: {w.message}")
    check()

    crs = project_crs(manifest)
    origin = [float(v) for v in (manifest.get("origin") or [0, 0, 0])]
    frame = SceneFrame(objs.scene_reference_frame, crs, origin)
    notes += frame.notes
    generator = project.generator
    gen = f"{generator.name} {generator.version}" if generator else "unknown writer"

    # sensors and cameras ---------------------------------------------------------
    inputs = objs.input_cameras
    calib = objs.calibration
    calibrated = calib.calibrated_cameras if calib else None
    in_sensors = {int(s.id): s for s in (inputs.sensors if inputs else [])}
    cal_sensors = {int(s.id): s for s in (calibrated.sensors if calibrated else [])}
    cal_cams = {int(c.id): c for c in (calibrated.cameras if calibrated else [])}
    uris = {int(c.id): c.uri for c in (objs.camera_list.cameras if objs.camera_list else [])}
    captures: dict[int, Any] = {}
    for cap in inputs.captures if inputs else []:
        for cam in cap.cameras:
            captures[int(cam.id)] = (cap, cam)
    projected: dict[int, np.ndarray] = {}
    pic = objs.projected_input_cameras
    for pcap in pic.captures if pic else []:
        if pcap.geolocation is not None:
            projected[int(pcap.id)] = np.asarray(pcap.geolocation.position, dtype=np.float64)

    cam_ids = list(dict.fromkeys([*captures.keys(), *cal_cams.keys()]))
    if not cam_ids and not checked.clouds:
        raise JobError(f"{src.name} has no cameras and no point clouds to import.")

    # photos ------------------------------------------------------------------------
    from .importer import is_relative_photo, resolve_photo

    taken: set[str] = set()
    names: dict[int, str] = {}
    used: set[str] = set()
    photos: list[dict[str, Any]] = []
    skipped: list[dict[str, str]] = []
    folders: list[str] = []
    absolute_only = True
    model = colmap.Model()
    colmap_cams: dict[tuple, int] = {}
    groups: dict[int, dict[str, Any]] = {}
    for cid in cam_ids:
        check()
        uri = uris.get(cid)
        cap_cam = captures.get(cid)
        cal = cal_cams.get(cid)
        sensor_id = (
            int(cal.sensor_id) if cal is not None else (int(cap_cam[1].sensor_id) if cap_cam else None)
        )
        in_sensor = in_sensors.get(sensor_id) if sensor_id is not None else None
        file: Path | None = None
        folder: Path | None = None
        why = "the OPF names no file for this camera"
        if uri:
            if is_relative_photo(uri):
                absolute_only = False
            file, folder, why = resolve_photo(uri, opf_dir, photos_root)
        if file is not None and folder is not None:
            name = file.relative_to(folder.resolve()).as_posix()
            if str(folder) not in folders:
                folders.append(str(folder))
        else:
            base = Path(uri.split("#", 1)[0].replace("\\", "/")).name if uri else f"camera-{cid}"
            name = base or f"camera-{cid}"
        if name in used:
            name = f"{name}#{cid}"
        used.add(name)
        names[cid] = name
        if file is None:
            skipped.append({"name": name, "reason": why})

        # pose
        size = in_sensor.image_size_px if in_sensor is not None else None
        lens = None
        if cal is not None and sensor_id in cal_sensors and size is not None:
            lens = _lens(cal_sensors[sensor_id].internals, size)
        elif in_sensor is not None:
            lens = _lens(in_sensor.internals, in_sensor.image_size_px)
        rec: dict[str, Any] = {"name": name, "file": str(file) if file else None}
        if size is not None:
            rec["size"] = [int(v) for v in size]
        if cap_cam is not None:
            t = _iso(cap_cam[0].time)
            if t:
                rec["takenAt"] = t
        if lens is not None:
            rec["lens"] = lens.pinhole()
        if cal is not None:
            proc = np.asarray(cal.position, dtype=np.float64)
            enh = frame.to_project(proc)[0]
            r_enu = frame.axes_at(proc) @ opk_matrix(cal.orientation_deg)
            rec["pos"], rec["q"] = local_pose(r_enu, enh, origin)
            if lens is not None:
                cmodel, cparams = lens_to_colmap(lens)
                key = (sensor_id, cmodel, lens.width, lens.height, tuple(cparams))
                if key not in colmap_cams:
                    colmap_cams[key] = len(colmap_cams) + 1
                    model.cameras[colmap_cams[key]] = colmap.Camera(
                        colmap_cams[key], cmodel, lens.width, lens.height, cparams
                    )
                qvec, tvec = opf_to_colmap(r_enu, enh)
                iid = len(model.images) + 1
                model.images[iid] = colmap.Image(iid, qvec, tvec, colmap_cams[key], name)
            else:
                notes.append(
                    f"{name}: its sensor is not a perspective camera; it is placed without a lens model."
                )
        elif cap_cam is not None:
            capture = cap_cam[0]
            enh = None
            if int(capture.id) in projected:
                enh = frame.to_project(projected[int(capture.id)])[0]
            elif capture.geolocation is not None:
                enh = _geolocated(capture.geolocation, crs, notes)
            if enh is not None:
                e, n, h = enh
                rec["pos"] = [round(e - origin[0], 4), round(h - origin[2], 4), round(-(n - origin[1]), 4)]
        if file is not None:
            rec["id"] = _photo_id(name, taken)
            photos.append(rec)
        # camera groups (one per sensor)
        if sensor_id is not None:
            g = groups.get(sensor_id)
            if g is None:
                w, h = (
                    (int(v) for v in size)
                    if size is not None
                    else (lens.width, lens.height)
                    if lens
                    else (1, 1)
                )
                g = {"id": f"sensor-{sensor_id}", "widthPx": max(1, w), "heightPx": max(1, h), "photos": 0}
                if in_sensor is not None:
                    g["model"] = str(in_sensor.name)[:120]
                    px_mm = float(in_sensor.pixel_size_um) / 1000
                    if px_mm > 0:
                        g["sensorWidthMm"] = round(w * px_mm, 4)
                        if lens is not None:
                            g["focalMm"] = round(lens.focal_px * px_mm, 4)
                owner = cal_sensors.get(sensor_id) or in_sensor
                kind = getattr(getattr(owner, "internals", None), "type", "unknown")
                g["calibration"] = lens_to_colmap(lens)[0] if lens is not None else f"{kind} (not imported)"
                groups[sensor_id] = g
            g["photos"] += 1
    found = len(photos)
    if cam_ids and found == 0 and absolute_only and photos_root is None:
        raise JobError(
            f"None of the {len(cam_ids)} photos of {src.name} were found: the OPF names them by absolute paths "
            f"(for example {next(iter(uris.values()), '?')[:120]}). Choose that photos folder as Photos folder and "
            "import again."
        )
    if skipped:
        notes.append(f"{len(skipped)} of {len(cam_ids)} photos were not found and have no review copy.")

    # tie points ---------------------------------------------------------------------
    tracks = calib.tracks if calib else None
    if tracks is not None and len(tracks.nodes):
        xyz, rgb = cloud_points(tracks)
        if len(xyz) > MAX_TIE_POINTS:
            keep = np.linspace(0, len(xyz) - 1, MAX_TIE_POINTS).astype(np.int64)
            xyz, rgb = xyz[keep], (rgb[keep] if rgb is not None else None)
            notes.append(f"The sparse model keeps {MAX_TIE_POINTS:,} of the tie points.")
        model.xyz = frame.to_project(xyz) if len(xyz) else np.zeros((0, 3))
        model.rgb = rgb if rgb is not None else np.full((len(xyz), 3), 200, dtype=np.uint8)
        model.error = np.zeros(len(xyz))

    # control points ---------------------------------------------------------------
    gcp_doc = None
    icp = objs.input_control_points
    pcp = objs.projected_control_points
    proj_gcps = {
        g.id: np.asarray(g.coordinates, dtype=np.float64) for g in (pcp.projected_gcps if pcp else [])
    }
    points = []
    marks_dropped = 0
    for g in icp.gcps if icp else []:
        # the surveyed coordinates as given when they are in the project CRS, else the projected ones
        # (consistent with the cameras), else the surveyed ones reprojected
        if same_crs(read_crs(g.geolocation.crs.definition).horizontal, crs) or g.id not in proj_gcps:
            enh = _geolocated(g.geolocation, crs, notes)
        else:
            enh = frame.to_project(proj_gcps[g.id])[0]
        if enh is None:
            skipped_items.append(
                {"what": f"control point {g.id}", "reason": "its coordinates are in an arbitrary frame"}
            )
            continue
        s = np.abs(np.asarray(g.geolocation.sigmas, dtype=np.float64))
        marks = []
        for mk in g.marks:
            nm = names.get(int(mk.camera_id))
            if nm is None:
                marks_dropped += 1
                continue
            marks.append(
                {
                    "photo": nm,
                    "px": [float(mk.position_px[0]), float(mk.position_px[1])],
                    "by": "import",
                    "at": now_iso(),
                    "state": "confirmed",
                }
            )
        points.append(
            {
                "id": str(g.id)[:64],
                "role": "check" if g.is_checkpoint else "control",
                "xyz": [float(v) for v in enh],
                "accuracy": {
                    "horizontalM": max(1e-4, float(max(s[0], s[1]))),
                    "verticalM": max(1e-4, float(s[2])),
                },
                "marks": marks,
            }
        )
    if icp and icp.mtps:
        skipped_items.append(
            {
                "what": f"{len(icp.mtps)} manual tie points",
                "reason": "Stratlas keeps control and check points only",
            }
        )
    if marks_dropped:
        notes.append(f"{marks_dropped} control point marks name cameras the OPF does not list; left out.")
    if points:
        gcp_doc = {
            "schema": "aio.gcp/1",
            "crs": manifest.get("crs"),
            "importedFrom": src.name[:260],
            "points": points,
        }

    # outputs --------------------------------------------------------------------
    clouds = []
    for i, pc in enumerate(objs.point_cloud_objs):
        meta = pc.metadata
        nm = (meta.name if meta and meta.name else None) or f"Point cloud {i + 1}"
        if "cloud" not in want:
            skipped_items.append({"what": f"point cloud {nm}", "reason": "not asked for"})
            continue
        gltf = next(
            (str(r.uri) for r in (meta.resources if meta else []) if r.format == CoreFormat.GLTF_MODEL), None
        )
        if gltf is None:
            skipped_items.append({"what": f"point cloud {nm}", "reason": "it has no glTF file"})
            continue
        clouds.append({"name": str(nm)[:120], "gltf": str(resource_path(opf_dir, gltf, "a point cloud"))})
    rasters = []
    for item in project.items:
        if isinstance(item.type, CoreProjectItemType):
            continue
        tname = str(getattr(item.type, "name", item.type))
        for res in item.resources:
            uri = str(res.uri)
            ext = Path(uri).suffix.lower()
            fmt = str(getattr(res.format, "name", res.format))
            label = " ".join([str(item.name or ""), tname, *(item.labels or []), uri])
            if ext in TIFF_EXT or fmt.startswith(("image/tiff", "image/geotiff")):
                path = (opf_dir / unquote(uri)).resolve()
                if not path.is_file():
                    continue
                role = (
                    "dsm"
                    if DSM_WORDS.search(label)
                    else "ortho"
                    if ORTHO_WORDS.search(label)
                    else _guess_role(path)
                )
                if role is None:
                    skipped_items.append(
                        {"what": f"raster {uri}", "reason": "neither an orthomosaic nor a DSM"}
                    )
                elif role not in want:
                    skipped_items.append({"what": f"{role} {uri}", "reason": "not asked for"})
                else:
                    rasters.append(
                        {"file": str(path), "role": role, "name": str(item.name or Path(uri).stem)[:120]}
                    )
            elif ext in MESH_EXT:
                skipped_items.append(
                    {
                        "what": f"mesh {uri}",
                        "reason": "meshes are not part of OPF 1.0; import the mesh file with Builder, Import",
                    }
                )

    heights = None
    v = frame.info.vertical
    if v:
        code = v.split(":")[-1]
        heights = {
            "source": "orthometric",
            "geoid": GEOIDS.get(code, "none"),
            "note": f"As in the OPF: {v}"[:300],
        }
    status = "aligned" if model.images else "cancelled"
    if status == "aligned" and calib is not None and calib.calibrated_control_points is not None:
        status = "adjusted"
    if not model.images:
        notes.append(
            "The OPF project has no calibrated perspective cameras: align the photos to process them."
        )
    srf = objs.scene_reference_frame
    plan = {
        "frame": None
        if srf is None
        else {
            "crs": srf.crs.definition,
            "shift": [float(v) for v in srf.base_to_canonical.shift],
            "scale": [float(v) for v in srf.base_to_canonical.scale],
            "swap": bool(srf.base_to_canonical.swap_xy),
        },
        "name": str(project.name or src.stem)[:120],
        "generator": gen[:80],
        "versions": {"opf": str(project.version)[:80], "pyopf": _pyopf_version()[:80], "generator": gen[:80]},
        "status": status,
        "folders": folders,
        "photos": photos,
        "skipped": skipped,
        "skippedItems": skipped_items,
        "groups": list(groups.values())[:100],
        "heights": heights,
        "gcp": gcp_doc,
        "clouds": clouds,
        "rasters": rasters,
        "warnings": notes,
        "src": str(src),
        "summary": {
            "cameras": len(cam_ids),
            "calibrated": len(model.images),
            "photosFound": found,
            "tiePoints": len(model.xyz),
        },
    }
    return plan, model


def _guess_role(path: Path) -> str | None:
    """An orthomosaic is 8-bit RGB(A); a DSM is one band of heights."""
    import rasterio

    try:
        with rasterio.open(path) as ds:
            if ds.count >= 3 and ds.dtypes[0] == "uint8":
                return "ortho"
            if ds.count == 1 and ds.dtypes[0] not in ("uint8",):
                return "dsm"
    except Exception:
        return None
    return None
