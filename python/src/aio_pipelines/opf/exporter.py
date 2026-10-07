"""opf.export: a processing run as an OPF 1.0 project another OPF reader (Pix4D) opens.

Parameters as ``OpfExportParams`` in ``@aio/schema``: ``run`` (a run id under ``photogrammetry/``)
and ``out`` (an absolute folder, chosen in a save dialog; empty, new, or an earlier Stratlas
export, which is overwritten).

The run is read from its files (data-conventions section 21): ``run.json``, the sparse model
``sparse/`` (COLMAP text or binary, in the project CRS) and ``gcp.json`` when there is one. The
OPF project is written with pyopf (Apache-2.0, core only) into the job's staging, read back with
pyopf as the check, then copied into ``out``:

- ``scene_reference_frame``: the project CRS (``EPSG:n`` or WKT 2), shifted by the manifest origin;
- ``camera_list`` and ``input_cameras``: one capture per registered photo, the photos referenced
  where they are (absolute ``file:`` URIs to the originals of a folder run, or to the project's
  photos for a layer run), a perspective sensor per COLMAP camera;
- ``input_control_points`` and ``projected_control_points``: confirmed marks only;
- ``calibration``: calibrated cameras and sensors, and the tie points as an OPF glTF point cloud;
- the run's orthomosaic and DSM COGs copied to ``outputs/`` and listed as ``ext_stratlas_*``
  items (other readers skip them; ``opf.import`` reads them back).
"""

from __future__ import annotations

import json
import re
import shutil
import warnings
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import numpy as np

from .. import __version__
from ..params import known_keys, text
from ..runtime import JobError, Step, StepContext, atomic_write_json
from . import colmap
from .geometry import (
    ZUP_TO_GLTF,
    colmap_to_opf,
    crs_definition,
    lens_from_colmap,
    north_first,
    opk_angles,
    project_crs,
    read_crs,
    same_crs,
)

RUN_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$")
GENERATOR = "Stratlas"
#: Luminance weights for an RGB sensor's bands (they must sum to 1).
RGB_BANDS = (("Red", 0.2126), ("Green", 0.7152), ("Blue", 0.0722))
OUTPUT_ROLES = (("dsm", re.compile(r"dsm|dtm|dem", re.I)), ("ortho", re.compile(r"ortho", re.I)))
#: Tie points written to the OPF (a spread subset of larger models).
MAX_TRACKS = 5_000_000


def _json(path: Path, what: str) -> Any:
    try:
        return json.loads(path.read_text("utf-8"))
    except (OSError, ValueError) as e:
        raise JobError(f"{what} {path.name} could not be read: {e}") from e


def _time(value: Any) -> datetime | None:
    if not isinstance(value, str):
        return None
    try:
        t = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return t if t.tzinfo else None


def _photo_lookup(project: Path, run: dict[str, Any], manifest: dict[str, Any]):
    """name -> (absolute file or None, photos-layer item or None) for the run's images."""
    source = (run.get("photos") or {}).get("source") or {}
    folders = [Path(f) for f in source.get("folders") or [] if isinstance(f, str)]
    items: dict[str, dict[str, Any]] = {}
    if isinstance(source.get("layer"), str):
        layer = next(
            (
                x
                for x in manifest.get("layers") or []
                if x.get("id") == source["layer"] and x.get("kind") == "photos"
            ),
            None,
        )
        if layer is None:
            raise JobError(f'The run\'s photos layer "{source["layer"]}" is not in the project.')
        for it in layer.get("items") or []:
            items[str(it.get("id"))] = it
            p = (it.get("src") or {}).get("path")
            if isinstance(p, str):
                items.setdefault(Path(p).name, it)

    def find(name: str) -> tuple[Path | None, dict[str, Any] | None]:
        for f in folders:
            cand = f / name
            if cand.is_file():
                return cand.resolve(), None
        it = items.get(name) or items.get(Path(name).name) or items.get(Path(name).stem)
        if it is not None:
            p = (it.get("src") or {}).get("path")
            if isinstance(p, str):
                return (project / p).resolve(), it
            return None, it
        return None, None

    return find


