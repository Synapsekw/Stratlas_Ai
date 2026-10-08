"""opf.import: an OPF project (Pix4D or any OPF 1.x writer) into the open Stratlas project.

Parameters as ``OpfImportParams`` in ``@aio/schema``: ``src`` (the ``.opf`` file, read only),
``products`` (outputs to bring in: ``cloud``, ``ortho``, ``dsm``, ``mesh``; default all) and
``photosRoot`` (the photos folder when the OPF's own photo paths do not resolve).

What comes in (data-conventions section 21; no new layer kind, format or field):

- a **processing run** ``photogrammetry/<run>/`` as if Stratlas had aligned the photos itself:
  ``run.json`` (``aio.photo-run/1``; its photos source is the folders the originals were found
  in, read in place), ``sparse/`` as ``photo.align`` writes it (``write_run_sparse``: a COLMAP
  text model in the run's grid frame, the project CRS minus the manifest origin, with
  ``frame.json`` and ``photos.json``; perspective sensors as ``OPENCV``/``FULL_OPENCV``, the
  calibrated poses, the tie points), so ``photo.products`` and ``photo.georef`` take an imported
  run like their own, ``gcp.json`` (``aio.gcp/1``:
  control and check points, marks ``by: import``, confirmed) and ``report/opf-import.json`` (what
  came in, what was left out and why);
- a **photos layer** of review copies (2560 px, ``photos/<run>/``) placed by the calibrated poses
  (``pos``, ``q``, a pinhole ``lens``); photos without calibration by their position only;
- **outputs** when present (``outputs.py``): OPF glTF point clouds as COPC layers, orthomosaic and
  DSM GeoTIFFs as COG copies in the run folder and ``kit-pyramid`` raster layers. Meshes are not
  part of OPF 1.0 and are listed as not imported.

Every file the OPF names is checked before pyopf reads it (``safety.py``). Photos are read where
they are and never written. The manifest is written last, with ``manifest.json.bak``.
"""

from __future__ import annotations

import json
import re
import shutil
from datetime import UTC, datetime
from pathlib import Path, PurePosixPath
from typing import Any
from urllib.parse import unquote, urlparse

from .. import __version__
from ..params import known_keys, text
from ..runtime import (
    JobError,
    Step,
    StepContext,
    atomic_write_json,
    commit_files,
    commit_tree,
    now_iso,
    safe_project_path,
)

PRODUCTS = ("cloud", "ortho", "dsm", "mesh")
REVIEW_EDGE = 2560
SPARSE_FILES = ("cameras.txt", "images.txt", "points3D.txt", "frame.json", "photos.json")


def write_run_sparse(folder: Path, model: Any, manifest: dict[str, Any], plan: dict[str, Any]) -> None:
    """The imported model as ``photo.align`` writes a run's ``sparse/``: COLMAP text in the grid
    frame (project CRS minus the manifest origin, or a rounded centre of the cameras when the
    project has none), image names as photo keys (``align.encode_name``), with ``frame.json`` and
    ``photos.json`` (each photo key's file as ``imageRoot`` plus ``name``)."""
    import os

    import numpy as np

    from ..photo import crs as C
    from ..photo.align import LIST_SCHEMA, encode_name, frame_record
    from ..photo.model import qvec_to_rotmat
    from . import colmap
    from .geometry import project_crs

    crs = project_crs(manifest)
    o = manifest.get("origin")
    if isinstance(o, list) and len(o) == 3 and all(isinstance(v, int | float) for v in o):
        origin = np.array(o, dtype=np.float64)
    else:
        centres = [
            -qvec_to_rotmat(im.qvec).T @ np.asarray(im.tvec, dtype=np.float64) for im in model.images.values()
        ]
        pts = np.array(centres) if centres else np.asarray(model.xyz).reshape(-1, 3)
        origin = np.round(np.median(pts, axis=0)) if len(pts) else np.zeros(3)
    shifted = colmap.Model(cameras=dict(model.cameras))
    for iid, im in model.images.items():
        R = qvec_to_rotmat(im.qvec)
        t = np.asarray(im.tvec, dtype=np.float64) + R @ origin  # x_cam = R (X' + origin) + t
        shifted.images[iid] = colmap.Image(
            iid, list(im.qvec), [float(v) for v in t], im.camera_id, encode_name(im.name)
        )
    if len(model.xyz):
        shifted.xyz = np.asarray(model.xyz, dtype=np.float64) - origin
        shifted.rgb, shifted.error = model.rgb, model.error
    colmap.write_text(folder, shifted)
    grid = C.GridFrame(crs, tuple(float(v) for v in origin))
    lon, lat, _ = grid.to_geodetic([[0.0, 0.0, 0.0]])
    enu = C.EnuFrame(float(lon[0]), float(lat[0]), float(origin[2]))
    atomic_write_json(folder / "frame.json", frame_record(grid, enu, plan.get("heights") or {}, True))
    found = [p for p in plan["photos"] if p.get("file")]
    root = None
    if found:
        try:
            root = Path(os.path.commonpath([str(Path(p["file"]).parent) for p in found]))
        except ValueError:  # photos on several drives: each by its full path
            root = None
    photos: dict[str, Any] = {}
    for p in found:
        f = Path(p["file"])
        rec: dict[str, Any] = {"name": f.relative_to(root).as_posix() if root else f.as_posix()}
        if p.get("size"):
            rec["width"], rec["height"] = int(p["size"][0]), int(p["size"][1])
        photos[p["name"]] = rec
    atomic_write_json(
        folder / "photos.json",
        {"schema": LIST_SCHEMA, "imageRoot": str(root) if root else "", "photos": photos},
    )


