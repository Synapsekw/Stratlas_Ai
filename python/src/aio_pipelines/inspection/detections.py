"""The detection pass hook: ``aio.detections/1`` files (and the kit's own formats) as kit detections.

Producers (a person reviewing photos, an AI vision pass, a local ONNX model) write their boxes to
``<project>/detections/*.json`` in the ``aio.detections/1`` contract (``@aio/schema``
``detections.ts``, data-conventions section 11). The kit's formats are accepted too: a kit list
(``[{"image", "class", "bbox", ...}]``), COCO, and YOLO folders with class names.

Rules (the same in the zod schema):
- Rejected detections never count; drafts (an AI pass not yet reviewed) count only with
  ``includeDrafts``; ``minConfidence`` drops weaker ones.
- ``class`` is a class id of the project's class catalogue (a class label is accepted too).
- ``severity`` is a level of that class's severity model, or ``"uncertain"``.
- ``bbox`` is ``[x0, y0, x1, y1]`` in ``space``: ``preview`` (pixels of the project photo, the
  default), ``source`` (pixels of an original of ``width`` x ``height``), ``normalized`` (0 to 1) or
  ``sheet`` (pixels of a contact sheet named in ``sheet``, from the last run's sheets).
- ``id`` is kept stable by the producer; without one it is derived from the photo, the class and
  the rounded box, which is also how duplicates across files are merged (kit README).
"""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
from typing import Any

from ..aik import contact as Ct
from ..aik import detections as D
from ..runtime import JobError

SCHEMA = "aio.detections/1"
SOURCES = ("human", "ai", "model", "import")
SPACES = ("preview", "source", "normalized", "sheet")
STATUSES = ("accepted", "draft", "rejected")


def detection_files(project: Path, paths: list[str], yolo: bool) -> list[tuple[Path, str]]:
    """``(path, format)`` for every detections file under the given files and folders."""
    out: list[tuple[Path, str]] = []
    for raw in paths:
        p = Path(raw)
        if not p.is_absolute():
            p = project / p
        if p.is_file():
            out.append((p, "json"))
        elif p.is_dir():
            out.extend((f, "json") for f in sorted(p.rglob("*.json")) if not f.name.startswith("."))
            if yolo and any(p.glob("*.txt")):
                out.append((p, "yolo"))
        elif raw != "detections":
            raise JobError(f'The detections "{raw}" do not exist.')
    return out


def derived_id(photo: str, cls: str, bbox) -> str:
    key = f"{photo}|{cls}|{','.join(str(round(v)) for v in bbox)}"
    return "d-" + hashlib.sha1(key.encode("utf-8")).hexdigest()[:12]


class Catalogue:
    """The project's classes and severity models, as detections and issues need them."""

    def __init__(self, manifest: dict[str, Any]):
        self.models = {m["id"]: m for m in manifest.get("severityModels", [])}
        self.classes: dict[str, dict[str, Any]] = {}
        for cat in manifest.get("classCatalogues", []):
            for c in cat.get("classes", []):
                self.classes.setdefault(c["id"], c)
        self.by_label = {c["label"].strip().lower(): c["id"] for c in self.classes.values()}
        self.asset_type = next((c.get("assetType") for c in manifest.get("classCatalogues", [])), None)
        if not self.models:
            raise JobError("The project has no severity model. Create it with the new project wizard.")
        if not self.classes:
            raise JobError("The project has no issue classes. Pick a severity template with classes.")

    def class_id(self, raw: Any) -> str | None:
        if not isinstance(raw, str):
            return None
        if raw in self.classes:
            return raw
        return self.by_label.get(raw.strip().lower())

    def model_of(self, class_id: str) -> dict[str, Any]:
        mid = self.classes[class_id].get("severityModel")
        return self.models.get(mid) or next(iter(self.models.values()))

    def levels(self, class_id: str) -> list[int]:
        return sorted(int(lv["value"]) for lv in self.model_of(class_id)["levels"])

    def default_severity(self, class_id: str) -> int:
        lv = self.levels(class_id)
        return 2 if 2 in lv else lv[0]  # kit adapter default: 2


