"""Detector bench: run one vision-model detector over reference projects' photos and measure it.

    uv run --project python python tools/detectors/bench.py --project <dir> [--project <dir>...] \
        --detector <detector.json> --server <url> --split tune|bench [--truth-class <id>...] \
        [--threshold 0.8] [--iou 0.3] [--limit 50] [--compare <ref.json>] [--tolerance 0.05] \
        [--write-reference <ref.json>] --out <dir>

Projects are only read, never written to. Photos come from the manifest's photo layers. Truth is
every image sighting of an issue whose shape has bounds (box, rotated box, polygon), plus every
accepted detection of ``detections/*.json``, filtered by ``--truth-class``. A draft at or above the
threshold is a true positive when it takes a truth item by IoU (at least ``--iou``, one to one, in
score order; see ``metrics.py``). The old centre-contains rule is reported beside it. Output in
``--out``: ``report.json``, ``drafts.json``, ``pr.csv``, ``pr.json`` and ``sheet-<n>.jpg``.
"""

from __future__ import annotations

import argparse
import datetime
import hashlib
import json
import math
import os
import sys
import urllib.request
from pathlib import Path
from typing import Any

from PIL import Image, ImageDraw

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "python" / "src"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import metrics
from aio_pipelines.detect.engine import (
    VlmClient,
    VlmUnavailable,
    box_frame,
    run_detector,
)
from aio_pipelines.inspection.frame import asset_path, photo_layers, read_manifest

Box = tuple[float, float, float, float]

TUNE_SHARE = 3  # of 10
REVIEW_LONG_EDGE = 2560  # the app's review copies; truth boxes are in their pixels
SHEET_COLS, SHEET_ROWS = 4, 3
CELL_W, CELL_H = 480, 360
GREEN = (40, 220, 80)
HIT = (255, 200, 0)
DRAFT = (255, 90, 60)
DIM = (140, 100, 95)


def in_tune(photo_id: str) -> bool:
    """30 % of photos are for tuning a detector, the rest are the bench that measures it."""
    return int(hashlib.sha1(photo_id.encode()).hexdigest(), 16) % 10 < TUNE_SHARE


def truth_box(geom: dict[str, Any]) -> Box | None:
    """Bounds of an image shape in photo pixels (x1, y1, x2, y2); None for a shape with no extent."""
    kind = geom.get("type")
    if kind in ("box", "rotbox"):
        x, y, w, h = (float(geom[k]) for k in ("x", "y", "w", "h"))
        if kind == "rotbox":
            a = math.radians(float(geom.get("angleDeg", 0)))
            cx, cy = x + w / 2, y + h / 2
            hw = abs(w * math.cos(a)) / 2 + abs(h * math.sin(a)) / 2
            hh = abs(w * math.sin(a)) / 2 + abs(h * math.cos(a)) / 2
            return (cx - hw, cy - hh, cx + hw, cy + hh)
        return (x, y, x + w, y + h)
    if kind == "polygon":
        pts = [
            (float(p["x"]), float(p["y"])) if isinstance(p, dict) else (float(p[0]), float(p[1]))
            for p in geom["points"]
        ]
        xs, ys = [p[0] for p in pts], [p[1] for p in pts]
        return (min(xs), min(ys), max(xs), max(ys))
    return None


def centre(b: Box) -> tuple[float, float]:
    return ((b[0] + b[2]) / 2, (b[1] + b[3]) / 2)


def _contains(b: Box, p: tuple[float, float]) -> bool:
    return b[0] <= p[0] <= b[2] and b[1] <= p[1] <= b[3]


def _read_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text("utf-8"))
    except (OSError, ValueError):
        return None


def _detection_box(d: dict[str, Any], size: tuple[int, int]) -> Box | None:
    """An accepted detection's bbox in the pixels of the photo file."""
    bbox = d.get("bbox")
    if not isinstance(bbox, list) or len(bbox) != 4:
        return None
    x1, y1, x2, y2 = (float(v) for v in bbox)
    space = d.get("space", "preview")
    if space == "preview":
        return (x1, y1, x2, y2)
    if space == "normalized":
        return (x1 * size[0], y1 * size[1], x2 * size[0], y2 * size[1])
    if space == "source" and d.get("width") and d.get("height"):
        sx, sy = size[0] / float(d["width"]), size[1] / float(d["height"])
        return (x1 * sx, y1 * sy, x2 * sx, y2 * sy)
    return None  # a contact-sheet box has no photo grid here