def read_manifest(project: Path) -> dict[str, Any]:
    p = project / "manifest.json"
    try:
        m = json.loads(p.read_text("utf-8"))
    except (OSError, ValueError) as e:
        raise JobError(f"Could not read the project manifest {p}: {e}") from e
    if not isinstance(m, dict):
        raise JobError(f"{p} is not a project manifest.")
    return m


def uniq(base: str, taken: set[str]) -> str:
    out, n = base, 2
    while out in taken:
        out, n = f"{base}-{n}", n + 1
    taken.add(out)
    return out


# ---------------------------------------------------------------- photos


def _uri_path(uri: str) -> tuple[str | None, str]:
    """(kind, path) of a photo URI: kind None for a relative reference, ``abs`` for a file path."""
    u = uri.strip().split("#", 1)[0]
    if re.match(r"^[A-Za-z]:[\\/]", u):
        return "abs", u.replace("\\", "/")
    p = urlparse(u)
    if p.scheme == "file":
        path = unquote(p.path)
        return "abs", path[1:] if re.match(r"^/[A-Za-z]:/", path) else path
    if p.scheme or p.netloc:
        return p.scheme or "net", u
    path = unquote(p.path).replace("\\", "/")
    return ("abs" if path.startswith("/") else None), path


def is_relative_photo(uri: str) -> bool:
    kind, path = _uri_path(uri)
    return kind is None and ".." not in PurePosixPath(path).parts


def resolve_photo(uri: str, opf_dir: Path, photos_root: Path | None) -> tuple[Path | None, Path | None, str]:
    """Find a photo: (file, the folder it was found in, why not when it was not found).

    A relative URI inside the OPF folder is read there. Anything else (absolute, ``..``, missing)
    is looked up in the chosen photos folder by its trailing path parts, longest first, and never
    outside that folder. Network URIs are never followed.
    """
    from .safety import inside, relative_uri

    kind, path = _uri_path(uri)
    if kind not in (None, "abs"):
        return None, None, "the photo is not a local file; network files are never read"
    rel = relative_uri(path) if kind is None else None
    if rel is not None:
        full = inside(opf_dir, rel)
        if full is not None and full.is_file():
            return full, opf_dir, ""
    if photos_root is not None:
        parts = [
            p
            for p in PurePosixPath(path).parts
            if p not in ("/", "..", ".") and not re.match(r"^[A-Za-z]:$", p)
        ]
        for k in range(len(parts)):
            cand = inside(photos_root, "/".join(parts[k:]))
            if cand is not None and cand.is_file():
                return cand, photos_root.resolve(), ""
        return None, None, f"not found in the photos folder ({PurePosixPath(path).name})"
    if rel is None:
        return None, None, "an absolute path or outside the OPF folder: choose the photos folder to read it"
    return None, None, "missing next to the OPF project"


# ---------------------------------------------------------------- the pipeline


