"""photo.georef: ODM aligns again with ground control; checkpoints measured by us, never used.

Stages (resumable job steps): ``adjust``, ``report``, ``commit``.

    adjust   writes ``gcp_list.txt`` (confirmed marks of the control points that are not switched
             off or outliers) and has ODM align again with it. Control points that disagree with
             the others (triangulated through the run's current cameras) are named and left out
             (``gcp.control_outliers``). ``useGnss`` (default) passes ``--force-gps`` so the photo
             positions count beside the control points; without it ODM uses the control points
             only. Align's ``geo.txt`` is never changed. ODM's own GCP errors (OpenSfM's
             ``stats/stats.json``) go to the job log.
    report   measures every point, control and check, through ODM's adjusted cameras;
             report/accuracy.json (``checkpointsInAdjustment`` false), mark predictions, the
             adjusted ``sparse/`` and ``cameras-sfm.json``
    commit   into ``photogrammetry/<run>/``; the GNSS-only model is kept as ``work/sparse-gnss/``;
             ODM's GCP errors of this adjustment as ``report/odm-stats.json`` (an older copy goes)

Checkpoints never reach ODM: they are left out of ``gcp_list.txt``, so the adjusted cameras are
identical with and without them (tested).
"""

from __future__ import annotations

import contextlib
import hashlib
import json
import shutil
from typing import Any

import numpy as np

from ..params import known_keys
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
from . import accuracy as A
from . import bundle as B
from . import crs as C
from . import gcp as G
from .align import (
    RUN_ID,
    RunState,
    cameras_sfm,
    enu_to_grid_model,
    grid_to_enu_model,
    merge_predictions,
    read_sparse,
    run_dir,
    staged,
    write_sparse,
)
from .model import SparseModel
from .odm import flags as OF
from .odm import project as OP
from .odm import runner as OR
from .odm.reconstruction import read_reconstruction

#: A drone GNSS height this far from the control-adjusted cameras is flagged.
GNSS_HEIGHT_LIMIT_M = A.GNSS_HEIGHT_LIMIT_M


def _frames(frame: dict[str, Any]) -> tuple[C.EnuFrame, C.GridFrame]:
    e = frame["enu"]
    return C.EnuFrame(e["lon"], e["lat"], e["h"]), C.GridFrame(C.crs_of(frame["crs"]), tuple(frame["origin"]))


def _measure(model: SparseModel, points: list[dict[str, Any]], by_name: dict[str, int]):
    """Each point with two or more confirmed marks in aligned photos, triangulated (ENU)."""
    out: dict[str, tuple[np.ndarray, float, int]] = {}
    short: dict[str, int] = {}
    for p in points:
        marks = [(by_name[ph], xy) for ph, xy in G.usable_marks(p) if ph in by_name]
        if len(marks) < 2:
            short[p["id"]] = len(marks)
            continue
        X, err = B.triangulate(model, marks)
        out[p["id"]] = (X, err, len(marks))
    return out, short


def _sha1(path) -> str:
    return hashlib.sha1(path.read_bytes()).hexdigest()