def load_truth(
    project: Path, classes: set[str], sizes: dict[str, tuple[int, int]]
) -> dict[str, list[dict[str, Any]]]:
    """Truth items ``{"box", "class"}`` per photo id, boxes in photo pixels. ``classes`` empty: every class."""
    truth: dict[str, list[dict[str, Any]]] = {}

    def add(photo: str, box: Box | None, cls: Any) -> None:
        if box is None or photo not in sizes:
            return
        mine = truth.setdefault(photo, [])
        c = centre(box)
        # The same finding recorded as an issue and as an accepted detection counts once.
        if not any(_contains(o["box"], c) or _contains(box, centre(o["box"])) for o in mine):
            mine.append({"box": box, "class": str(cls)})

    doc = _read_json(project / "issues.json")
    issues = doc.get("issues", []) if isinstance(doc, dict) else doc
    for issue in issues if isinstance(issues, list) else []:
        if not isinstance(issue, dict) or (classes and issue.get("classId") not in classes):
            continue
        for s in issue.get("sightings", []):
            if isinstance(s, dict) and s.get("on") == "image" and isinstance(s.get("geom"), dict):
                add(str(s.get("photo")), truth_box(s["geom"]), issue.get("classId"))
    for f in sorted((project / "detections").glob("*.json")):
        pass_doc = _read_json(f)
        for d in pass_doc.get("detections", []) if isinstance(pass_doc, dict) else []:
            if not isinstance(d, dict) or d.get("status") != "accepted" or d.get("frame"):
                continue
            if classes and d.get("class") not in classes:
                continue
            photo = str(d.get("photo"))
            if photo in sizes:
                add(photo, _detection_box(d, sizes[photo]), d.get("class"))
    return truth


def find_photos(project: Path) -> dict[str, Path]:
    """Photo id -> file, from every photos layer of the manifest, files that exist only."""
    out: dict[str, Path] = {}
    for layer in photo_layers(read_manifest(project)):
        for item in layer.get("items", []):
            path = asset_path(project, item.get("src")) if isinstance(item, dict) else None
            if path is not None and path.is_file():
                out.setdefault(str(item.get("id")), path)
    return out


