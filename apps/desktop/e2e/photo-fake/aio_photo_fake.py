"""E2E-only stand-ins for the photo pipelines (M10 G4), loaded into a throwaway pipeline pack.

The app's Process photos flow (wizard, progress, ground control, accuracy, refined poses, layers)
is tested end to end before streams G2 and G3 land the real ``photo.align``, ``photo.georef`` and
``photo.products``. These fakes keep the real parameter checks (they subclass the G0 stubs) and
write the files of data-conventions section 21 with synthetic values:

- ``photo.align``: ``run.json`` (aligned), ``report/align.json``, a GNSS-only
  ``report/accuracy.json``, ``cameras-sfm.json`` (the layer's poses moved a few centimetres) and
  ``sparse/``; the stages of the real pipeline, slowly enough to pause and resume.
- ``photo.georef``: residuals from the marks in ``gcp.json`` (a point named ``GCP6`` is the
  planted outlier, 1 m off), RMSE per role, checkpoints never adjusted.
- ``photo.products``: a small GLB mesh layer added to the manifest (with ``manifest.json.bak``).

Never shipped: imported by a ``.pth`` file of the e2e test's own pack (``e2e/photoPack.ts``).
``AIO_FAKE_PHOTO_STEP_S`` sets the seconds per stage (default 0.4).
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import struct
import time
from pathlib import Path
from typing import Any

from aio_pipelines.photo import align as _align
from aio_pipelines.photo import georef as _georef
from aio_pipelines.photo import products as _products
from aio_pipelines.runtime import JobError, Step, StepContext, atomic_write_bytes, atomic_write_json, now_iso

STEP_S = float(os.environ.get("AIO_FAKE_PHOTO_STEP_S", "0.4"))
IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]


def _wait(ctx: StepContext, seconds: float = STEP_S) -> None:
    """Work for a while in ten slices, reporting progress and honouring cancel."""
    for i in range(10):
        ctx.check()
        time.sleep(seconds / 10)
        ctx.progress((i + 1) / 10)
    ctx.check()


def _read(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8-sig"))


def _run_dir(ctx: StepContext, run: str) -> Path:
    return ctx.out(f"photogrammetry/{run}")


def _run_id(params: dict[str, Any]) -> str:
    run = params.get("run")
    if not isinstance(run, str) or not run:
        raise JobError("The fake photo pipelines need a run id.")
    return run


def _manifest(ctx: StepContext) -> dict[str, Any]:
    return _read(ctx.out("manifest.json"))


def _photos_layer(ctx: StepContext, source: dict[str, Any]) -> dict[str, Any] | None:
    layer = source.get("layer")
    if not layer:
        return None
    for lay in _manifest(ctx).get("layers") or []:
        if lay.get("id") == layer and lay.get("kind") == "photos":
            return lay
    raise JobError(f'There is no photos layer "{layer}" in this project.')


def _jpeg_size(path: Path) -> tuple[int, int] | None:
    """Frame size from a JPEG's SOF marker (no image library needed)."""
    try:
        data = path.read_bytes()[: 512 * 1024]
    except OSError:
        return None
    i = 2
    while i + 9 < len(data):
        if data[i] != 0xFF:
            i += 1
            continue
        marker = data[i + 1]
        if marker in (0xD8, 0x01) or 0xD0 <= marker <= 0xD7:
            i += 2
            continue
        length = struct.unpack(">H", data[i + 2 : i + 4])[0]
        if 0xC0 <= marker <= 0xCF and marker not in (0xC4, 0xC8, 0xCC):
            h, w = struct.unpack(">HH", data[i + 5 : i + 9])
            return w, h
        i += 2 + length
    return None


def _update_run(ctx: StepContext, run: str, **fields: Any) -> dict[str, Any]:
    path = _run_dir(ctx, run) / "run.json"
    data = _read(path)
    data.update(fields)
    data["updatedAt"] = now_iso()
    atomic_write_json(path, data)
    return data


def _stage(ctx: StepContext, run: str, name: str, state: str) -> None:
    path = _run_dir(ctx, run) / "run.json"
    if not path.exists():
        return
    data = _read(path)
    stages = [s for s in data.get("stages", []) if s.get("name") != name]
    stages.append({"name": name, "state": state, "finishedAt": now_iso()})
    data["stages"] = stages
    atomic_write_json(path, data)


