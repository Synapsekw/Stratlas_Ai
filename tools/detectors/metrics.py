"""Bench metrics: IoU matching, precision/recall/F1 per class, the PR curve and reference checks.

Pure functions, no model and no files, so the bench's numbers can be tested on synthetic boxes.

Shapes: ``truth`` maps a photo key to a list of ``{"box": (x1, y1, x2, y2), "class": id}``; a draft is
``{"photo": key, "box": [x1, y1, x2, y2], "score": float | None}``. A draft with no score never counts.
"""

from __future__ import annotations

import hashlib
import json
from typing import Any

Box = tuple[float, float, float, float]

IOU_MIN = 0.3
PR_STEPS = 20  # thresholds 0.00, 0.05, ... 1.00
COMPARED = ("precision", "recall", "f1")


def iou(a: Box, b: Box) -> float:
    """Intersection over union of two boxes; 0 when either has no area."""
    ix = max(0.0, min(a[2], b[2]) - max(a[0], b[0]))
    iy = max(0.0, min(a[3], b[3]) - max(a[1], b[1]))
    inter = ix * iy
    area_a = max(0.0, a[2] - a[0]) * max(0.0, a[3] - a[1])
    area_b = max(0.0, b[2] - b[0]) * max(0.0, b[3] - b[1])
    union = area_a + area_b - inter
    return inter / union if union > 0 and area_a > 0 and area_b > 0 else 0.0


def match(
    drafts: list[dict[str, Any]], truth: dict[str, list[dict[str, Any]]], iou_min: float
) -> list[tuple[int | None, float]]:
    """One-to-one greedy matching in score order (the COCO way), per photo.

    Drafts are taken from the highest score down; each takes the unmatched truth item on its photo with
    the highest IoU at or above ``iou_min``. Returns, per draft in input order, ``(truth index, iou)`` or
    ``(None, best iou seen)``. Because the order is the score order, the matches of the drafts at or above
    any threshold are exactly what matching only those drafts would give, so one pass serves every
    threshold of the PR curve.
    """
    out: list[tuple[int | None, float]] = [(None, 0.0)] * len(drafts)
    order = sorted(
        (i for i, d in enumerate(drafts) if d.get("score") is not None),
        key=lambda i: (-float(drafts[i]["score"]), i),
    )
    used: dict[str, set[int]] = {}
    for i in order:
        d = drafts[i]
        items = truth.get(d["photo"], [])
        taken = used.setdefault(d["photo"], set())
        best, best_iou, seen = None, 0.0, 0.0
        for j, t in enumerate(items):
            v = iou(tuple(d["box"]), tuple(t["box"]))
            seen = max(seen, v)
            if j not in taken and v >= iou_min and v > best_iou:
                best, best_iou = j, v
        if best is not None:
            taken.add(best)
            out[i] = (best, best_iou)
        else:
            out[i] = (None, seen)
    return out


def _ratio(n: int, d: int) -> float | None:
    return n / d if d else None


def _f1(p: float | None, r: float | None) -> float | None:
    if p is None or r is None:
        return None
    return 2 * p * r / (p + r) if p + r else 0.0


def _prf(tp: int, fp: int, fn: int) -> dict[str, Any]:
    p, r = _ratio(tp, tp + fp), _ratio(tp, tp + fn)
    return {"tp": tp, "fp": fp, "fn": fn, "precision": p, "recall": r, "f1": _f1(p, r)}


def _above(d: dict[str, Any], threshold: float) -> bool:
    return d.get("score") is not None and float(d["score"]) >= threshold


def evaluate(
    drafts: list[dict[str, Any]],
    truth: dict[str, list[dict[str, Any]]],
    threshold: float,
    iou_min: float,
    detector_class: str,
    photos: int,
    matches: list[tuple[int | None, float]] | None = None,
) -> dict[str, Any]:
    """Precision, recall and F1 at one score threshold, overall and per class.

    Per class: a matched draft counts for the class of the truth item it matched; an unmatched draft is a
    false draft of the detector's own class.
    """
    if matches is None:
        matches = match(drafts, truth, iou_min)
    classes = {t["class"] for items in truth.values() for t in items} | {detector_class}
    per = {c: {"truth": 0, "tp": 0, "fp": 0} for c in classes}
    for items in truth.values():
        for t in items:
            per[t["class"]]["truth"] += 1
    kept = 0
    for d, (j, _) in zip(drafts, matches, strict=True):
        if not _above(d, threshold):
            continue
        kept += 1
        if j is None:
            per[detector_class]["fp"] += 1
        else:
            per[truth[d["photo"]][j]["class"]]["tp"] += 1
    tp = sum(c["tp"] for c in per.values())
    fp = sum(c["fp"] for c in per.values())
    n_truth = sum(c["truth"] for c in per.values())
    res = {"drafts": kept, **_prf(tp, fp, n_truth - tp), "draftsPerPhoto": _ratio(kept, photos)}
    res["perClass"] = {
        c: {"truth": v["truth"], **_prf(v["tp"], v["fp"], v["truth"] - v["tp"])}
        for c, v in sorted(per.items())
    }
    return res


def pr_curve(
    drafts: list[dict[str, Any]],
    truth: dict[str, list[dict[str, Any]]],
    iou_min: float,
    detector_class: str,
    photos: int,
) -> list[dict[str, Any]]:
    """One row per score threshold from 0 to 1 in steps of 0.05."""
    matches = match(drafts, truth, iou_min)
    rows = []
    for k in range(PR_STEPS + 1):
        t = round(k / PR_STEPS, 2)
        r = evaluate(drafts, truth, t, iou_min, detector_class, photos, matches)
        rows.append(
            {"threshold": t, **{f: r[f] for f in ("drafts", "tp", "fp", "fn", "precision", "recall", "f1")}}
        )
    return rows


