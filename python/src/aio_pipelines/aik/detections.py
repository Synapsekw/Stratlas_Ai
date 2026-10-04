"""Detections -> assessment.json (canonical findings). Ported from Asset Inspection Kit ``kit/adapters/detections.py``.

Accepted inputs (bbox coordinates are scaled from the source image size to the review copy automatically):
  kit list  [{"image": "DJI_0001.JPG" (or photo id "p001"), "class": "corrosion", "severity": 2,
             "bbox": [x0, y0, x1, y1], "note": "...", "confidence": 0.8, "component": "Leg A"}]
            bbox in source-image pixels; "normalized": true for 0..1; "space": "preview" for review-copy pixels
  COCO      {"images": [{id, file_name, width, height}], "annotations": [{image_id, category_id, bbox: [x, y, w, h],
             score?, attributes?: {severity, note}}], "categories": [{id, name}]}
            + class_map {category name -> profile class key} + default severities per class
  YOLO      folder of <image>.txt lines "cls cx cy w h [conf]" (normalised) + names list (index -> profile class key)
Photos without detections become status "none" (or "not-assessed" if listed in skip).

The maths (scaling, ids, statuses, notes) is the kit's. What changed: the result is returned (and
written to ``out`` when given) instead of printed, unknown images go to ``log``, and files are
read with explicit encodings.
"""

from __future__ import annotations

import glob
import json
import os
from collections.abc import Callable
from typing import Any


def _scale(bbox, sw, sh, pw, ph, norm=False):
    x0, y0, x1, y1 = bbox
    if norm:
        return [x0 * pw, y0 * ph, x1 * pw, y1 * ph]
    return [x0 * pw / sw, y0 * ph / sh, x1 * pw / sw, y1 * ph / sh]


def read_detections(src, fmt="kit", names=None, class_map=None) -> list[dict[str, Any]]:
    """The kit's three input formats as one kit-format list (the first half of ``convert``)."""
    dets: list[dict[str, Any]] = []
    if fmt == "kit":
        with open(src, encoding="utf-8") as f:
            for d in json.load(f):
                dets.append(d)
    elif fmt == "coco":
        with open(src, encoding="utf-8") as f:
            co = json.load(f)
        imgs = {i["id"]: i for i in co["images"]}
        cats = {c["id"]: c["name"] for c in co["categories"]}
        for a in co["annotations"]:
            im = imgs[a["image_id"]]
            x, y, w, h = a["bbox"]
            at = a.get("attributes", {})
            cls = (class_map or {}).get(cats[a["category_id"]], cats[a["category_id"]])
            dets.append(
                {
                    "image": im["file_name"],
                    "width": im.get("width"),
                    "height": im.get("height"),
                    "class": cls,
                    "bbox": [x, y, x + w, y + h],
                    "severity": at.get("severity"),
                    "note": at.get("note"),
                    "confidence": a.get("score"),
                }
            )
    elif fmt == "yolo":
        for fn in sorted(glob.glob(os.path.join(src, "*.txt"))):
            stem = os.path.splitext(os.path.basename(fn))[0]
            with open(fn, encoding="utf-8") as f:
                for line in f:
                    v = line.split()
                    if len(v) < 5:
                        continue
                    k, cx, cy, w, h = int(v[0]), *map(float, v[1:5])
                    dets.append(
                        {
                            "image": stem,
                            "class": names[k],
                            "bbox": [cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2],
                            "normalized": True,
                            "confidence": float(v[5]) if len(v) > 5 else None,
                        }
                    )
    else:
        raise ValueError(f"unknown detections format {fmt}")
    return dets


def convert_list(
    job,
    dets: list[dict[str, Any]],
    method: str,
    default_severity=None,
    skip=(),
    out: str | None = None,
    log: Callable[[str], None] = print,
) -> dict[str, Any]:
    """The second half of the kit's ``convert``: kit-format detections -> assessment document."""
    with open(job.p(job.inputs.get("cameras", "cameras.json")), encoding="utf-8") as f:
        cams = json.load(f)["photos"]
    from PIL import Image

    by_name = {}
    for c in cams:
        with Image.open(job.p(c["file"])) as im:
            c["_pw"], c["_ph"] = im.size
        by_name[c["name"]] = c
        by_name[os.path.splitext(c["name"])[0]] = c
        by_name[c["id"]] = c
        if c.get("source_name"):
            by_name[c["source_name"]] = c
    sev_default = default_severity or {c["key"]: c.get("severity", 2) for c in job.profile["classes"]}
    photos = {c["id"]: {"status": "not-assessed" if c["name"] in skip else "none", "note": ""} for c in cams}
    findings: list[dict[str, Any]] = []
    for d in dets:
        c = (
            by_name.get(d["image"])
            or by_name.get(os.path.basename(d["image"]))
            or by_name.get(os.path.splitext(os.path.basename(d["image"]))[0])
        )
        if not c:
            log(f"[detections] unknown image {d['image']}")
            continue
        sw, sh = d.get("width") or c["width"], d.get("height") or c["height"]
        bb = (
            list(d["bbox"])
            if d.get("space") == "preview"
            else _scale(d["bbox"], sw, sh, c["_pw"], c["_ph"], d.get("normalized"))
        )
        cls = d.get("class")
        findings.append(
            {
                "id": d.get("id") or f"{c['id']}-{len([f for f in findings if f['photo'] == c['id']]) + 1}",
                "photo": c["id"],
                "class": cls,
                "severity": int(d.get("severity") or sev_default.get(cls, 2)),
                "bbox": [round(v, 1) for v in bb],
                "note": d.get("note") or "",
                "confidence": d.get("confidence"),
                "component": d.get("component"),
            }
        )
        ph = photos[c["id"]]
        ph["status"] = "finding"
        if d.get("note") and d["note"] not in ph["note"]:
            ph["note"] = (ph["note"] + " " + d["note"]).strip()
    doc = {"method": method, "photos": photos, "findings": findings}
    if out:
        with open(out, "w", encoding="utf-8") as f:
            json.dump(doc, f, indent=1)
    n_photos = sum(1 for p in photos.values() if p["status"] == "finding")
    log(f"[detections] {len(findings)} findings in {n_photos} photos")
    return doc


def convert(job, src, fmt="kit", names=None, class_map=None, default_severity=None, skip=(), log=print):
    """The kit's command: read ``src`` in ``fmt`` and write the job's assessment.json."""
    dets = read_detections(src, fmt, names, class_map)
    out = job.p(job.inputs.get("assessment", "assessment.json"))
    convert_list(job, dets, f"detections imported ({fmt})", default_severity, skip, out, log)
    return out