class FakeAlign(_align.PhotoAlign):
    def plan(self, params: dict[str, Any]) -> list[Step]:
        run = _run_id(params)

        def inspect(ctx: StepContext) -> dict[str, Any]:
            layer = _photos_layer(ctx, params["photos"])
            items = (layer or {}).get("items") or []
            files: list[Path] = []
            if layer:
                files = [ctx.out(it["src"]["path"]) for it in items if "path" in it.get("src", {})]
            else:
                for folder in params["photos"].get("folders", []):
                    files += sorted(
                        p for p in Path(folder).rglob("*") if p.suffix.lower() in (".jpg", ".jpeg")
                    )
            size = next((s for s in (_jpeg_size(f) for f in files[:3]) if s), (1600, 1200))
            manifest = _manifest(ctx)
            folder = _run_dir(ctx, run)
            folder.mkdir(parents=True, exist_ok=True)
            atomic_write_json(
                folder / "run.json",
                {
                    "schema": "aio.photo-run/1",
                    "id": run,
                    "createdAt": now_iso(),
                    "status": "aligning",
                    "preset": params["preset"],
                    "photos": {"source": params["photos"], "count": len(files)},
                    "cameras": [
                        {
                            "id": "cam1",
                            "make": "Stratlas Synthetic",
                            "model": "SYN-20",
                            "widthPx": size[0],
                            "heightPx": size[1],
                            "photos": len(files),
                            "calibration": "OPENCV",
                        }
                    ],
                    "crs": params.get("crs") or manifest["crs"],
                    "heights": {"source": "orthometric", "geoid": "none", "note": "e2e fake"},
                    "settings": dict(params),
                    "stages": [],
                    "outputs": {"layers": [], "tilesets": [], "files": []},
                    "versions": {"pack": "e2e-fake"},
                    "warnings": ["Processed by the e2e stand-in pipelines, not by the real engine."],
                },
            )
            _wait(ctx)
            _stage(ctx, run, "inspect", "done")
            return {"count": len(files)}

        def work(name: str):
            def fn(ctx: StepContext) -> dict[str, Any]:
                _wait(ctx)
                _stage(ctx, run, name, "done")
                return {}

            return fn

        def report(ctx: StepContext) -> dict[str, Any]:
            folder = _run_dir(ctx, run)
            count = ctx.outputs("inspect").get("count", 0)
            layer = _photos_layer(ctx, params["photos"])
            # cameras-sfm.json in G2's shape (align.py cameras_sfm): keyed by the layer's photo id
            size = (1600, 1200)
            run_doc = _read(folder / "run.json")
            cam = (run_doc.get("cameras") or [{}])[0]
            size = (cam.get("widthPx") or size[0], cam.get("heightPx") or size[1])
            refined = []
            keyed: list[tuple[str, dict[str, Any]]] = []
            if layer:
                keyed = [(it["id"], it) for it in layer.get("items") or []]
            else:
                # a folder run is keyed by the path below its folder; the stand-in "aligns" a photo
                # by taking the pose of the project's layer photo with the same file name
                by_name = {
                    Path(it["src"]["path"]).name.lower(): it
                    for lay in _manifest(ctx).get("layers") or []
                    if lay.get("kind") == "photos"
                    for it in lay.get("items") or []
                    if "path" in it.get("src", {})
                }
                for folder_ in params["photos"].get("folders", []):
                    for p in sorted(Path(folder_).rglob("*")):
                        if p.suffix.lower() in (".jpg", ".jpeg") and p.name.lower() in by_name:
                            keyed.append((p.relative_to(folder_).as_posix(), by_name[p.name.lower()]))
            for key, it in keyed:
                if not it.get("pos"):
                    continue
                x, y, z = it["pos"]
                lens = it.get("lens") or {}
                refined.append(
                    {
                        "photo": key,
                        "pos": [x + 0.05, y - 0.02, z + 0.03],
                        "q": it.get("q") or [-0.7071068, 0.0, 0.0, 0.7071068],
                        "lens": {
                            "model": "pinhole",
                            "hfovDeg": lens.get("hfovDeg", 70.0),
                            "aspect": round(size[0] / size[1], 6),
                        },
                        "camera": "cam1",
                    }
                )
            manifest = _manifest(ctx)
            atomic_write_json(
                folder / "cameras-sfm.json",
                {
                    "run": run,
                    "crs": params.get("crs") or manifest["crs"],
                    "origin": manifest["origin"],
                    "frame": "local (data-conventions section 1: x east, y up, z south)",
                    "calibration": [
                        {
                            "id": "cam1",
                            "model": "OPENCV",
                            "width": size[0],
                            "height": size[1],
                            "params": [size[0] * 0.714, size[0] * 0.714, size[0] / 2, size[1] / 2],
                        }
                    ],
                    "cameras": refined,
                },
            )
            atomic_write_json(folder / "report" / "align.json", {"registered": count, "rejected": []})
            (folder / "sparse").mkdir(parents=True, exist_ok=True)
            atomic_write_bytes(folder / "sparse" / "README.txt", b"e2e fake sparse model\n")
            (folder / "work").mkdir(parents=True, exist_ok=True)
            atomic_write_bytes(folder / "work" / "features.bin", b"\0" * 4096)
            manifest = _manifest(ctx)
            atomic_write_json(
                folder / "report" / "accuracy.json",
                {
                    "schema": "aio.photo-accuracy/1",
                    "run": run,
                    "createdAt": now_iso(),
                    "crs": params.get("crs") or manifest["crs"],
                    "gsdCm": 2.0,
                    "images": {"total": count, "registered": count},
                    "meanReprojPx": 0.62,
                    "points": [],
                    "rmse": {},
                    "cameraResiduals": {
                        "medianM": 0.6,
                        "maxM": 1.4,
                        "rmseHorizontalM": 0.7,
                        "rmseVerticalM": 1.1,
                    },
                    "checkpointsInAdjustment": False,
                    "warnings": [],
                },
            )
            _wait(ctx)
            _stage(ctx, run, "report", "done")
            _update_run(
                ctx,
                run,
                status="aligned",
                photos={"source": params["photos"], "count": count, "registered": count},
                accuracy={"meanReprojPx": 0.62, "gsdCm": 2.0},
            )
            return {}

        return [
            Step("inspect", "Read photos", inspect),
            Step("features", "Find features", work("features")),
            Step("match", "Match photos", work("match")),
            Step("sfm", "Place cameras", work("sfm")),
            Step("georef", "Georeference", work("georef")),
            Step("report", "Report", report),
        ]


