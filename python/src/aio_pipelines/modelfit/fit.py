"""model.fit_cloud: draft model parts (tanks, boxes, buildings, pipes) fitted to a point cloud.

Parameters as ``ModelFitParams`` in ``@aio/schema``. Steps (each resumable):

- ``read``: the cloud layer in the local frame, inside the region, thinned to half the fit
  distance (``segment.py``); the model id is settled here so a resume reuses it;
- ``segment``: ground removal (opened lowest surface) and Euclidean clusters;
- ``fit``: per cluster the best of a vertical cylinder, a box, an extrusion and a straight pipe
  (``ransac.py``), ranked by inlier share and residual; a cluster no primitive explains (noise)
  gives no part;
- ``commit``: append the draft parts to ``models/<id>.procmodel.json`` (``aio.procmodel/1``)
  atomically, with a ``.bak`` of the previous file.
"""

from __future__ import annotations

import json
import re
import shutil
from pathlib import Path
from typing import Any

import numpy as np

from ..params import known_keys, number, text
from ..runtime import JobError, Step, StepContext, atomic_write_json, now_iso, safe_project_path
from . import ransac, segment

KINDS = ("extrusion", "cylinder", "box", "pipe", "sphere")
DEFAULT_KINDS = ("extrusion", "cylinder", "box", "pipe")
MODEL_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,80}$")
CLASS = {"cylinder": "tank", "box": "skid", "extrusion": "building", "pipe": "pipe"}
NAME = {"cylinder": "Tank", "box": "Box", "extrusion": "Building", "pipe": "Pipe"}


def _manifest(project: Path) -> dict[str, Any]:
    from ..inspection.frame import read_manifest

    return read_manifest(project)


def _slug(s: str) -> str:
    out = re.sub(r"[^A-Za-z0-9_-]+", "-", s).strip("-_")[:70]
    return out if out and out[0].isalnum() else "cloud"


