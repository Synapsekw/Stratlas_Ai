"""thermal.hotspots: hot spots in a layer's decoded temperature rasters, as draft detections (thermal M3
task 3.3, vision audit 3.14).

Parameters as ``ThermalHotspotsParams`` in packages/schema/src/thermal.ts: ``layerId``, optional
``photos`` (all of the layer's raster index when absent), ``rule`` (``delta`` or ``absolute``),
``thresholdC``, optional ``minAreaPx`` and ``maxPerPhoto``.

Steps:

1. **find** reads ``thermal/rasters/<layerId>/index.json`` and runs ``hotspots.find_hotspots`` on
   every ``ok`` photo whose raster reads; any other photo is listed in ``skipped``.
2. **commit** writes ``thermal/candidates.json`` (``aio.thermalCandidates/1``, replaced per run) and
   the draft pass ``detections/thermal-<layerId>.json`` (``aio.detections/1``), so the hot spots
   are reviewed in Inspect like any draft: class ``hot-spot`` (with ``label`` "Hot spot" and
   ``suggestedNew`` when the project has no such class), severity ``uncertain``, the temperatures
   as ``fields`` and in the note. The pass keeps every reviewed detection of the earlier run
   (accepted, rejected or linked to an issue) and the drafts of photos this run did not look at;
   a new hot spot over a reviewed one (IoU 0.3) is left out. The new drafts then go through the
   multi-view vote (``multiview/``): a hot spot seen in several posed photos is one draft.

The result counts ``candidates`` (drafts written by this run, after the vote), ``photos`` and
``skipped``, and names the ``pass``.
"""

from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Any

import numpy as np

from ..multiview.scene import vote_pass
from ..params import known_keys
from ..runtime import JobError, Step, StepContext, atomic_write_json, commit_files, now_iso
from . import raster
from .hotspots import find_hotspots
from .pipeline import RASTERS_DIR, _safe

CANDIDATES_SCHEMA = "aio.thermalCandidates/1"
DETECTIONS_SCHEMA = "aio.detections/1"
CANDIDATES_JSON = "thermal/candidates.json"
CLASS_ID = "hot-spot"
CLASS_LABEL = "Hot spot"
PRODUCER = "Thermal hot-spot finder"
REVIEWED_IOU = 0.3
FOUND = "found.json"


def pass_path(layer_id: str) -> str:
    return f"detections/thermal-{layer_id}.json"


def _iou(a, b) -> float:
    ix = max(0.0, min(a[2], b[2]) - max(a[0], b[0]))
    iy = max(0.0, min(a[3], b[3]) - max(a[1], b[1]))
    inter = ix * iy
    union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
    return inter / union if union > 0 else 0.0


def _reviewed(d: dict[str, Any]) -> bool:
    return d.get("status") != "draft" or bool(d.get("issueId"))


def _class_known(manifest: dict[str, Any]) -> bool:
    for cat in manifest.get("classCatalogues") or []:
        for c in (cat or {}).get("classes") or []:
            if c.get("id") == CLASS_ID or str(c.get("label", "")).strip().lower() == CLASS_LABEL.lower():
                return True
    return False


def _field(key: str, label: str, value: float) -> dict[str, Any]:
    return {"key": key, "label": label, "type": "number", "value": round(value, 1), "unit": "°C"}


def _number(params: dict[str, Any], key: str, lo: float, hi: float) -> None:
    v = params.get(key)
    if isinstance(v, bool) or not isinstance(v, int | float) or not math.isfinite(v) or not lo <= v <= hi:
        raise JobError(f"{key} must be a number from {lo:g} to {hi:g}.")