def _residual(seed: str, scale: float) -> float:
    """A deterministic residual in metres, within plus or minus `scale`."""
    h = hashlib.sha256(seed.encode()).digest()
    return (h[0] / 255 - 0.5) * 2 * scale


class FakeGeoref(_georef.PhotoGeoref):
    def plan(self, params: dict[str, Any]) -> list[Step]:
        run = _run_id(params)

        def adjust(ctx: StepContext) -> dict[str, Any]:
            folder = _run_dir(ctx, run)
            gcp_path = ctx.out(params["gcp"]) if params.get("gcp") else folder / "gcp.json"
            if not gcp_path.exists():
                raise JobError("There are no ground control points for this run. Import them first.")
            gcp = _read(gcp_path)
            points, warnings = [], []
            for p in gcp.get("points", []):
                if p.get("disabled"):
                    continue
                marks = [m for m in p.get("marks", []) if m.get("state") == "confirmed"]
                if len(marks) < 3:
                    warnings.append(
                        {
                            "code": "few-marks",
                            "message": f"{p['id']} has {len(marks)} confirmed marks; it was left out.",
                            "point": p["id"],
                        }
                    )
                    continue
                scale = 0.012 if p["role"] == "control" else 0.022
                dz = _residual(p["id"] + "z", scale * 1.5)
                if p["id"].upper() == "GCP6":
                    dz = 1.02
                    warnings.append(
                        {
                            "code": "gcp-outlier",
                            "message": f"{p['id']} is 1.0 m off; check its coordinates or marks.",
                            "point": p["id"],
                        }
                    )
                points.append(
                    {
                        "id": p["id"],
                        "role": p["role"],
                        "dxM": _residual(p["id"] + "x", scale),
                        "dyM": _residual(p["id"] + "y", scale),
                        "dzM": dz,
                        "reprojPx": 0.4 + abs(_residual(p["id"] + "r", 0.3)),
                        "marks": len(marks),
                    }
                )
            _wait(ctx)

            def rmse(role: str) -> dict[str, Any] | None:
                sel = [q for q in points if q["role"] == role]
                if not sel:
                    return None
                n = len(sel)
                return {
                    "n": n,
                    "horizontalM": (sum(q["dxM"] ** 2 + q["dyM"] ** 2 for q in sel) / n) ** 0.5,
                    "verticalM": (sum(q["dzM"] ** 2 for q in sel) / n) ** 0.5,
                }

            r = {k: v for k, v in (("control", rmse("control")), ("check", rmse("check"))) if v}
            report = _read(folder / "report" / "accuracy.json")
            report.update({"createdAt": now_iso(), "points": points, "rmse": r, "warnings": warnings})
            report["checkpointsInAdjustment"] = False
            atomic_write_json(folder / "report" / "accuracy.json", report)
            _stage(ctx, run, "adjust", "done")
            _update_run(
                ctx,
                run,
                status="adjusted",
                accuracy={"meanReprojPx": 0.55, "gsdCm": 2.0, "warnings": len(warnings), **r},
            )
            return {}

        return [Step("adjust", "Adjust with control", adjust)]