class Reader:
    """Collects detections from every file into kit-format dicts with a stable id each."""

    def __init__(self, cat: Catalogue, cams: dict[str, dict[str, Any]], layout: list[dict[str, Any]], log):
        self.cat = cat
        self.cams = cams  # camera id -> {layer, photo, name, pw, ph}
        self.by_photo: dict[tuple[str | None, str], str] = {}
        for cid, c in cams.items():
            self.by_photo[(c["layer"], c["photo"])] = cid
            self.by_photo.setdefault((None, c["photo"]), cid)
        self.sheets = {s["name"]: s for s in layout}
        self.log = log
        self.meta: dict[str, dict[str, Any]] = {}
        self.dets: list[dict[str, Any]] = []
        self.seen: set[tuple[str, str, tuple[int, ...]]] = set()
        self.skipped: dict[str, int] = {}
        self.assessed: set[str] | None = set()

    def _skip(self, why: str) -> None:
        self.skipped[why] = self.skipped.get(why, 0) + 1

    def _cam(self, layer: str | None, photo: Any) -> str | None:
        if not isinstance(photo, str):
            return None
        cid = self.by_photo.get((layer, photo)) or self.by_photo.get((None, photo))
        if cid:
            return cid
        stem = os.path.splitext(os.path.basename(photo))[0]
        return next(
            (k for k, c in self.cams.items() if c["photo"] == stem or os.path.splitext(c["name"])[0] == stem),
            None,
        )

    def _add(self, d: dict[str, Any], meta: dict[str, Any], opts: dict[str, Any]) -> None:
        cls = self.cat.class_id(d.get("class"))
        if cls is None:
            self.log(
                f'Detection class "{d.get("class")}" is not one of the project classes; skipped.', "warn"
            )
            self._skip("unknown class")
            return
        d["class"] = cls
        sev = d.get("severity")
        uncertain = sev == "uncertain"
        if uncertain:
            sev = self.cat.levels(cls)[0]  # the kit grades every finding; kept apart as uncertain
        elif sev is None:
            sev = self.cat.default_severity(cls)
        elif not isinstance(sev, int) or isinstance(sev, bool) or sev not in self.cat.levels(cls):
            self.log(f"Severity {sev!r} is not a level of the {cls} model; the default is used.", "warn")
            sev = self.cat.default_severity(cls)
        d["severity"] = sev
        conf = d.get("confidence")
        if (
            opts.get("minConfidence") is not None
            and isinstance(conf, int | float)
            and conf < opts["minConfidence"]
        ):
            self._skip("below minimum confidence")
            return
        cam = self.cams[d["image"]]
        bbox = list(d["bbox"])
        if d.get("space") == "preview":
            pre = bbox
        elif d.get("normalized"):
            pre = [bbox[0] * cam["pw"], bbox[1] * cam["ph"], bbox[2] * cam["pw"], bbox[3] * cam["ph"]]
        else:
            sw, sh = d.get("width") or cam["pw"], d.get("height") or cam["ph"]
            pre = D._scale(bbox, sw, sh, cam["pw"], cam["ph"])
        x0, y0, x1, y1 = pre
        if not (x1 > x0 and y1 > y0):
            self._skip("empty box")
            return
        key = (d["image"], cls, tuple(round(v) for v in pre))
        if key in self.seen:
            self._skip("duplicate")
            return
        self.seen.add(key)
        did = d.get("id") if isinstance(d.get("id"), str) and d["id"] else derived_id(d["image"], cls, pre)
        base, n = did, 2
        while did in self.meta:
            did = f"{base}-{n}"
            n += 1
        d["id"] = did
        # scaled once here (kit maths); the kit adapter then takes review-copy pixels as they are
        d["bbox"] = [float(v) for v in pre]
        d["space"] = "preview"
        for k in ("normalized", "width", "height"):
            d.pop(k, None)
        self.dets.append(d)
        self.meta[did] = {**meta, "uncertain": uncertain, "camera": d["image"]}

    def add_native(self, doc: dict[str, Any], path: Path, opts: dict[str, Any]) -> None:
        source = doc.get("source") if doc.get("source") in SOURCES else "import"
        layer = doc.get("layer") if isinstance(doc.get("layer"), str) else None
        dets = doc.get("detections")
        if not isinstance(dets, list):
            raise JobError(f"{path.name}: detections must be a list.")
        assessed = doc.get("assessed", "all")
        if assessed == "all":
            self.assessed = None
        elif isinstance(assessed, list) and self.assessed is not None:
            for a in assessed:
                cid = self._cam(layer, a)
                if cid:
                    self.assessed.add(cid)
        for i, raw in enumerate(dets):
            if not isinstance(raw, dict):
                raise JobError(f"{path.name}: detection {i + 1} is not an object.")
            status = raw.get("status", "accepted")
            if status not in STATUSES:
                raise JobError(f'{path.name}: detection {i + 1} has status "{status}".')
            if status == "rejected":
                self._skip("rejected")
                continue
            if status == "draft" and not opts.get("includeDrafts"):
                self._skip("draft, not reviewed")
                continue
            space = raw.get("space", "preview")
            if space not in SPACES:
                raise JobError(f'{path.name}: detection {i + 1} has space "{space}".')
            bbox = raw.get("bbox")
            if not (
                isinstance(bbox, list) and len(bbox) == 4 and all(isinstance(v, int | float) for v in bbox)
            ):
                raise JobError(f"{path.name}: detection {i + 1} needs bbox [x0, y0, x1, y1].")
            photo = raw.get("photo")
            if space == "sheet":
                sheet = self.sheets.get(str(raw.get("sheet")))
                hit = Ct.sheet_to_photo(sheet, bbox) if sheet else None
                if not hit:
                    self.log(
                        f"{path.name}: detection {i + 1} is not on a photo of a contact sheet; skipped.",
                        "warn",
                    )
                    self._skip("not on a contact sheet photo")
                    continue
                cid = hit["image"]
                bbox, space = hit["bbox"], "preview"
            else:
                cid = self._cam(layer, photo)
            if not cid:
                self.log(
                    f'{path.name}: photo "{photo}" is not a placed photo of this project; skipped.', "warn"
                )
                self._skip("photo not placed")
                continue
            d = {
                "id": raw.get("id"),
                "image": cid,
                "class": raw.get("class"),
                "severity": raw.get("severity"),
                "bbox": bbox,
                "note": raw.get("note") or "",
                "confidence": raw.get("confidence"),
                "component": raw.get("component"),
                "space": "preview" if space == "preview" else None,
                "normalized": space == "normalized",
                "width": raw.get("width") if space == "source" else None,
                "height": raw.get("height") if space == "source" else None,
            }
            self._add(d, {"source": raw.get("source") if raw.get("source") in SOURCES else source,
                          "file": path.name, "status": status}, opts)  # fmt: skip

    def add_kit(self, dets: list[dict[str, Any]], path: Path, fmt: str, opts: dict[str, Any]) -> None:
        self.assessed = None  # the kit adapter assesses every photo
        for raw in dets:
            cid = self._cam(None, raw.get("image"))
            if not cid:
                self.log(f"[detections] unknown image {raw.get('image')}", "warn")
                self._skip("photo not placed")
                continue
            d = dict(raw)
            d["image"] = cid
            self._add(d, {"source": "import", "file": path.name, "status": "accepted", "format": fmt}, opts)

    def read(self, files: list[tuple[Path, str]], opts: dict[str, Any]) -> None:
        names = opts.get("yoloNames")
        for path, kind in files:
            if kind == "yolo":
                self.add_kit(D.read_detections(str(path), "yolo", names=names), path, "yolo", opts)
                continue
            try:
                doc = json.loads(path.read_text("utf-8"))
            except (OSError, ValueError) as e:
                raise JobError(f"Could not read the detections {path.name}: {e}") from e
            if isinstance(doc, dict) and doc.get("schema") == SCHEMA:
                self.add_native(doc, path, opts)
            elif isinstance(doc, list):
                self.add_kit(D.read_detections(str(path), "kit"), path, "kit", opts)
            elif isinstance(doc, dict) and "annotations" in doc and "images" in doc:
                self.add_kit(D.read_detections(str(path), "coco"), path, "coco", opts)
            elif (
                isinstance(doc, dict)
                and isinstance(doc.get("schema"), str)
                and doc["schema"].startswith("aio.detections/")
            ):
                raise JobError(f"{path.name} is {doc['schema']}; this pack reads {SCHEMA}.")
            else:
                self.log(f"{path.name} is not a detections file; skipped.", "warn")