def pr_csv(rows: list[dict[str, Any]]) -> str:
    def num(v: float | None) -> str:
        return "" if v is None else f"{v:.4f}"

    lines = ["threshold,drafts,tp,fp,fn,precision,recall,f1"]
    for r in rows:
        lines.append(
            f"{r['threshold']:.2f},{r['drafts']},{r['tp']},{r['fp']},{r['fn']},"
            f"{num(r['precision'])},{num(r['recall'])},{num(r['f1'])}"
        )
    return "\n".join(lines) + "\n"


def _centre(b: Box) -> tuple[float, float]:
    return ((b[0] + b[2]) / 2, (b[1] + b[3]) / 2)


def _contains(b: Box, p: tuple[float, float]) -> bool:
    return b[0] <= p[0] <= b[2] and b[1] <= p[1] <= b[3]


def centre_rule(
    drafts: list[dict[str, Any]], truth: dict[str, list[dict[str, Any]]], threshold: float
) -> dict[str, Any]:
    """The old rule, kept for comparison: a truth item is found when a draft box contains its centre.

    Not one to one, and a huge box finds everything under it.
    """
    above = [d for d in drafts if _above(d, threshold)]
    found = 0
    hit: set[int] = set()
    for photo, items in truth.items():
        for t in items:
            c = _centre(tuple(t["box"]))
            here = [i for i, d in enumerate(above) if d["photo"] == photo and _contains(tuple(d["box"]), c)]
            if here:
                found += 1
                hit.update(here)
    n_truth = sum(len(v) for v in truth.values())
    return {
        "found": found,
        "recall": _ratio(found, n_truth),
        "precision": _ratio(len(hit), len(above)),
        "unmatchedDrafts": len(above) - len(hit),
    }


def centre_matched(draft: dict[str, Any], truth: dict[str, list[dict[str, Any]]]) -> bool:
    return any(
        _contains(tuple(draft["box"]), _centre(tuple(t["box"]))) for t in truth.get(draft["photo"], [])
    )


def dataset_hash(photo_keys: list[str], truth: dict[str, list[dict[str, Any]]]) -> str:
    """sha256 of the photos run and their truth (boxes rounded to 0.1 px), independent of order."""
    doc = [
        [k, sorted([t["class"], [round(float(v), 1) for v in t["box"]]] for t in truth.get(k, []))]
        for k in sorted(photo_keys)
    ]
    return hashlib.sha256(json.dumps(doc, separators=(",", ":")).encode()).hexdigest()


def compare(report: dict[str, Any], reference: dict[str, Any], tolerance: float) -> dict[str, Any]:
    """Compare a run with a stored reference. A drop beyond ``tolerance`` (absolute) is a regression.

    A reference measured on other data or another model is warned about but still compared, so a
    regression cannot hide behind a changed dataset.
    """
    ref = reference.get("metrics")
    if not isinstance(ref, dict):
        return {"status": "no-reference", "regressions": [], "warnings": [], "mismatches": []}
    mismatches = settings_mismatches(report, reference)
    if mismatches:
        return {"status": "mismatch", "regressions": [], "warnings": [], "mismatches": mismatches}
    warnings: list[str] = []
    if reference.get("datasetHash") != report.get("datasetHash"):
        warnings.append(
            "the reference was measured on another dataset (hash differs); if the change is expected, "
            "refresh it with --write-reference"
        )
    if reference.get("model") and report.get("model") and reference["model"] != report["model"]:
        warnings.append(
            f"the reference was measured with model {reference['model']}, this run with {report['model']}"
        )
    regressions: list[str] = []
    for f in COMPARED:
        was, now = ref.get(f), report.get(f)
        if was is None:
            continue
        if now is None:
            # an empty run must never pass against a full reference
            regressions.append(f"{f} could not be measured in this run (reference {was:.3f})")
            continue
        if now < was - tolerance:
            regressions.append(f"{f} {now:.3f} is below the reference {was:.3f} by more than {tolerance:.3f}")
    return {
        "status": "regression" if regressions else "ok",
        "regressions": regressions,
        "warnings": warnings,
        "mismatches": [],
    }


SETTINGS = ("threshold", "iouMin", "split", "truthClasses")


def settings_mismatches(report: dict[str, Any], reference: dict[str, Any]) -> list[str]:
    """Run settings that differ from the reference's: numbers measured that way do not compare."""
    out: list[str] = []
    for k in SETTINGS:
        was, now = reference.get(k), report.get(k)
        if k == "truthClasses":
            was = sorted(was) if isinstance(was, list) else was
            now = sorted(now) if isinstance(now, list) else now
        if was != now:
            out.append(f"{k} is {now!r} in this run but {was!r} in the reference")
    return out


def stale_tuned_on(
    detector: dict[str, Any], pack_model: str, reference: dict[str, Any] | None = None
) -> list[str]:
    """Warnings when a detector was tuned, or its reference measured, on another model than the pack's."""
    name = detector.get("id", "?")
    tuned = detector.get("tunedOn", {}).get("model") if isinstance(detector.get("tunedOn"), dict) else None
    out: list[str] = []
    if tuned is None:
        out.append(f"{name}: no tunedOn model recorded; the Analytics pack ships {pack_model}")
    elif tuned != pack_model:
        out.append(
            f"{name}: tunedOn names {tuned}, but the Analytics pack ships {pack_model} (stale tunedOn)"
        )
    ref_model = (reference or {}).get("model")
    if ref_model and ref_model != pack_model:
        out.append(
            f"{name}: the stored reference was measured with {ref_model}, not the shipped {pack_model}"
        )
    return out