def _glb_quad(size: float) -> bytes:
    """A flat square mesh, `size` metres a side, at y = 0 in the local frame: a valid GLB."""
    h = size / 2
    pos = struct.pack("<12f", -h, 0, -h, h, 0, -h, h, 0, h, -h, 0, h)
    idx = struct.pack("<6H", 0, 2, 1, 0, 3, 2) + b"\0\0"
    binary = pos + idx
    gltf = {
        "asset": {"version": "2.0", "generator": "aio e2e fake"},
        "scene": 0,
        "scenes": [{"nodes": [0]}],
        "nodes": [{"mesh": 0, "name": "processed"}],
        "meshes": [{"primitives": [{"attributes": {"POSITION": 0}, "indices": 1}]}],
        "accessors": [
            {
                "bufferView": 0,
                "componentType": 5126,
                "count": 4,
                "type": "VEC3",
                "min": [-h, 0, -h],
                "max": [h, 0, h],
            },
            {"bufferView": 1, "componentType": 5123, "count": 6, "type": "SCALAR"},
        ],
        "bufferViews": [
            {"buffer": 0, "byteOffset": 0, "byteLength": len(pos), "target": 34962},
            {"buffer": 0, "byteOffset": len(pos), "byteLength": 12, "target": 34963},
        ],
        "buffers": [{"byteLength": len(binary)}],
    }
    js = json.dumps(gltf, separators=(",", ":")).encode()
    js += b" " * (-len(js) % 4)
    binary += b"\0" * (-len(binary) % 4)
    total = 12 + 8 + len(js) + 8 + len(binary)
    return (
        struct.pack("<4sII", b"glTF", 2, total)
        + struct.pack("<I4s", len(js), b"JSON")
        + js
        + struct.pack("<I4s", len(binary), b"BIN\0")
        + binary
    )


class FakeProducts(_products.PhotoProducts):
    def plan(self, params: dict[str, Any]) -> list[Step]:
        run = _run_id(params)
        wanted: list[str] = list(params["products"])
        names = ["dense", "fuse"] + [p for p in ("cloud", "dsm", "dtm", "ortho", "mesh") if p in wanted]

        def work(name: str):
            def fn(ctx: StepContext) -> dict[str, Any]:
                if name == "dense":
                    _update_run(ctx, run, status="processing")
                _wait(ctx)
                _stage(ctx, run, name, "done")
                return {}

            return fn

        def commit(ctx: StepContext) -> dict[str, Any]:
            folder = _run_dir(ctx, run)
            glb_rel = f"photogrammetry/{run}/mesh.glb"
            atomic_write_bytes(ctx.out(glb_rel), _glb_quad(40.0))
            layer_id = f"photo-{run}-mesh"
            layer = {
                "kind": "mesh",
                "id": layer_id,
                "name": f"Processed mesh {run}",
                "visible": True,
                "src": {"path": glb_rel},
                "transform": IDENTITY,
                **({"capture": params["capture"]} if params.get("capture") else {}),
            }
            mpath = ctx.out("manifest.json")
            manifest = _read(mpath)
            manifest["layers"] = [lay for lay in manifest.get("layers", []) if lay.get("id") != layer_id] + [
                layer
            ]
            shutil.copyfile(mpath, mpath.with_name("manifest.json.bak"))
            atomic_write_json(mpath, manifest, indent=2)
            ctx.artifact("manifest.json")
            ctx.artifact(glb_rel)
            _stage(ctx, run, "commit", "done")
            data = _read(folder / "run.json")
            outputs = data.get("outputs") or {"layers": [], "tilesets": [], "files": []}
            outputs["layers"] = sorted(set(outputs.get("layers", [])) | {layer_id})
            outputs["files"] = sorted(set(outputs.get("files", [])) | {glb_rel})
            settings = dict(data.get("settings") or {})
            settings["products"] = wanted
            _update_run(ctx, run, status="done", outputs=outputs, settings=settings)
            return {}

        return [Step(n, n.title(), work(n)) for n in names] + [Step("commit", "Add layers", commit)]


_align.PhotoAlign = FakeAlign  # type: ignore[misc]
_georef.PhotoGeoref = FakeGeoref  # type: ignore[misc]
_products.PhotoProducts = FakeProducts  # type: ignore[misc]