class ModelFitCloud:
    name = "model.fit_cloud"
    title = "Model from point cloud"
    description = "Ground removal, clustering and primitive fitting into draft model parts."
    keys = frozenset({"layer", "region", "kinds", "distM", "minInliers", "model"})

    def validate(self, params: dict[str, Any]) -> dict[str, Any]:
        known_keys(params, set(self.keys), self.name)
        layer = text(params, "layer", required=True)
        out: dict[str, Any] = {"layer": layer}
        kinds = params.get("kinds")
        if kinds is not None:
            if not isinstance(kinds, list) or not kinds or any(k not in KINDS for k in kinds):
                raise JobError(f"kinds must be a list of {', '.join(KINDS)}.")
            out["kinds"] = list(kinds)
        out["distM"] = number(params, "distM", 0.05, lo=0.001, hi=5)
        out["minInliers"] = number(params, "minInliers", 200, lo=10, integer=True)
        model = params.get("model")
        if model is not None:
            if not isinstance(model, str) or not MODEL_ID.match(model):
                raise JobError("model must be a plain file name (letters, digits, - and _).")
            out["model"] = model
        region = params.get("region")
        if region is not None:
            ok_box = isinstance(region, dict) and set(region) == {"min", "max"}
            ok_ring = isinstance(region, list) and len(region) >= 3
            if not (ok_box or ok_ring):
                raise JobError("region must be a box {min, max} in the local frame or a lon/lat ring.")
            out["region"] = region
        return out

    def inputs(self, params: dict[str, Any]) -> list[str]:
        # the layers (manifest) and the cloud files (clouds/, data-conventions section 2)
        return ["manifest.json", "clouds"]

    def plan(self, params: dict[str, Any]) -> list[Step]:
        dist = float(params["distM"])
        min_inl = int(params["minInliers"])
        kinds = tuple(params.get("kinds") or DEFAULT_KINDS)

        def read(ctx: StepContext) -> dict[str, Any]:
            manifest = _manifest(ctx.project)
            pts = segment.load_layer_points(ctx, manifest, params["layer"], max(dist / 2, 0.01))
            pts = pts[segment.region_mask(pts, params.get("region"), manifest)]
            if len(pts) < min_inl:
                raise JobError(
                    f"The cloud has {len(pts)} points in the region, fewer than the {min_inl} a part needs."
                )
            np.save(ctx.stage("work/points.npy"), pts)
            model_id = params.get("model")
            if not model_id:
                base = f"scan-{_slug(str(params['layer']))}"
                model_id, n = base, 2
                while (ctx.project / "models" / f"{model_id}.procmodel.json").exists():
                    model_id, n = f"{base}-{n}", n + 1
            ctx.log(f"{len(pts):,} points after thinning to {max(dist / 2, 0.01):.3f} m.")
            return {"points": len(pts), "model": model_id}

        def segment_step(ctx: StepContext) -> dict[str, Any]:
            pts = np.load(ctx.stage("work/points.npy"))
            ground = segment.ground_surface(pts)
            gy = ground(pts[:, [0, 2]])
            above = pts[:, 1] - gy > max(3 * dist, 0.15)
            obj = pts[above]
            ctx.check()
            groups = segment.clusters(obj, max(0.5, 6 * dist), min_inl)
            out = []
            for i, idx in enumerate(groups):
                c = obj[idx]
                base = float(np.median(ground(c[:, [0, 2]])))
                np.save(ctx.stage(f"work/cluster-{i:04d}.npy"), c)
                out.append({"file": f"work/cluster-{i:04d}.npy", "base": base, "points": len(c)})
            ctx.log(f"{int(above.sum()):,} points above the ground in {len(out)} clusters.")
            return {"clusters": out}

        def fit(ctx: StepContext) -> dict[str, Any]:
            rng = np.random.default_rng(0)
            found = []
            groups = ctx.outputs("segment").get("clusters", [])
            for i, g in enumerate(groups):
                ctx.check()
                ctx.progress(i / max(len(groups), 1), f"Cluster {i + 1} of {len(groups)}")
                pts = np.load(ctx.stage(g["file"]))
                if len(pts) > 40_000:
                    pts = pts[rng.choice(len(pts), 40_000, replace=False)]
                base = float(g["base"])
                cands: list[ransac.Candidate | None] = []
                if "cylinder" in kinds:
                    cands.append(ransac.cylinder(pts, base, dist, rng))
                if "box" in kinds:
                    cands.append(ransac.box(pts, base, dist))
                if "extrusion" in kinds:
                    cands.append(ransac.extrusion(pts, base, dist))
                if "pipe" in kinds:
                    cands.append(ransac.pipe(pts, dist))
                good = [c for c in cands if c and c.share >= 0.6 and c.residual <= 2 * dist]
                if not good:
                    ctx.log(f"Cluster {i + 1} ({len(pts)} points): no primitive fits; no part.")
                    continue
                best = max(good, key=lambda c: c.score(dist))
                boxed = next((c for c in good if c.kind == "box"), None)
                if best.kind == "extrusion" and boxed and boxed.residual <= 2 * best.residual:
                    best = boxed  # a rectangle is a box, not a four-corner extrusion
                found.append(
                    {
                        "kind": best.kind,
                        "shape": best.shape,
                        "residual": best.residual,
                        "share": best.share,
                        "inliers": best.inliers,
                    }
                )
            return {"parts": found}

        def commit(ctx: StepContext) -> dict[str, Any]:
            model_id = ctx.outputs("read")["model"]
            rel = f"models/{model_id}.procmodel.json"
            path = safe_project_path(ctx.project, rel)
            now = now_iso()
            if path.is_file():
                try:
                    model = json.loads(path.read_text("utf-8"))
                except ValueError as e:
                    raise JobError(f"{rel} is not valid JSON; fix or remove it, then fit again.") from e
            else:
                model = {
                    "schema": "aio.procmodel/1",
                    "id": model_id,
                    "name": f"Model from {params['layer']}",
                    "createdAt": now,
                    "updatedAt": now,
                    "parts": [],
                }
            parts = model.setdefault("parts", [])
            taken = {p.get("id") for p in parts}
            counts: dict[str, int] = {}
            for p in parts:
                k = p.get("kind")
                counts[k] = counts.get(k, 0) + 1
            by_kind: dict[str, int] = {}
            run = ctx.job.job_id
            for i, f in enumerate(ctx.outputs("fit").get("parts", []), start=1):
                kind = f["kind"]
                counts[kind] = counts.get(kind, 0) + 1
                by_kind[kind] = by_kind.get(kind, 0) + 1
                pid, n = f"fit-{run[-4:]}-{i}", 2
                while pid in taken:
                    pid, n = f"fit-{run[-4:]}-{i}-{n}", n + 1
                taken.add(pid)
                share = float(f["share"])
                parts.append(
                    {
                        "kind": kind,
                        "id": pid,
                        "name": f"{NAME[kind]} {counts[kind]}",
                        "class": CLASS[kind],
                        "status": "draft",
                        "confidence": round(max(0.0, min(1.0, share * (1 - f["residual"] / (4 * dist)))), 3),
                        "origin": {
                            "by": "fit",
                            "residualM": round(float(f["residual"]), 5),
                            "inliers": int(f["inliers"]),
                            "inlierShare": round(min(1.0, share), 4),
                            "runId": run,
                        },
                        **f["shape"],
                    }
                )
            sources = model.setdefault("sources", [])
            if not any(s.get("ref") == params["layer"] for s in sources):
                sources.append({"kind": "pointcloud", "ref": params["layer"]})
            model["updatedAt"] = now
            if path.is_file():
                shutil.copyfile(path, path.with_name(path.name + ".bak"))
            atomic_write_json(path, model, indent=2)
            ctx.artifact(rel)
            added = sum(by_kind.values())
            ctx.log(f"{added} draft part{'s' if added != 1 else ''} added to {rel}.")
            return {"model": model_id, "path": rel, "parts": added, "byKind": by_kind}

        return [
            Step("read", "Read the point cloud", read, weight=3),
            Step("segment", "Remove the ground and find objects", segment_step, weight=3),
            Step("fit", "Fit tanks, boxes, buildings and pipes", fit, weight=4),
            Step("commit", "Add the draft parts to the model", commit, weight=0.5),
        ]