class OpfExport:
    name = "opf.export"
    title = "OPF export"
    description = "A processing run as an OPF project: cameras, calibration, control points, CRS."
    keys = frozenset({"run", "out"})

    def validate(self, params: dict[str, Any]) -> dict[str, Any]:
        known_keys(params, set(self.keys), self.name)
        run = text(params, "run", required=True)
        out = text(params, "out", required=True)
        assert run is not None and out is not None
        if not RUN_RE.match(run):
            raise JobError(f'"{run}" is not a run id.')
        if not Path(out).is_absolute():
            raise JobError("out must be an absolute folder (choose it with Export to folder).")
        return {"run": run, "out": out}

    def inputs(self, params: dict[str, Any]) -> list[str]:
        d = f"photogrammetry/{params['run']}"
        return [f"{d}/run.json", f"{d}/sparse", f"{d}/gcp.json"]

    def plan(self, params: dict[str, Any]) -> list[Step]:
        run_id = params["run"]

        def build(ctx: StepContext) -> dict[str, Any]:
            return _build(ctx, run_id)

        def write(ctx: StepContext) -> dict[str, Any]:
            return _write(ctx, Path(params["out"]), run_id)

        return [
            Step("build", "Write and check the OPF project", build, weight=3),
            Step("write", "Copy the OPF project to the export folder", write, weight=2),
        ]


