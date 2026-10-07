"""photo.georef: bundle adjustment with ground control points; checkpoints measured, never used.

Stages (resumable job steps): ``adjust``, ``report``, ``commit``.

    adjust   the run's sparse model into its ENU frame; every confirmed mark of every point
             triangulated through the current cameras; control points that disagree with the
             others named and left out (``gcp.control_outliers``); without GNSS georeferencing,
             a similarity to the control points first; then bundle adjustment with the control
             points (weighted by their stated accuracy, observed through their marks) and, unless
             ``useGnss`` is false, the GNSS priors of ``photo.align``
    report   every point measured again through the adjusted cameras (control and check alike);
             report/accuracy.json (``checkpointsInAdjustment`` false), mark predictions, the
             adjusted ``sparse/`` and ``cameras-sfm.json``
    commit   into ``photogrammetry/<run>/``; the GNSS-only model is kept as ``work/sparse-gnss/``

Checkpoints never reach the adjustment: they are read only after it, so the adjusted cameras are
identical with and without them (tested).
"""

from __future__ import annotations

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


class PhotoGeoref:
    name = "photo.georef"
    title = "Adjust with ground control"
    description = "Bundle adjustment with marked control points, and the accuracy report."
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
        try:
            photos = json.loads((base / "sparse" / "photos.json").read_text("utf-8"))["photos"]
        except (OSError, ValueError, KeyError):
            photos = {}
        model = grid_to_enu_model(grid_model, enu, grid)
        by_name = {im.name: im.id for im in model.images.values()}
        geo = G.points_to_geodetic(gcp)
        surveyed = {
            p["id"]: enu.from_geodetic([geo[p["id"]][0]], [geo[p["id"]][1]], [geo[p["id"]][2]])[0]
            for p in gcp.get("points") or []
        }
        control = [p for p in gcp.get("points") or [] if p["role"] == "control" and not p.get("disabled")]
        measured, short = _measure(model, control, by_name)
        usable = [p for p in control if p["id"] in measured]
        warnings: list[dict[str, Any]] = []
        # a run aligned without GNSS sits in its SfM frame: place it on the control points first
        georeferenced = frame.get("georeferenced", True)
        if not georeferenced:
            if len(usable) < 3:
                raise JobError("This run has no GNSS georeferencing: mark at least three control points.")
            ids = [p["id"] for p in usable]
            sim, _ = B.similarity_ransac(
                np.array([measured[i][0] for i in ids]), np.array([surveyed[i] for i in ids]), threshold=1.0
            )
            model.transform(*sim)
            measured, short = _measure(model, control, by_name)
        sigma = {p["id"]: (p["accuracy"]["horizontalM"], p["accuracy"]["verticalM"]) for p in usable}
        outliers = G.control_outliers(
            {i: measured[i][0] for i in sigma}, {i: surveyed[i] for i in sigma}, sigma
        )
        out_ids = {o.id for o in outliers}
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
        controls = [
            B.ControlPoint(
                p["id"],
                surveyed[p["id"]],
                float(p["accuracy"]["horizontalM"]),
                float(p["accuracy"]["verticalM"]),
                [(by_name[ph], xy) for ph, xy in G.usable_marks(p) if ph in by_name],
            )
            for p in usable
            if p["id"] not in out_ids
        ]
        if len(controls) < 3 and not (params.get("useGnss", True) and georeferenced):
            raise JobError(
                "At least three usable control points are needed (each marked in two or more photos)."
            )
        priors: dict[int, B.CameraPrior] = {}
        if params.get("useGnss", True) and georeferenced:
            for iid, im in model.images.items():
                g = (photos.get(im.name) or {}).get("gnss")
                if g:
                    pos = enu.from_geodetic([g["lon"]], [g["lat"]], [g["h"]])[0]
                    priors[iid] = B.CameraPrior(pos, float(g["sigmaH"]), float(g["sigmaV"]))
        # A systematic GNSS offset (the drone's altitude datum, a base station's shift) would leak
        # into camera heights through the focal length; with enough control it is estimated
        # (median camera-to-GNSS difference after a fit to the control points) and taken out.
        gnss_shift = [0.0, 0.0, 0.0]
        if priors and len(controls) >= 3:
            ids = [c.id for c in controls]
            sim = B.similarity(np.array([measured[i][0] for i in ids]), np.array([surveyed[i] for i in ids]))
            keys = sorted(priors)
            fitted = B.apply_similarity(sim, np.array([model.images[i].centre for i in keys]))
            shift = np.median(fitted - np.array([priors[i].position for i in keys]), axis=0)
            gnss_shift = [round(float(v), 4) for v in shift]
            for i in keys:
                priors[i] = B.CameraPrior(priors[i].position + shift, priors[i].sigma_h, priors[i].sigma_v)
        pts = B.select_points(model, per_image=300)
        res = B.bundle_adjust(
            model,
            pts,
            priors=priors,
            controls=controls,
            check=ctx.check,
            progress=lambda f: ctx.progress(0.9 * f, "Adjusting"),
        )
        B.refine_all_points(model)
        model.save_npz(ctx.stage("work/adjusted-enu.npz"))
        atomic_write_json(
            ctx.stage("work/adjust.json"),
            {
                "warnings": warnings,
                "outliers": sorted(out_ids),
                "used": [c.id for c in controls],
                "short": short,
                "gnss": bool(priors),
                "gnssShiftEnuM": gnss_shift,
                "iterations": res.iterations,
            },
        )
        st = RunState(ctx)
        data = st.load() or dict(state)
        names = [s["name"] for s in data.get("stages", [])]
        for s in ("adjust", "report"):
            if s not in names:
                data.setdefault("stages", []).append({"name": s, "state": "pending"})
        data["stages"] = [
            {**s, "state": "running", "startedAt": now_iso()} if s["name"] == "adjust" else s
            for s in data["stages"]
        ]
        st.save(data)
        return {
            "controls": len(controls),
            "outliers": len(outliers),
            "gnss": bool(priors),
            "iterations": res.iterations,
        }

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
        gsd = A.gsd_cm(model)
        warnings = [A.Warning_(w["code"], w["message"], w.get("point")) for w in adj["warnings"]]
        warnings += A.point_warnings(residuals, (gsd or 0) / 100)
        warnings += A.unmeasured_warnings(
            [A.PointResidual(i, "control", np.zeros(3), 0.0, n) for i, n in short.items()]
        )
        grid_model = enu_to_grid_model(model, enu, grid)
        # cameras against their GNSS positions (and the Al-Zour check on heights)
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
                mean_reproj_px=model.mean_reprojection_error(),
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
        commit_files(
            ctx,
            [
                ("out/report/accuracy.json", f"{base}/report/accuracy.json"),
                ("out/cameras-sfm.json", f"{base}/cameras-sfm.json"),
            ],
        )
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