class OpfImport:
    name = "opf.import"
    title = "OPF import"
    description = "An Open Photogrammetry Format project: cameras, control points and outputs."
    keys = frozenset({"src", "products", "photosRoot"})

    def validate(self, params: dict[str, Any]) -> dict[str, Any]:
        known_keys(params, set(self.keys), self.name)
        src = text(params, "src", required=True)
        assert src is not None
        if Path(src).suffix.lower() not in (".opf", ".json"):
            raise JobError(f'"{Path(src).name}" is not an OPF project. Choose the .opf file of the project.')
        out: dict[str, Any] = {"src": src}
        products = params.get("products")
        if products is not None:
            if (
                not isinstance(products, list)
                or not products
                or any(not isinstance(p, str) or p not in PRODUCTS for p in products)
            ):
                raise JobError(f"products must be one of: {', '.join(sorted(PRODUCTS))}.")
            out["products"] = sorted(set(products))
        root = text(params, "photosRoot")
        if root is not None:
            out["photosRoot"] = root
        return out

    def inputs(self, params: dict[str, Any]) -> list[str]:
        out = [params["src"]]
        if params.get("photosRoot"):
            out.append(params["photosRoot"])
        return out

    def plan(self, params: dict[str, Any]) -> list[Step]:
        want = set(params.get("products") or PRODUCTS)

        def load_plan(ctx: StepContext) -> dict[str, Any]:
            return json.loads(ctx.stage("plan.json").read_text("utf-8"))

        def read(ctx: StepContext) -> dict[str, Any]:
            from .reader import read_opf

            src = ctx.input(params["src"])
            root = params.get("photosRoot")
            photos_root = ctx.input(root).resolve() if root else None
            if photos_root is not None and not photos_root.is_dir():
                raise JobError(f'The photos folder "{root}" is not a folder.')
            m = read_manifest(ctx.project)
            runs = ctx.project / "photogrammetry"
            taken = {p.name for p in runs.iterdir()} if runs.is_dir() else set()
            run = uniq(f"opf-{datetime.now(UTC).strftime('%Y%m%d-%H%M')}", taken)
            plan, model = read_opf(src, photos_root, m, want, ctx.check)
            write_run_sparse(ctx.stage("run/sparse/.keep").parent, model, m, plan)
            atomic_write_json(ctx.stage("plan.json"), plan, indent=None)
            s = plan["summary"]
            ctx.log(
                f"{src.name}: {s['cameras']} cameras ({s['calibrated']} calibrated), {s['photosFound']} photos "
                f"found, {len(plan['gcp']['points']) if plan['gcp'] else 0} control points, "
                f"{len(plan['clouds'])} point clouds, {len(plan['rasters'])} rasters."
            )
            for w in plan["warnings"]:
                ctx.log(w, "warn")
            return {"run": run, **s}

        def photos(ctx: StepContext) -> dict[str, Any]:
            from ..aik.cameras import review_copy

            plan = load_plan(ctx)
            todo = [p for p in plan["photos"] if p.get("file")]
            failed = []
            odd = 0
            for i, p in enumerate(todo):
                ctx.check()
                dest = ctx.stage(f"photos/{p['id']}.jpg")
                if not dest.exists():
                    tmp = dest.with_name(f".{dest.stem}.tmp.jpg")
                    try:
                        size = review_copy(Path(p["file"]), tmp, REVIEW_EDGE)
                        tmp.replace(dest)
                        want_size = p.get("size")
                        if want_size and abs(size[0] / size[1] - want_size[0] / want_size[1]) > 0.01:
                            odd += 1
                            ctx.log(
                                f"{p['name']} is {size[0]} x {size[1]} px but its sensor is "
                                f"{want_size[0]} x {want_size[1]}: check the photo's orientation.",
                                "warn",
                            )
                    except Exception as e:  # one unreadable photo is left out, never the import
                        tmp.unlink(missing_ok=True)
                        failed.append({"name": p["name"], "reason": f"could not be read: {e}"[:300]})
                        continue
                ctx.progress((i + 1) / max(1, len(todo)), f"Review copies {i + 1} of {len(todo)}")
            atomic_write_json(ctx.stage("photos-failed.json"), failed)
            if failed:
                ctx.log(f"{len(failed)} photos could not be read and are left out.", "warn")
            return {"copies": len(todo) - len(failed), "failed": len(failed), "otherShape": odd}

        def cloud(ctx: StepContext) -> dict[str, Any]:
            from .outputs import import_clouds

            return {"clouds": import_clouds(ctx, load_plan(ctx), ctx.outputs("read")["run"])}

        def rasters(ctx: StepContext) -> dict[str, Any]:
            from .outputs import import_rasters

            return {"rasters": import_rasters(ctx, load_plan(ctx), ctx.outputs("read")["run"])}

        def commit(ctx: StepContext) -> dict[str, Any]:
            return _commit(ctx, load_plan(ctx), params)

        return [
            Step("read", "Read and check the OPF project", read, weight=2),
            Step("photos", "Make review copies of the photos", photos, weight=6),
            Step("cloud", "Convert point clouds", cloud, weight=4),
            Step("rasters", "Tile orthomosaics and surfaces", rasters, weight=4),
            Step("commit", "Add the run and layers to the project", commit, weight=0.5),
        ]