class PhotoGeoref:
    name = "photo.georef"
    title = "Adjust with ground control"
    description = "ODM aligns the photos again with marked control points; then the accuracy report."
    keys = frozenset({"run", "gcp", "useGnss"})

    def validate(self, params: dict[str, Any]) -> dict[str, Any]:
        known_keys(params, set(self.keys), self.name)
        if params.get("run") is None:
            raise JobError(f"{self.name} needs: run.")
        if not (isinstance(params["run"], str) and RUN_ID.match(params["run"])):
            raise JobError("run must be letters, digits, dot, dash or _.")
        if params.get("gcp") is not None and not (isinstance(params["gcp"], str) and params["gcp"]):
            raise JobError("gcp must be a project path.")
        if params.get("useGnss") is not None and not isinstance(params["useGnss"], bool):
            raise JobError("useGnss must be true or false.")
        return dict(params)

    def inputs(self, params: dict[str, Any]) -> list[str]:
        return [self._gcp_rel(params), f"{run_dir(params['run'])}/sparse"]

    @staticmethod
    def _gcp_rel(params: dict[str, Any]) -> str:
        return params.get("gcp") or f"{run_dir(params['run'])}/gcp.json"

    def plan(self, params: dict[str, Any]) -> list[Step]:
        return [
            Step("adjust", "Adjust with ground control", staged("adjust", self._adjust), 3.0),
            Step("report", "Accuracy report", staged("report", self._report), 1.0),
            Step("commit", "Save the run", staged("commit", self._commit), 0.2),
        ]

    # ---- adjust
    def _adjust(self, ctx: StepContext) -> dict[str, Any]:
        params = ctx.params
        run = params["run"]
        base = ctx.project / run_dir(run)
        try:
            state = json.loads((base / "run.json").read_text("utf-8"))
        except (OSError, ValueError) as e:
            raise JobError(f'Run "{run}" has no run.json; align the photos first.') from e
        if state.get("status") not in ("aligned", "adjusted", "done"):
            raise JobError(f'Run "{run}" is not aligned yet ({state.get("status")}).')
        gcp = G.read_gcp_file(safe_project_path(ctx.project, self._gcp_rel(params)))
        grid_model, frame = read_sparse(base / "sparse")
        enu, grid = _frames(frame)
        geo = G.points_to_geodetic(gcp)
        surveyed = {
            p["id"]: enu.from_geodetic([geo[p["id"]][0]], [geo[p["id"]][1]], [geo[p["id"]][2]])[0]
            for p in gcp.get("points") or []
        }
        control = [p for p in gcp.get("points") or [] if p["role"] == "control" and not p.get("disabled")]
        odm_dir = OP.run_odm_dir(ctx.project, run)
        names = OP.read_names(odm_dir)
        links_by_key = {key: link for link, key in names.items()}
        model = grid_to_enu_model(grid_model, enu, grid)
        by_name = {im.name: im.id for im in model.images.values()}
        measured, short = _measure(model, control, by_name)
        sigma = {
            p["id"]: (p["accuracy"]["horizontalM"], p["accuracy"]["verticalM"])
            for p in control
            if p["id"] in measured
        }
        outliers = (
            G.control_outliers({i: measured[i][0] for i in sigma}, {i: surveyed[i] for i in sigma}, sigma)
            if len(sigma) >= 4
            else []
        )
        out_ids = {o.id for o in outliers}
        warnings: list[dict[str, Any]] = []
        for o in outliers:
            warnings.append(
                {
                    "code": "gcp-outlier",
                    "message": f"{o.id} is {o.distance_m:.2f} m off the other control points; it is left out of the "
                    "adjustment. Check its coordinates or marks.",
                    "point": o.id,
                }
            )
            ctx.log(warnings[-1]["message"], "warn")
        gcp_list = OP.write_gcp_list(odm_dir, gcp, links_by_key, out_ids)
        # with ground control ODM leaves the photo positions out of its adjustment unless forced;
        # align's geo.txt (PPK positions, converted heights) is passed as it is either way
        use_gnss = params.get("useGnss", True) is not False
        geo_txt = odm_dir / "geo.txt"
        odm, mc = OR.find_odm(), OR.machine()
        log_dir = ctx.project / run_dir(run) / "odm-logs" / f"{ctx.job.job_id}-adjust"
        strategy = OF.GEOREF_STRATEGY
        # C12: a first attempt removes the alignment so ODM runs it again; a resumed one keeps it,
        # unless the control it would use changed since (the stamp of the gcp_list.txt it was given)
        stamp, digest = log_dir / "gcp_list.sha1", _sha1(gcp_list.path)
        attempts = sorted(log_dir.glob("tool*.out")) if log_dir.is_dir() else []  # run_odm's own output files
        resumed = (log_dir / "odm.log").exists() or bool(attempts)
        same = resumed and stamp.is_file() and stamp.read_text("utf-8").strip() == digest
        if strategy == "invalidate" and not same:
            OP.invalidate(odm_dir, OP.GEOREF_INVALIDATE)
            if resumed:  # ODM's earlier stages would count as done for this attempt
                for path in (log_dir / "odm.log", *attempts):
                    with contextlib.suppress(OSError):
                        path.unlink()
        log_dir.mkdir(parents=True, exist_ok=True)
        stamp.write_text(digest, "utf-8")
        flags = OF.georef_flags(
            state.get("preset") or "standard", mc.use_gpu, mc.threads, gcp_list.path,
            geo_txt if geo_txt.is_file() else None,
        )  # fmt: skip
        if use_gnss:
            flags.append("--force-gps")
        res = OR.run_odm(
            ctx, odm, odm_dir, flags, "opensfm", "opensfm", log_dir,
            rerun=strategy == "rerun-from", use_gpu=mc.use_gpu, progress=(0.0, 0.9),
        )  # fmt: skip
        rec = read_reconstruction(odm_dir, names, enu)
        rec.model.save_npz(ctx.stage("work/adjusted-enu.npz"))
        gcp_stats = (rec.stats or {}).get("gcp_errors")
        if gcp_stats:
            ctx.log(f"ODM's own ground control errors: {json.dumps(gcp_stats)[:1500]}")
            atomic_write_json(ctx.stage("out/report/odm-stats.json"), {"gcp_errors": gcp_stats})
        else:
            ctx.stage("out/report/odm-stats.json").unlink(missing_ok=True)  # from an earlier attempt
        atomic_write_json(
            ctx.stage("work/adjust.json"),
            {
                "warnings": warnings,
                "outliers": sorted(out_ids),
                "used": gcp_list.points,
                "short": short,
                "gnss": use_gnss,
                "gnssShiftEnuM": [0.0, 0.0, 0.0],
                "iterations": 0,
                "odm": {"gcpPoints": gcp_list.points, "stats": gcp_stats},
                "stats": {"reprojPx": rec.reproj_px, "gsdCm": rec.gsd_cm},
            },
        )
        st = RunState(ctx)
        data = st.load() or dict(state)
        stage_names = [s["name"] for s in data.get("stages", [])]
        for s in ("adjust", "report"):
            if s not in stage_names:
                data.setdefault("stages", []).append({"name": s, "state": "pending"})
        data["stages"] = [
            {**s, "state": "running", "startedAt": now_iso()} if s["name"] == "adjust" else s
            for s in data["stages"]
        ]
        data["engine"] = OR.engine_record(odm, res.gpu)
        st.save(data)
        return {"controls": len(gcp_list.points), "outliers": len(outliers), "gnss": use_gnss}

    # ---- report
    def _report(self, ctx: StepContext) -> dict[str, Any]:
        params = ctx.params
        run = params["run"]
        base = ctx.project / run_dir(run)
        state = RunState(ctx).load()
        gcp = G.read_gcp_file(safe_project_path(ctx.project, self._gcp_rel(params)))
        _, frame = read_sparse(base / "sparse")
        enu, grid = _frames(frame)
        adj = json.loads(ctx.stage("work/adjust.json").read_text("utf-8"))
        model = SparseModel.load(ctx.stage("work/adjusted-enu.npz"))
        by_name = {im.name: im.id for im in model.images.values()}
        geo = G.points_to_geodetic(gcp)
        pts = [p for p in gcp.get("points") or [] if not p.get("disabled")]
        measured, short = _measure(model, pts, by_name)
        used = set(adj["used"])
        residuals: list[A.PointResidual] = []
        surveyed_enu: dict[str, np.ndarray] = {}
        for p in gcp.get("points") or []:
            lon, lat, h = geo[p["id"]]
            surveyed_enu[p["id"]] = enu.from_geodetic([lon], [lat], [h])[0]
            if p["id"] not in measured:
                continue
            X, err, n = measured[p["id"]]
            d = grid.from_geodetic(*enu.to_geodetic(X[None]))[0] - grid.from_geodetic([lon], [lat], [h])[0]
            residuals.append(A.PointResidual(p["id"], p["role"], d, err, n, used=p["id"] in used))
        stats = adj.get("stats") or {}  # ODM's model has no observations: its figures come from ODM
        gsd = stats.get("gsdCm")
        warnings = [A.Warning_(w["code"], w["message"], w.get("point")) for w in adj["warnings"]]
        warnings += A.point_warnings(residuals, (gsd or 0) / 100)
        warnings += A.unmeasured_warnings(
            [A.PointResidual(i, "control", np.zeros(3), 0.0, n) for i, n in short.items()]
        )
        grid_model = enu_to_grid_model(model, enu, grid)
        # cameras against their GNSS positions (and the vertical datum check on heights)
        try:
            photos = json.loads((base / "sparse" / "photos.json").read_text("utf-8"))["photos"]
        except (OSError, ValueError, KeyError):
            photos = {}
        ids = [iid for iid, im in grid_model.images.items() if (photos.get(im.name) or {}).get("gnss")]
        cam_res = None
        if ids:
            gn = [photos[grid_model.images[i].name]["gnss"] for i in ids]
            g_grid = grid.from_geodetic([g["lon"] for g in gn], [g["lat"] for g in gn], [g["h"] for g in gn])
            c_grid = np.array([grid_model.images[i].centre for i in ids])
            cam_res = A.camera_residuals(c_grid, g_grid)
            dz = float(np.median(c_grid[:, 2] - g_grid[:, 2]))
            if abs(dz) > GNSS_HEIGHT_LIMIT_M and len(used) >= 3:
                warnings.append(
                    A.Warning_(
                        "gnss-height",
                        f"The drone's GNSS heights are {dz:+.2f} m off the ground control (median). Set the project's "
                        "vertical datum, or keep using ground control for heights.",
                    )
                )
        rep = A.report(
            A.ReportInput(
                run=run,
                created_at=now_iso(),
                crs=state.get("crs") or C.crs_record(grid.crs),
                heights=state.get("heights"),
                images_total=int((state.get("photos") or {}).get("count", len(model.images))),
                images_registered=len(model.images),
                mean_reproj_px=float(stats.get("reprojPx") or 0.0),
                gsd_cm=gsd,
                points=residuals,
                cameras=cam_res,
                warnings=warnings,
            )
        )
        atomic_write_json(ctx.stage("out/report/accuracy.json"), rep)
        write_sparse(ctx.stage("out/sparse/.keep").parent, grid_model, grid, enu, frame.get("heights") or {})
        info = {"names": {}}
        cam_state = {**state, "frames": {"origin": list(grid.origin)}}
        atomic_write_json(ctx.stage("out/cameras-sfm.json"), cameras_sfm(grid_model, cam_state, info))
        if (base / "sparse" / "photos.json").is_file():
            atomic_write_json(
                ctx.stage("out/sparse/photos.json"),
                json.loads((base / "sparse" / "photos.json").read_text("utf-8")),
            )
        sigma = max(0.02, float((rep["rmse"].get("control") or {}).get("verticalM", 0.05)))
        preds = G.predict_marks(model, surveyed_enu, sigma)
        atomic_write_json(ctx.stage("work/predictions.json"), preds)
        data = RunState(ctx).load()
        data["accuracy"] = A.summary(rep)
        if not frame.get("georeferenced", True):
            data.setdefault("warnings", []).append("Georeferenced by ground control only.")
        RunState(ctx).save(data)
        return {"points": len(residuals), "warnings": len(rep["warnings"])}

    # ---- commit
    def _commit(self, ctx: StepContext) -> dict[str, Any]:
        run = ctx.params["run"]
        base = run_dir(run)
        project_sparse = ctx.project / base / "sparse"
        keep = ctx.project / base / "work" / "sparse-gnss"
        if project_sparse.is_dir() and not keep.exists():  # the GNSS-only model, once
            keep.parent.mkdir(parents=True, exist_ok=True)
            shutil.copytree(project_sparse, keep)
        commit_tree(ctx, "out/sparse", f"{base}/sparse")
        files = [
            ("out/report/accuracy.json", f"{base}/report/accuracy.json"),
            ("out/cameras-sfm.json", f"{base}/cameras-sfm.json"),
        ]
        if ctx.stage("out/report/odm-stats.json").is_file():  # ODM's GCP errors of this adjustment
            files.append(("out/report/odm-stats.json", f"{base}/report/odm-stats.json"))
        else:  # a copy from an earlier adjustment would show errors of other cameras
            ctx.out(f"{base}/report/odm-stats.json").unlink(missing_ok=True)
            ctx.log("ODM reported no ground control errors for this adjustment.")
        commit_files(ctx, files)
        commit_files(ctx, [("work/adjusted-enu.npz", f"{base}/work/adjusted-enu.npz")], announce=False)
        pred = ctx.stage("work/predictions.json")
        if pred.exists():
            merge_predictions(
                safe_project_path(ctx.project, self._gcp_rel(ctx.params)), json.loads(pred.read_text("utf-8"))
            )
        st = RunState(ctx)
        data = st.load()
        data["status"] = "adjusted"
        data["updatedAt"] = now_iso()
        files = set((data.get("outputs") or {}).get("files", []))
        files.add(f"{base}/report/accuracy.json")
        data.setdefault("outputs", {"layers": [], "tilesets": [], "files": []})["files"] = sorted(files)
        for s in data.get("stages", []):
            if s["name"] == "commit":
                s.update({"state": "done", "finishedAt": now_iso()})
        data.pop("frames", None)
        atomic_write_json(
            ctx.out(f"{base}/run.json"), {k: v for k, v in data.items() if not k.startswith("_")}
        )
        ctx.artifact(f"{base}/run.json")
        return {"run": run}