class ThermalHotspots:
    name = "thermal.hotspots"
    title = "Finding thermal hot spots"
    description = (
        "Spots hotter than their surroundings (or than a set temperature) in the decoded thermal "
        "photos of a layer, written as draft detections to review in Inspect."
    )

    def validate(self, params: dict[str, Any]) -> dict[str, Any]:
        known_keys(params, {"layerId", "photos", "rule", "thresholdC", "minAreaPx", "maxPerPhoto"}, self.name)
        if not _safe(params.get("layerId")):
            raise JobError("layerId must be the id of a photo layer.")
        photos = params.get("photos")
        if photos is not None and (
            not isinstance(photos, list) or not photos or not all(_safe(p) for p in photos)
        ):
            raise JobError("photos must be a list of photo ids.")
        if params.get("rule") not in ("delta", "absolute"):
            raise JobError('rule must be "delta" or "absolute".')
        _number(params, "thresholdC", 0.1 if params["rule"] == "delta" else -70, 1000)
        for key, hi in (("minAreaPx", 100_000), ("maxPerPhoto", 500)):
            if key in params and (
                isinstance(params[key], bool)
                or not isinstance(params[key], int)
                or not 1 <= params[key] <= hi
            ):
                raise JobError(f"{key} must be a whole number from 1 to {hi}.")
        return dict(params)

    def inputs(self, params: dict[str, Any]) -> list[str]:
        return ["manifest.json", f"{RASTERS_DIR}/{params['layerId']}/index.json"]

    def plan(self, params: dict[str, Any]) -> list[Step]:
        return [
            Step("find", "Looking for hot spots", self._find, weight=0.8),
            Step("commit", "Saving the hot spots", self._commit, weight=0.2),
        ]

    # ---------------------------------------------------------------------------------------- find

    def _find(self, ctx: StepContext) -> dict[str, Any]:
        p = ctx.params
        layer_id: str = p["layerId"]
        folder = ctx.out(f"{RASTERS_DIR}/{layer_id}")
        index = raster.read_index(folder / "index.json")["photos"]
        ids = list(dict.fromkeys(p.get("photos") or list(index)))
        found: list[dict[str, Any]] = []
        sizes: dict[str, list[int]] = {}
        skipped: list[str] = []
        for k, pid in enumerate(ids):
            ctx.check()
            ctx.progress(k / max(1, len(ids)), f"Photo {k + 1} of {len(ids)}")
            c = (
                self._raster(folder, pid)
                if (index.get(pid) or {}).get("status") == "ok" and _safe(pid)
                else None
            )
            if c is None:
                skipped.append(pid)
                continue
            sizes[pid] = [int(c.shape[1]), int(c.shape[0])]
            kw = {"min_area_px": p["minAreaPx"]} if "minAreaPx" in p else {}
            if "maxPerPhoto" in p:
                kw["max_per_photo"] = p["maxPerPhoto"]
            for h in find_hotspots(c, p["rule"], float(p["thresholdC"]), **kw):
                found.append({"photo": pid, "box": list(h.box), "peakC": h.peak_c, "meanC": h.mean_c,
                              "referenceC": h.reference_c, "deltaC": h.delta_c})  # fmt: skip
        if skipped:
            ctx.log(
                f"{len(skipped)} photos have no temperatures to search (not decoded, or held back): "
                + ", ".join(skipped[:8])
                + (" ..." if len(skipped) > 8 else ""),
                "warn",
            )
        if not sizes:
            raise JobError("None of these photos has temperatures yet. Open them in the Thermal bench first.")
        atomic_write_json(ctx.stage(FOUND), {"found": found, "sizes": sizes, "skipped": skipped})
        ctx.log(f"{len(found)} possible hot spots on {len(sizes)} photos.")
        return {"found": len(found), "photos": len(sizes), "skipped": len(skipped)}

    @staticmethod
    def _raster(folder: Path, pid: str) -> np.ndarray | None:
        try:
            meta = json.loads((folder / f"{pid}.json").read_text("utf-8"))
            w, h = int(meta["width"]), int(meta["height"])
            data = np.fromfile(folder / f"{pid}.f32", dtype="<f4")
        except (OSError, ValueError, KeyError, TypeError):
            return None
        return data.reshape(h, w) if data.size == w * h else None

    # -------------------------------------------------------------------------------------- commit

    def _commit(self, ctx: StepContext) -> dict[str, Any]:
        from ..inspection.frame import read_manifest

        p = ctx.params
        layer_id: str = p["layerId"]
        st = json.loads(ctx.stage(FOUND).read_text("utf-8"))
        found, sizes = st["found"], st["sizes"]
        created = now_iso()
        candidates = {
            "schema": CANDIDATES_SCHEMA,
            "at": created,
            "candidates": [
                {"layer": layer_id, "photo": f["photo"],
                 "box": {"type": "box", "x": f["box"][0], "y": f["box"][1], "w": f["box"][2], "h": f["box"][3]},
                 "peakC": f["peakC"], "meanC": f["meanC"], "referenceC": f["referenceC"], "deltaC": f["deltaC"]}
                for f in found
            ],
        }  # fmt: skip

        rel = pass_path(layer_id)
        old: list[dict[str, Any]] = []
        try:
            doc = json.loads(ctx.out(rel).read_text("utf-8"))
            if isinstance(doc, dict) and doc.get("schema") == DETECTIONS_SCHEMA:
                old = [d for d in doc.get("detections") or [] if isinstance(d, dict)]
        except (OSError, ValueError):
            old = []
        ran = set(sizes)
        kept = [d for d in old if _reviewed(d) or d.get("photo") not in ran]
        reviewed = [d for d in kept if _reviewed(d)]
        known = _class_known(read_manifest(ctx.project))
        fresh: list[dict[str, Any]] = []
        for k, f in enumerate(found):
            x, y, w, h = f["box"]
            bbox = [x, y, x + w, y + h]
            if any(d.get("photo") == f["photo"] and _iou(d.get("bbox") or [0, 0, 0, 0], bbox) >= REVIEWED_IOU
                   for d in reviewed):  # fmt: skip
                continue
            d: dict[str, Any] = {
                "id": f"thermal-{ctx.job.job_id}-{k}"[:128],
                "photo": f["photo"],
                "class": CLASS_ID,
            }
            if not known:
                d["label"] = CLASS_LABEL
                d["suggestedNew"] = True
            d.update(
                severity="uncertain",
                status="draft",
                note=(
                    f"Peak {f['peakC']:.1f} °C, {f['deltaC']:.1f} °C above its surroundings "
                    f"({f['referenceC']:.1f} °C)."
                ),
                bbox=bbox,
                space="source",
                width=sizes[f["photo"]][0],
                height=sizes[f["photo"]][1],
                fields=[
                    _field("peak_c", "Peak", f["peakC"]),
                    _field("delta_c", "ΔT", f["deltaC"]),
                    _field("reference_c", "Surroundings", f["referenceC"]),
                    _field("mean_c", "Mean", f["meanC"]),
                ],
                origin={"runId": ctx.job.job_id, "model": "thermal-hotspots/1"},
                createdAt=created,
            )
            fresh.append(d)
        fresh, _ = vote_pass(ctx, layer_id, fresh)
        dets = kept + fresh
        doc = {
            "schema": DETECTIONS_SCHEMA,
            "source": "model",
            "producer": PRODUCER,
            "createdAt": created,
            "layer": layer_id,
            "assessed": sorted(set(sizes) | {d["photo"] for d in kept if d.get("photo")}),
            "detections": dets,
        }
        atomic_write_json(ctx.stage("candidates.json"), candidates)
        atomic_write_json(ctx.stage("pass.json"), doc)
        commit_files(ctx, [("candidates.json", CANDIDATES_JSON), ("pass.json", rel)])
        ctx.progress(1.0)
        return {"pass": rel, "candidates": len(fresh), "photos": len(sizes), "skipped": len(st["skipped"])}
