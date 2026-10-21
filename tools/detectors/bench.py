"""Detector bench: run one vision-model detector over a reference project's photos and measure it.

    uv run --project python python tools/detectors/bench.py --project <dir> --detector <detector.json> \
        --server <url> --split tune|bench [--truth-class <id>...] [--threshold 0.8] [--limit 50] --out <dir>

The project is only read, never written to. Photos come from the manifest's photo layers. Truth is
every image sighting of an issue whose shape has bounds (box, rotated box, polygon), plus every
accepted detection of ``detections/*.json``, filtered by ``--truth-class``. A draft at or above the
threshold is a hit when its box contains the centre of a truth item. Output in ``--out``:
``report.json``, ``drafts.json`` and ``sheet-<n>.jpg`` contact sheets.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import sys
from pathlib import Path
from typing import Any

from PIL import Image, ImageDraw

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "python" / "src"))

from aio_pipelines.detect.engine import VlmClient, VlmUnavailable, run_detector
from aio_pipelines.inspection.frame import asset_path, photo_layers, read_manifest

Box = tuple[float, float, float, float]

TUNE_SHARE = 3  # of 10
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


def load_truth(project: Path, classes: set[str], sizes: dict[str, tuple[int, int]]) -> dict[str, list[Box]]:
    """Truth boxes per photo id, in photo pixels. ``classes`` empty: every class."""
    truth: dict[str, list[Box]] = {}

    def add(photo: str, box: Box | None) -> None:
        if box is None or photo not in sizes:
            return
        mine = truth.setdefault(photo, [])
        c = centre(box)
        # The same finding recorded as an issue and as an accepted detection counts once.
        if not any(_contains(o, c) or _contains(box, centre(o)) for o in mine):
            mine.append(box)

    doc = _read_json(project / "issues.json")
    issues = doc.get("issues", []) if isinstance(doc, dict) else doc
    for issue in issues if isinstance(issues, list) else []:
        if not isinstance(issue, dict) or (classes and issue.get("classId") not in classes):
            continue
        for s in issue.get("sightings", []):
            if isinstance(s, dict) and s.get("on") == "image" and isinstance(s.get("geom"), dict):
                add(str(s.get("photo")), truth_box(s["geom"]))
    for f in sorted((project / "detections").glob("*.json")):
        pass_doc = _read_json(f)
        for d in pass_doc.get("detections", []) if isinstance(pass_doc, dict) else []:
            if not isinstance(d, dict) or d.get("status") != "accepted" or d.get("frame"):
                continue
            if classes and d.get("class") not in classes:
                continue
            photo = str(d.get("photo"))
            if photo in sizes:
                add(photo, _detection_box(d, sizes[photo]))
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
    truth: dict[str, list[Box]],
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
        for b in truth.get(e["photo"], []):
            draw.rectangle([v * scale for v in b], outline=GREEN, width=3)
        for d in e["drafts"]:
            at = d["score"] is not None and d["score"] >= threshold
            colour = (HIT if d["matched"] else DRAFT) if at else DIM
            draw.rectangle([v * scale for v in d["box"]], outline=colour, width=2)
            label = "n/a" if d["score"] is None else f"{d['score']:.2f}"
            draw.text((d["box"][0] * scale + 2, d["box"][1] * scale + 2), label, fill=colour)
        draw.text((4, thumb.height - 12), e["photo"], fill=(255, 255, 255))
        sheet.paste(thumb, ((i % SHEET_COLS) * CELL_W, (i // SHEET_COLS) * CELL_H))
    sheet.save(out / f"sheet-{n}.jpg", quality=88)


def run(args: argparse.Namespace) -> int:
    project = Path(args.project)
    detector = json.loads(Path(args.detector).read_text("utf-8"))
    all_photos = find_photos(project)
    want_tune = args.split == "tune"
    ids = sorted(p for p in all_photos if in_tune(p) == want_tune)[: args.limit]
    photos = {p: all_photos[p] for p in ids}
    sizes: dict[str, tuple[int, int]] = {}
    for pid, path in photos.items():
        with Image.open(path) as im:
            sizes[pid] = (im.width, im.height)
    classes = set(args.truth_class or [])
    truth = load_truth(project, classes, sizes)

    client = VlmClient(args.server, api_key=args.api_key)
    entries: list[dict[str, Any]] = []
    failed = 0
    for pid in ids:
        try:
            with Image.open(photos[pid]) as im:
                im.load()
                result = run_detector(client, im, detector)
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

    found = 0
    for e in entries:
        for t in truth.get(e["photo"], []):
            hit = [
                d
                for d in e["drafts"]
                if d["score"] is not None
                and d["score"] >= args.threshold
                and _contains(tuple(d["box"]), centre(t))
            ]
            if hit:
                found += 1
                for d in hit:
                    d["matched"] = True
    drafts = [d for e in entries for d in e["drafts"]]
    above = [d for d in drafts if d["score"] is not None and d["score"] >= args.threshold]
    n_truth = sum(len(v) for v in truth.values())
    report = {
        "photos": len(ids),
        "truth": n_truth,
        "found": found,
        "recall": found / n_truth if n_truth else None,
        "drafts": len(above),
        "draftsPerPhoto": len(above) / len(ids) if ids else None,
        "unmatchedDrafts": sum(1 for d in above if not d["matched"]),
        "failedPhotos": failed,
        "split": args.split,
        "threshold": args.threshold,
        "detector": detector.get("id"),
    }
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    (out / "report.json").write_text(json.dumps(report, indent=2), "utf-8")
    (out / "drafts.json").write_text(json.dumps(drafts, indent=2), "utf-8")
    per = SHEET_COLS * SHEET_ROWS
    for k in range(0, len(entries), per):
        _sheet(k // per + 1, entries[k : k + per], photos, truth, out, args.threshold)
    print(json.dumps(report, indent=2))
    return 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Measure a detector on a reference project (read only).")
    ap.add_argument("--project", required=True)
    ap.add_argument("--detector", required=True, help="an aio.vlm-detector/1 file")
    ap.add_argument("--server", required=True, help="llama-server URL")
    ap.add_argument("--split", required=True, choices=("tune", "bench"))
    ap.add_argument("--truth-class", action="append", default=[], help="class id; repeat for several")
    ap.add_argument("--threshold", type=float, default=0.8)
    ap.add_argument("--limit", type=int, default=50, help="most photos to run")
    ap.add_argument("--api-key", default=os.environ.get("LLAMA_API_KEY"))
    ap.add_argument("--out", required=True)
    return run(ap.parse_args(argv))


if __name__ == "__main__":
    raise SystemExit(main())