def _build(ctx: StepContext, run_id: str) -> dict[str, Any]:
    from uuid import uuid4

    from pyopf.cameras import (
        BandInformation,
        CalibratedCamera,
        CalibratedCameras,
        CalibratedSensor,
        Camera,
        CameraData,
        CameraList,
        Capture,
        InputCameras,
        ModelSource,
        PerspectiveInternals,
        PixelType,
        RigModelSource,
        Sensor,
        ShutterType,
        StaticPixelRange,
    )
    from pyopf.cps import Gcp, InputControlPoints, Mark, ProjectedControlPoints, ProjectedGcp
    from pyopf.crs import BaseToTranslatedCanonicalCrsTransform, Crs, Geolocation, SceneReferenceFrame
    from pyopf.formats import CoreFormat, format_to_str
    from pyopf.pointcloud.pcl import GlTFPointCloud, Node
    from pyopf.uid64 import Uid64

    run_dir = ctx.project / "photogrammetry" / run_id
    run = _json(run_dir / "run.json", "The run file")
    if not isinstance(run, dict) or run.get("schema") != "aio.photo-run/1":
        raise JobError(f"photogrammetry/{run_id}/run.json is not a processing run (aio.photo-run/1).")
    manifest = _json(ctx.project / "manifest.json", "The project manifest")
    crs = project_crs(manifest)
    definition = crs_definition(manifest)
    swap = north_first(crs)
    origin = np.asarray(manifest.get("origin") or [0, 0, 0], dtype=np.float64)
    model = colmap.read_model(run_dir / "sparse")
    if not model.images:
        raise JobError(f"The run {run_id} has no registered photos to export.")
    notes: list[str] = []
    find = _photo_lookup(ctx.project, run, manifest)
    groups = {str(g.get("id")): g for g in run.get("cameras") or [] if isinstance(g, dict)}
    fallback_time = _time(run.get("createdAt")) or datetime.now(UTC)

    out = ctx.stage("opf/.keep").parent
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)
    items: list[dict[str, Any]] = []

    def add(kind: str, name: str, objs: list[tuple[Any, str]], sources: tuple = ()) -> dict[str, Any]:
        """Write OPF resources and their project item (pyopf's own saver loses the drive of Windows paths)."""
        resources = []
        for obj, rel in objs:
            if obj is not None:
                path = out / rel
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(json.dumps(obj.to_dict(), indent=2), "utf-8")
                resources.append({"uri": rel, "format": format_to_str(obj.format)})
            else:
                resources.append({"uri": rel, "format": format_to_str(CoreFormat.GLTF_BUFFER)})
        item = {
            "id": str(uuid4()),
            "type": kind,
            "name": name,
            "sources": [{"id": s["id"], "type": s["type"]} for s in sources],
            "resources": resources,
        }
        items.append(item)
        return item

    # scene reference frame: processing = (E, N, H) - origin
    srf = SceneReferenceFrame(
        BaseToTranslatedCanonicalCrsTransform(np.ones(3), -origin, swap),
        Crs(definition),
    )
    srf_item = add("scene_reference_frame", "Project CRS", [(srf, "scene_reference_frame.json")])

    # sensors (one per COLMAP camera) and cameras -----------------------------------------------
    sensors, cal_sensors = [], []
    for c in sorted(model.cameras.values(), key=lambda c: c.id):
        lens, why = lens_from_colmap(c.model, c.width, c.height, c.params)
        notes += [f"Camera {c.id}: {w}." for w in why]
        internals = PerspectiveInternals(
            np.array([lens.cx, lens.cy]), lens.focal_px, np.array(lens.radial), np.array(lens.tangential)
        )
        group = next(iter(groups.values()), {}) if len(model.cameras) == 1 else {}
        width_mm = group.get("sensorWidthMm")
        pixel_um = (
            float(width_mm) * 1000 / c.width if isinstance(width_mm, int | float) and width_mm > 0 else 1.0
        )
        if pixel_um == 1.0:
            notes.append(f"Camera {c.id}: the pixel size is not known; 1 µm is written.")
        sensors.append(
            Sensor(
                Uid64(int=c.id),
                str(group.get("model") or f"Camera {c.id}"),
                [BandInformation(w, n) for n, w in RGB_BANDS],
                np.array([c.width, c.height]),
                internals,
                pixel_um,
                ShutterType.GLOBAL,
            )
        )
        cal_sensors.append(CalibratedSensor(Uid64(int=c.id), internals))

    cam_list, captures, cal_cams = [], [], []
    names: dict[str, int] = {}
    missing = 0
    for im in sorted(model.images.values(), key=lambda i: i.id):
        ctx.check()
        if im.camera_id not in model.cameras:
            raise JobError(
                f"Image {im.name} uses camera {im.camera_id}, which the sparse model does not list."
            )
        file, item = find(im.name)
        if file is None:
            missing += 1
            uri = im.name.replace("\\", "/")
        else:
            uri = file.as_uri()
        cid = im.id
        cam_list.append(CameraData(Uid64(int=cid), uri))
        when = _time((item or {}).get("takenAt")) or fallback_time
        captures.append(
            Capture(
                Uid64(int=(1 << 40) + cid),
                [
                    Camera(
                        Uid64(int=cid),
                        ModelSource.GENERIC,
                        StaticPixelRange(0.0, 255.0),
                        PixelType.UINT8,
                        Uid64(int=im.camera_id),
                    )
                ],
                None,
                Uid64(int=cid),
                RigModelSource.NOT_APPLICABLE,
                when,
            )
        )
        r_opf, centre = colmap_to_opf(im.qvec, im.tvec)
        cal_cams.append(
            CalibratedCamera(
                Uid64(int=cid), Uid64(int=im.camera_id), np.array(opk_angles(r_opf)), centre - origin
            )
        )
        for key in (im.name, Path(im.name).name, (item or {}).get("id")):
            if isinstance(key, str):
                names.setdefault(key, cid)
    if missing:
        notes.append(
            f"{missing} photos were not found where the run read them; their names are written as given."
        )

    list_item = add("camera_list", "Photos", [(CameraList(cam_list), "camera_list.json")])
    cams_item = add(
        "input_cameras",
        "Input cameras",
        [(InputCameras(captures, sensors), "input_cameras.json")],
        (list_item,),
    )

    # control points ---------------------------------------------------------------------
    gcp_path = run_dir / "gcp.json"
    icp_item = None
    gcps_written = 0
    if gcp_path.is_file():
        doc = _json(gcp_path, "The control points file")
        gcrs_def = doc.get("crs") or manifest.get("crs")
        gdef = (
            f"EPSG:{gcrs_def['epsg']}" if isinstance(gcrs_def.get("epsg"), int) else str(gcrs_def.get("wkt"))
        )
        ginfo = read_crs(gdef)
        gswap = north_first(ginfo.horizontal)
        gcps, projected = [], []
        for p in doc.get("points") or []:
            if p.get("disabled"):
                notes.append(f"Control point {p.get('id')} is disabled and left out.")
                continue
            xyz = np.asarray(p["xyz"], dtype=np.float64)
            marks = []
            for mk in p.get("marks") or []:
                if mk.get("state") != "confirmed":
                    continue
                cid = names.get(str(mk.get("photo")))
                if cid is None:
                    continue
                marks.append(Mark(1.0, Uid64(int=cid), np.array(mk["px"], dtype=np.float64)))
            acc = p.get("accuracy") or {}
            h, v = float(acc.get("horizontalM") or 0.02), float(acc.get("verticalM") or 0.02)
            coords = xyz[[1, 0, 2]] if gswap else xyz
            gcps.append(
                Gcp(
                    str(p["id"]),
                    Geolocation(coords, Crs(gdef), np.array([h, h, v])),
                    p.get("role") == "check",
                    marks,
                )
            )
            if same_crs(ginfo.horizontal, crs):
                enh = xyz
            else:
                from rasterio.warp import transform

                xs, ys = transform(ginfo.horizontal, crs, [xyz[0]], [xyz[1]])
                enh = np.array([xs[0], ys[0], xyz[2]])
            projected.append(ProjectedGcp(str(p["id"]), enh - origin, np.array([h, h, v])))
        if gcps:
            icp_item = add(
                "input_control_points",
                "Control points",
                [(InputControlPoints(gcps, []), "input_control_points.json")],
                (list_item,),
            )
            add(
                "projected_control_points",
                "Projected control points",
                [(ProjectedControlPoints(projected), "projected_control_points.json")],
                (icp_item, srf_item),
            )
            gcps_written = len(gcps)

    # calibration ---------------------------------------------------------------------
    calibration: list[tuple[Any, str]] = [
        (CalibratedCameras(cal_cams, cal_sensors), "calibration/calibrated_cameras.json")
    ]
    tracks = 0
    if len(model.xyz):
        xyz = model.xyz
        rgb = model.rgb
        if len(xyz) > MAX_TRACKS:
            keep = np.linspace(0, len(xyz) - 1, MAX_TRACKS).astype(np.int64)
            xyz, rgb = xyz[keep], rgb[keep]
            notes.append(f"{MAX_TRACKS:,} of the {len(model.xyz):,} tie points are written.")
        node = Node()
        node.position = (xyz - origin).astype(np.float32)
        node.color = np.column_stack([rgb, np.full(len(rgb), 255, dtype=np.uint8)]).astype(np.uint8)
        node.matrix = ZUP_TO_GLTF.copy()
        pcl = GlTFPointCloud()
        pcl.nodes = [node]
        (out / "calibration").mkdir(parents=True, exist_ok=True)
        buffers = pcl.write(out / "calibration" / "tracks.gltf")
        calibration.append((None, "calibration/tracks.gltf"))
        calibration += [(None, Path(b).relative_to(out).as_posix()) for b in buffers]
        tracks = len(xyz)
    cal_item = add(
        "calibration", "Calibration", calibration, (cams_item, *([icp_item] if icp_item else []), srf_item)
    )
    for r in cal_item["resources"]:
        if r["uri"].endswith(".gltf"):
            r["format"] = format_to_str(CoreFormat.GLTF_MODEL)

    # the run's outputs, as extension items read by opf.import
    outputs = []
    taken: set[str] = set()
    for rel in (run.get("outputs") or {}).get("files") or []:
        if not isinstance(rel, str) or Path(rel).suffix.lower() not in (".tif", ".tiff"):
            continue
        role = next((r for r, rx in OUTPUT_ROLES if rx.search(Path(rel).name)), None)
        src = ctx.project / rel
        if role is None or not src.is_file():
            continue
        name = Path(rel).name
        while name in taken:
            name = f"{Path(name).stem}-2{Path(name).suffix}"
        taken.add(name)
        outputs.append({"src": str(src), "name": name, "role": role})
    for o in outputs:
        items.append(
            {
                "id": str(uuid4()),
                "type": f"ext_stratlas_{o['role']}",
                "name": "Orthomosaic" if o["role"] == "ortho" else "Digital surface model",
                "labels": [o["role"]],
                "sources": [{"id": srf_item["id"], "type": "scene_reference_frame"}],
                "resources": [{"uri": f"outputs/{o['name']}", "format": "image/tiff; application=geotiff"}],
            }
        )
    project_doc = {
        "format": "application/opf-project+json",
        "version": "1.0",
        "id": str(uuid4()),
        "name": str(manifest.get("name") or run_id)[:200],
        "description": f"Stratlas processing run {run_id}",
        "generator": {"name": GENERATOR, "version": __version__},
        "items": items,
    }
    atomic_write_json(out / "project.opf", project_doc, indent=2)
    atomic_write_json(ctx.stage("outputs.json"), outputs)

    # read it back: the check that another OPF reader can open it
    from pyopf.io import load
    from pyopf.resolve import resolve

    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        try:
            back = resolve(load(str(out / "project.opf")))
        except Exception as e:
            raise JobError(f"The written OPF project does not read back: {e}") from e
    bad = [str(w.message) for w in caught]
    if bad or back.calibration is None or back.input_cameras is None:
        raise JobError(f"The written OPF project does not read back: {'; '.join(bad) or 'items missing'}")
    if len(back.calibration.calibrated_cameras.cameras) != len(cal_cams):
        raise JobError("The written OPF project lost cameras on reading back.")
    for n in notes:
        ctx.log(n, "warn")
    ctx.log(
        f"OPF project: {len(cal_cams)} calibrated cameras, {len(sensors)} sensors, {gcps_written} control points, "
        f"{tracks:,} tie points, {len(outputs)} rasters."
    )
    return {
        "cameras": len(cal_cams),
        "sensors": len(sensors),
        "controlPoints": gcps_written,
        "tiePoints": tracks,
        "outputs": [o["name"] for o in outputs],
        "notes": notes,
    }