def _sheet(
    n: int,
    entries: list[dict[str, Any]],
    photos: dict[str, Path],
    truth: dict[str, list[dict[str, Any]]],
    out: Path,
    threshold: float,
) -> None:
    sheet = Image.new("RGB", (SHEET_COLS * CELL_W, SHEET_ROWS * CELL_H), (20, 20, 20))
    for i, e in enumerate(entries):
        with Image.open(photos[e["photo"]]) as src:
            scale = min(CELL_W / src.width, CELL_H / src.height)
            thumb = src.convert("RGB").resize(
                (max(1, int(src.width * scale)), max(1, int(src.height * scale)))
            )
        draw = ImageDraw.Draw(thumb)
        for t in truth.get(e["photo"], []):
            draw.rectangle([v * scale for v in t["box"]], outline=GREEN, width=3)
        for d in e["drafts"]:
            at = d["score"] is not None and d["score"] >= threshold
            colour = (HIT if d["matched"] else DRAFT) if at else DIM
            draw.rectangle([v * scale for v in d["box"]], outline=colour, width=2)
            label = "n/a" if d["score"] is None else f"{d['score']:.2f}"
            draw.text((d["box"][0] * scale + 2, d["box"][1] * scale + 2), label, fill=colour)
        draw.text((4, thumb.height - 12), e["photo"], fill=(255, 255, 255))
        sheet.paste(thumb, ((i % SHEET_COLS) * CELL_W, (i // SHEET_COLS) * CELL_H))
    sheet.save(out / f"sheet-{n}.jpg", quality=88)


def load_set(
    projects: list[Path], split: str, limit: int, classes: set[str]
) -> tuple[list[str], dict[str, Path], dict[str, tuple[int, int]], dict[str, list[dict[str, Any]]]]:
    """Photo keys, files, sizes and truth over every project. ``limit`` is per project; the split hashes
    the photo id. With several projects a key is ``<project folder>/<photo id>``."""
    want_tune = split == "tune"
    keys: list[str] = []
    photos: dict[str, Path] = {}
    sizes: dict[str, tuple[int, int]] = {}
    truth: dict[str, list[dict[str, Any]]] = {}
    for project in projects:
        prefix = f"{project.name}/" if len(projects) > 1 else ""
        found = find_photos(project)
        ids = sorted(p for p in found if in_tune(p) == want_tune)[:limit]
        local: dict[str, tuple[int, int]] = {}
        for pid in ids:
            with Image.open(found[pid]) as im:
                local[pid] = (im.width, im.height)
        for pid, items in load_truth(project, classes, local).items():
            truth[prefix + pid] = items
        for pid in ids:
            keys.append(prefix + pid)
            photos[prefix + pid] = found[pid]
            sizes[prefix + pid] = local[pid]
    return keys, photos, sizes, truth


def run(args: argparse.Namespace) -> int:
    projects = [Path(p) for p in args.project]
    detector = json.loads(Path(args.detector).read_text("utf-8"))
    classes = set(args.truth_class or [])
    ids, photos, sizes, truth = load_set(projects, args.split, args.limit, classes)
    off_grid = sorted(pid for pid, (w, h) in sizes.items() if max(w, h) != REVIEW_LONG_EDGE)
    if off_grid:
        print(
            f"Warning: {len(off_grid)} of {len(sizes)} photos have a long edge other than "
            f"{REVIEW_LONG_EDGE} px (for example {', '.join(off_grid[:3])}). Truth is recorded in "
            "review-copy pixels, so recall and false alarms on them may be off.",
            file=sys.stderr,
        )

    client = VlmClient(args.server, api_key=args.api_key)
    model = args.model or server_model(args.server, args.api_key)
    frame = box_frame(model) if model else "pixels"
    entries: list[dict[str, Any]] = []
    failed = 0
    for pid in ids:
        try:
            with Image.open(photos[pid]) as im:
                im.load()
                result = run_detector(client, im, detector, frame=frame)
        except VlmUnavailable as e:
            print(f"The model server cannot be reached: {e}", file=sys.stderr)
            return 2
        failed += result.failed
        drafts = [
            {
                "photo": pid,
                "box": [round(v, 1) for v in c.box],
                "score": c.score,
                "note": c.note,
                "matched": False,
            }
            for c in result.candidates
        ]
        entries.append({"photo": pid, "drafts": drafts})

    drafts = [d for e in entries for d in e["drafts"]]
    det_class = str(detector.get("classId") or "")
    for d, (j, v) in zip(drafts, metrics.match(drafts, truth, args.iou), strict=True):
        at = d["score"] is not None and d["score"] >= args.threshold
        d["matched"] = at and j is not None
        d["iou"] = round(v, 3)
        d["centreMatched"] = at and metrics.centre_matched(d, truth)
    scores = metrics.evaluate(drafts, truth, args.threshold, args.iou, det_class, len(ids))
    pr = metrics.pr_curve(drafts, truth, args.iou, det_class, len(ids))
    report = {
        "detector": detector.get("id"),
        "detectorVersion": detector.get("version"),
        "classId": det_class,
        "model": model,
        "split": args.split,
        "threshold": args.threshold,
        "iouMin": args.iou,
        "truthClasses": sorted(classes),
        "photos": len(ids),
        "truth": sum(len(v) for v in truth.values()),
        "found": scores["tp"],
        "drafts": scores["drafts"],
        "draftsPerPhoto": scores["draftsPerPhoto"],
        "unmatchedDrafts": scores["fp"],
        "tp": scores["tp"],
        "fp": scores["fp"],
        "fn": scores["fn"],
        "precision": scores["precision"],
        "recall": scores["recall"],
        "f1": scores["f1"],
        "perClass": scores["perClass"],
        "centreRule": metrics.centre_rule(drafts, truth, args.threshold),
        "failedPhotos": failed,
        "reviewGridMismatch": len(off_grid),
        "datasetHash": metrics.dataset_hash(ids, truth),
    }
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    (out / "report.json").write_text(json.dumps(report, indent=2), "utf-8")
    (out / "drafts.json").write_text(json.dumps(drafts, indent=2), "utf-8")
    (out / "pr.json").write_text(json.dumps(pr, indent=2), "utf-8")
    (out / "pr.csv").write_text(metrics.pr_csv(pr), "utf-8")
    per = SHEET_COLS * SHEET_ROWS
    for k in range(0, len(entries), per):
        _sheet(k // per + 1, entries[k : k + per], photos, truth, out, args.threshold)
    print(json.dumps({k: v for k, v in report.items() if k != "perClass"}, indent=2))

    code = 0
    if args.compare:
        reference = json.loads(Path(args.compare).read_text("utf-8"))
        res = metrics.compare(report, reference, args.tolerance)
        (out / "compare.json").write_text(json.dumps(res, indent=2), "utf-8")
        for w in res["warnings"]:
            print(f"Warning: {w}", file=sys.stderr)
        if res["status"] == "no-reference":
            print(f"No reference yet in {args.compare}: nothing to compare.")
        elif res["status"] == "regression":
            for r in res["regressions"]:
                print(f"REGRESSION: {r}", file=sys.stderr)
            code = 1
        else:
            print(f"Within {args.tolerance} of the reference.")
    if args.write_reference:
        Path(args.write_reference).parent.mkdir(parents=True, exist_ok=True)
        Path(args.write_reference).write_text(json.dumps(reference_of(report), indent=2) + "\n", "utf-8")
    return code


REFERENCE_SCHEMA = "aio.detector-bench-ref/1"
REFERENCE_METRICS = ("photos", "truth", "tp", "fp", "fn", "precision", "recall", "f1", "draftsPerPhoto")


def reference_of(report: dict[str, Any], today: datetime.date | None = None) -> dict[str, Any]:
    """The stored reference for a run: what was measured, on what, and the headline numbers."""
    return {
        "schema": REFERENCE_SCHEMA,
        "detector": report["detector"],
        "detectorVersion": report["detectorVersion"],
        "model": report["model"],
        "date": (today or datetime.date.today()).isoformat(),
        "datasetHash": report["datasetHash"],
        "split": report["split"],
        "threshold": report["threshold"],
        "iouMin": report["iouMin"],
        "truthClasses": report["truthClasses"],
        "metrics": {k: report[k] for k in REFERENCE_METRICS},
        "centreRule": report["centreRule"],
    }


def server_model(server: str, api_key: str | None) -> str | None:
    """The id of the model the server has loaded (first id of ``GET /v1/models``), else None."""
    req = urllib.request.Request(server.rstrip("/") + "/v1/models")
    if api_key:
        req.add_header("Authorization", f"Bearer {api_key}")
    try:
        with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(req, timeout=10) as r:
            data = json.load(r)
        return str(data["data"][0]["id"])
    except (OSError, ValueError, KeyError, IndexError, TypeError):
        return None


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Measure a detector on reference projects (read only).")
    ap.add_argument(
        "--project", required=True, action="append", help="a reference project; repeat for several"
    )
    ap.add_argument("--detector", required=True, help="an aio.vlm-detector/1 file")
    ap.add_argument("--server", required=True, help="llama-server URL")
    ap.add_argument("--model", help="model id, picks the box frame (default: the server's loaded model)")
    ap.add_argument("--split", required=True, choices=("tune", "bench"))
    ap.add_argument("--truth-class", action="append", default=[], help="class id; repeat for several")
    ap.add_argument("--threshold", type=float, default=0.8)
    ap.add_argument(
        "--iou", type=float, default=metrics.IOU_MIN, help="IoU a draft needs to take a truth item"
    )
    ap.add_argument("--limit", type=int, default=50, help="most photos to run per project")
    ap.add_argument("--api-key", default=os.environ.get("LLAMA_API_KEY"))
    ap.add_argument("--compare", help="a stored reference (aio.detector-bench-ref/1); exit 1 on a regression")
    ap.add_argument("--tolerance", type=float, default=0.05, help="largest drop in precision, recall or F1")
    ap.add_argument("--write-reference", help="write this run as a reference file")
    ap.add_argument("--out", required=True)
    return run(ap.parse_args(argv))


if __name__ == "__main__":
    raise SystemExit(main())