def _commit(ctx: StepContext, plan: dict[str, Any], params: dict[str, Any]) -> dict[str, Any]:
    run = ctx.outputs("read")["run"]
    run_dir = f"photogrammetry/{run}"
    failed = json.loads(ctx.stage("photos-failed.json").read_text("utf-8"))
    failed_names = {f["name"] for f in failed}
    outputs = (ctx.outputs("cloud").get("clouds") or []) + (ctx.outputs("rasters").get("rasters") or [])
    skipped_outputs = [o for o in outputs if o.get("skipped")]
    mpath = safe_project_path(ctx.project, "manifest.json")
    manifest = read_manifest(ctx.project)
    layers = manifest.setdefault("layers", [])
    # a commit that stopped after the manifest was written runs again: its own layers (named after
    # the run, which did not exist before this job) are replaced, never added twice
    ours = tuple(f"{kind}-{run}" for kind in ("photos", "cloud", "ortho", "dsm"))
    layers[:] = [x for x in layers if not (isinstance(x, dict) and str(x.get("id", "")).startswith(ours))]
    taken = {str(layer.get("id")) for layer in layers if isinstance(layer, dict)}

    files = [f"{run_dir}/sparse/{n}" for n in SPARSE_FILES]
    moves = [(f"run/sparse/{n}", f"{run_dir}/sparse/{n}") for n in SPARSE_FILES]
    trees: list[tuple[str, str]] = []
    if plan["gcp"]:
        atomic_write_json(ctx.stage("run/gcp.json"), plan["gcp"])
        moves.append(("run/gcp.json", f"{run_dir}/gcp.json"))

    new_layers: list[dict[str, Any]] = []
    items = []
    for p in plan["photos"]:
        if not p.get("file") or p["name"] in failed_names:
            continue
        rel = f"photos/{run}/{p['id']}.jpg"
        moves.append((f"photos/{p['id']}.jpg", rel))
        items.append(
            {
                "id": p["id"],
                "src": {"path": rel},
                **{k: p[k] for k in ("takenAt", "pos", "q", "lens") if k in p},
            }
        )
    photos_layer = None
    if items:
        photos_layer = uniq(f"photos-{run}", taken)
        new_layers.append(
            {
                "kind": "photos",
                "id": photos_layer,
                "name": f"{plan['name']} photos (OPF)",
                "visible": True,
                "items": items,
            }
        )
    for o in outputs:
        if o.get("skipped"):
            continue
        lid = uniq(o["layer"], taken)
        if "staged" in o:  # a point cloud
            moves.append((o["staged"], o["path"]))
            files.append(o["path"])
            new_layers.append(
                {
                    "kind": "pointcloud",
                    "id": lid,
                    "name": o["name"],
                    "visible": True,
                    "src": {"path": o["path"]},
                    "format": "copc",
                    "pointCount": o["points"],
                }
            )
            continue
        moves.append((o["cog"], f"{run_dir}/{o['cogName']}"))
        files.append(f"{run_dir}/{o['cogName']}")
        if o.get("grid"):
            moves.append((o["grid"]["png"], f"sources/{lid}.png"))
            atomic_write_json(ctx.stage(f"grids/{lid}.json"), {**o["grid"]["json"], "file": f"{lid}.png"})
            moves.append((f"grids/{lid}.json", f"sources/{lid}.json"))
        tiles = o["tiles"]
        for level in tiles["levels"]:
            level["pattern"] = f"rasters/{lid}/{level['z']}/{{x}}_{{y}}.webp"
        trees.append((o["pyramid"], f"rasters/{lid}"))
        atomic_write_json(ctx.stage(f"tiles/{lid}.json"), tiles)
        moves.append((f"tiles/{lid}.json", f"rasters/{lid}/tiles.json"))
        new_layers.append(
            {
                "kind": "raster",
                "id": lid,
                "name": o["name"],
                "visible": True,
                "src": {"path": f"rasters/{lid}/tiles.json"},
                "role": o["role"],
                "format": "kit-pyramid",
            }
        )

    rejected = [{"name": s["name"], "reason": s["reason"]} for s in plan["skipped"]] + failed
    skipped = (
        plan["skippedItems"]
        + [{"what": o["what"], "reason": o["reason"]} for o in skipped_outputs]
        + [{"what": f"photo {r['name']}", "reason": r["reason"]} for r in rejected]
    )
    calibrated = plan["summary"]["calibrated"]
    run_json = {
        "schema": "aio.photo-run/1",
        "id": run,
        "createdAt": now_iso(),
        "updatedAt": now_iso(),
        "status": plan["status"],
        "preset": "standard",
        "photos": {
            "source": {"folders": plan["folders"] or [str(Path(params["src"]).parent)]},
            "count": plan["summary"]["cameras"],
            "registered": calibrated,
            "rejected": rejected[:100_000],
        },
        "cameras": plan["groups"],
        "crs": manifest.get("crs"),
        **({"heights": plan["heights"]} if plan.get("heights") else {}),
        "settings": {
            "opf": {"src": Path(params["src"]).name, "products": sorted(params.get("products") or PRODUCTS)}
        },
        "stages": [
            {"name": "inspect", "state": "done", "message": "Read from the OPF project"},
            {
                "name": "sfm",
                "state": "done" if calibrated else "pending",
                "message": f"Calibration imported from OPF ({plan['generator']})"
                if calibrated
                else "The OPF project has no calibration",
            },
            {"name": "commit", "state": "done"},
        ],
        "outputs": {"layers": [layer["id"] for layer in new_layers], "tilesets": [], "files": files[:256]},
        "versions": {"pack": __version__, **plan["versions"]},
        "warnings": [w[:500] for w in plan["warnings"]][:1000],
    }
    report = {
        "run": run,
        "src": Path(params["src"]).name,
        "createdAt": now_iso(),
        "opf": {"name": plan["name"], "generator": plan["generator"], "version": plan["versions"].get("opf")},
        "imported": {
            "photos": len(items),
            "calibrated": calibrated,
            "controlPoints": len(plan["gcp"]["points"]) if plan["gcp"] else 0,
            "tiePoints": plan["summary"]["tiePoints"],
            "layers": [layer["id"] for layer in new_layers],
        },
        "skipped": skipped,
        "warnings": plan["warnings"],
    }
    atomic_write_json(ctx.stage("run/report/opf-import.json"), report)
    moves.append(("run/report/opf-import.json", f"{run_dir}/report/opf-import.json"))
    commit_files(ctx, moves, announce=False)
    for staged, dest in trees:
        commit_tree(ctx, staged, dest)
    # the run file, then the manifest, go last
    atomic_write_json(ctx.stage("run/run.json"), run_json)
    commit_files(ctx, [("run/run.json", f"{run_dir}/run.json")])
    if new_layers:
        layers.extend(new_layers)
        shutil.copyfile(mpath, mpath.with_name("manifest.json.bak"))
        atomic_write_json(mpath, manifest, indent=2)
        ctx.artifact("manifest.json")
    for s in skipped:
        ctx.log(f"Not imported: {s['what']} ({s['reason']}).", "warn")
    ctx.log(f"Run {run}: {len(items)} photos, {len(new_layers)} layers added.")
    return {
        "run": run,
        "photosLayer": photos_layer,
        "layers": [layer["id"] for layer in new_layers],
        "photos": len(items),
        "skipped": len(skipped),
        "runFile": f"{run_dir}/run.json",
    }