def _write(ctx: StepContext, out: Path, run_id: str) -> dict[str, Any]:
    staged = ctx.stage("opf/.keep").parent
    outputs = json.loads(ctx.stage("outputs.json").read_text("utf-8"))
    if out.exists() and not out.is_dir():
        raise JobError(f'"{out}" is a file; choose a folder to export to.')
    if out.is_dir() and any(out.iterdir()):
        prev = out / "project.opf"
        gen = None
        if prev.is_file():
            try:
                gen = (json.loads(prev.read_text("utf-8")).get("generator") or {}).get("name")
            except (OSError, ValueError):
                gen = None
        if gen != GENERATOR:
            raise JobError(
                f'"{out}" is not empty. Choose an empty folder, or an earlier Stratlas OPF export.'
            )
    out.mkdir(parents=True, exist_ok=True)
    files = sorted(p for p in staged.rglob("*") if p.is_file() and not p.name.startswith("."))
    total = len(files) + len(outputs)
    done = 0
    # the project file goes last, so a reader never sees a project whose files are not there yet
    for p in sorted(files, key=lambda f: f.name == "project.opf"):
        ctx.check()
        dest = out / p.relative_to(staged)
        dest.parent.mkdir(parents=True, exist_ok=True)
        if p.name == "project.opf":
            for o in outputs:
                ctx.check()
                target = out / "outputs" / o["name"]
                target.parent.mkdir(parents=True, exist_ok=True)
                tmp = target.with_name(f".{target.name}.tmp")
                shutil.copyfile(o["src"], tmp)
                tmp.replace(target)
                done += 1
                ctx.progress(done / max(1, total), f"Copied {o['name']}")
        tmp = dest.with_name(f".{dest.name}.tmp")
        shutil.copyfile(p, tmp)
        tmp.replace(dest)
        done += 1
        ctx.progress(done / max(1, total))
    ctx.log(f"Run {run_id} exported as OPF to {out}.")
    return {"out": str(out), "project": str(out / "project.opf"), "files": total}
