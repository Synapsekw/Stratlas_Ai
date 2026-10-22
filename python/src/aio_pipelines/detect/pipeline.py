"""`detect.vlm`: run the project's local vision-model detectors over photos and write a draft pass.

Steps (each resumable):

1. prepare: finds each photo's file in the photos layer and reads its size. A photo that is not in
   the layer, is missing or cannot be read is skipped with a warning.
2. detect: reads the server state file (the model server is started by the app), then for each
   photo and detector runs the engine (`engine.run_detector`) and stages `results/<n>-<photo>--<detector>.json`.
   A result already staged is not run again, so a cancelled or stopped job continues with the
   photos left. Results with every tile failed are not staged (a resume tries them again).
3. commit: assembles `detections/vlm-<run>.json` (an `aio.detections/1` pass of draft detections)
   from the staged results and moves it into the project.

Every candidate is kept; one scored under its detector's threshold carries ``belowThreshold``, one
the model could not score carries ``unscored`` and no ``confidence``. A detector whose class is not
in the project's catalogues keeps its class id in ``class`` and adds ``label`` (its name) and
``suggestedNew``.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

from ..params import known_keys
from ..runtime import JobError, Step, StepContext, atomic_write_json, commit_files, now_iso

DETECTIONS_SCHEMA = "aio.detections/1"
DETECTOR_SCHEMA = "aio.vlm-detector/1"
RUN_ID = re.compile(r"^run-[a-z0-9-]{1,60}$")
DETECTOR_ID = re.compile(r"^[a-z0-9][a-z0-9-]{1,60}$")
SHA256 = re.compile(r"^[a-f0-9]{64}$")
ABSOLUTE = re.compile(r"^([A-Za-z]:[\\/]|/|\\\\)")
WHERE = ("shipped", "project", "library")
MAX_PHOTOS = 5000
MAX_DETECTORS = 10
MAX_FAILED_IN_A_ROW = 3

STOPPED = "The detector model stopped. Run the remaining photos again."
ALL_FAILED = "The detector model could not read any of the photos. Run the detectors again."
NO_PHOTOS = "None of the chosen photos could be opened. Check that the photo files are still in the project."

_DETECTOR_KEYS = {
    "schema", "id", "name", "version", "classId", "assetTypes", "looksLike", "ignore", "question",
    "tiles", "threshold", "tunedOn", "author", "createdAt", "updatedAt", "source", "status",
    "samples", "examples",
}  # fmt: skip
_DETECTOR_REQUIRED = _DETECTOR_KEYS - {"samples", "examples"}
_ITEM_KEYS = {"where", "detector", "threshold"}
_KEYS = {"run", "layer", "photos", "detectors", "serverFile", "modelSha256", "model"}


def _is_number(v: Any) -> bool:
    return isinstance(v, int | float) and not isinstance(v, bool)


def _is_int(v: Any) -> bool:
    return isinstance(v, int) and not isinstance(v, bool)


def _validate_tiles(tiles: Any) -> dict[str, Any]:
    if not isinstance(tiles, dict) or set(tiles) != {"n", "overlap", "sendW", "sendH"}:
        raise JobError("A detector's tiles must be {n, overlap, sendW, sendH}.")
    if not _is_int(tiles["n"]) or not 1 <= tiles["n"] <= 4:
        raise JobError("tiles.n must be a whole number from 1 to 4.")
    if not _is_number(tiles["overlap"]) or not 0 <= tiles["overlap"] <= 0.5:
        raise JobError("tiles.overlap must be between 0 and 0.5.")
    for side in ("sendW", "sendH"):
        v = tiles[side]
        if not _is_int(v) or not 280 <= v <= 2016 or v % 28:
            raise JobError(f"tiles.{side} must be a multiple of 28 from 280 to 2016.")
    return dict(tiles)


def _validate_detector(det: Any) -> dict[str, Any]:
    if not isinstance(det, dict):
        raise JobError("A detector must be an object.")
    extra = sorted(set(det) - _DETECTOR_KEYS)
    if extra:
        raise JobError(f"A detector does not take: {', '.join(extra)}.")
    missing = sorted(_DETECTOR_REQUIRED - set(det))
    if missing:
        raise JobError(f"A detector needs: {', '.join(missing)}.")
    if det["schema"] != DETECTOR_SCHEMA:
        raise JobError(f"A detector's schema must be {DETECTOR_SCHEMA}.")
    if not isinstance(det["id"], str) or not DETECTOR_ID.match(det["id"]):
        raise JobError("A detector id is lowercase letters, digits and dashes.")
    if not isinstance(det["name"], str) or not 1 <= len(det["name"]) <= 80:
        raise JobError("A detector name is 1 to 80 characters.")
    if not _is_int(det["version"]) or det["version"] < 1:
        raise JobError("A detector version is a whole number from 1.")
    for key, lo, hi in (
        ("classId", 1, 120),
        ("looksLike", 1, 2000),
        ("question", 1, 1000),
        ("ignore", 0, 2000),
    ):
        if not isinstance(det[key], str) or not lo <= len(det[key]) <= hi:
            raise JobError(f"A detector's {key} must be text of {lo} to {hi} characters.")
    if not _is_number(det["threshold"]) or not 0 <= det["threshold"] <= 1:
        raise JobError("A detector's threshold must be between 0 and 1.")
    out = dict(det)
    out["tiles"] = _validate_tiles(det["tiles"])
    return out


class DetectVlm:
    name = "detect.vlm"
    title = "Run detectors"
    description = "Run local vision-model detectors over photos and write the candidates as draft detections."

    def validate(self, params: dict[str, Any]) -> dict[str, Any]:
        known_keys(params, set(_KEYS), self.name)
        run = params.get("run")
        if not isinstance(run, str) or not RUN_ID.match(run):
            raise JobError("run must look like run-<letters, digits and dashes>.")
        layer = params.get("layer")
        if not isinstance(layer, str) or not 1 <= len(layer) <= 128:
            raise JobError("layer must be a photos layer id.")
        photos = params.get("photos")
        if (
            not isinstance(photos, list)
            or not 1 <= len(photos) <= MAX_PHOTOS
            or not all(isinstance(p, str) and 1 <= len(p) <= 128 for p in photos)
        ):
            raise JobError(f"photos must be a list of 1 to {MAX_PHOTOS} photo ids.")
        items = params.get("detectors")
        if not isinstance(items, list) or not 1 <= len(items) <= MAX_DETECTORS:
            raise JobError(f"detectors must be a list of 1 to {MAX_DETECTORS} detectors.")
        detectors: list[dict[str, Any]] = []
        for item in items:
            if not isinstance(item, dict) or set(item) != _ITEM_KEYS:
                raise JobError("Each detector entry must be {where, detector, threshold}.")
            if item["where"] not in WHERE:
                raise JobError(f"where must be one of {', '.join(WHERE)}.")
            if not _is_number(item["threshold"]) or not 0 <= item["threshold"] <= 1:
                raise JobError("threshold must be between 0 and 1.")
            detectors.append(
                {
                    "where": item["where"],
                    "detector": _validate_detector(item["detector"]),
                    "threshold": float(item["threshold"]),
                }
            )
        ids = [d["detector"]["id"] for d in detectors]
        if len(set(ids)) != len(ids):
            raise JobError("Each detector can be used once in a run.")
        server_file = params.get("serverFile")
        if not isinstance(server_file, str) or not ABSOLUTE.match(server_file):
            raise JobError("serverFile must be an absolute path.")
        sha = params.get("modelSha256")
        if not isinstance(sha, str) or not SHA256.match(sha):
            raise JobError("modelSha256 must be 64 lowercase hex characters.")
        model = params.get("model")
        if not isinstance(model, str) or not model.strip():
            raise JobError("model must be a non-empty text.")
        return {
            "run": run,
            "layer": layer,
            "photos": list(photos),
            "detectors": detectors,
            "serverFile": server_file,
            "modelSha256": sha,
            "model": model,
        }

    def inputs(self, params: dict[str, Any], project: Path) -> list[str]:
        """The photo files, so a resumed job refuses photos that changed."""
        try:
            files = [str(p) for _, p in _find_photos(_manifest(project), project, params)[0]]
        except JobError:
            return ["manifest.json"]
        return files or ["manifest.json"]

    def plan(self, params: dict[str, Any]) -> list[Step]:
        run_id = params["run"]
        detectors: list[dict[str, Any]] = params["detectors"]

        def prepare_step(ctx: StepContext) -> dict[str, Any]:
            ctx.progress(0.0, "Finding the photos")
            found, problems = _find_photos(_manifest(ctx.project), ctx.project, params)
            for problem in problems:
                ctx.log(problem, "warn")
            photos: list[dict[str, Any]] = []
            for k, (photo_id, path) in enumerate(found):
                ctx.check()
                size = _image_size(path)
                if size is None:
                    ctx.log(f"Photo {photo_id} cannot be opened as an image; skipped.", "warn")
                    continue
                photos.append({"id": photo_id, "path": str(path), "width": size[0], "height": size[1]})
                ctx.progress((k + 1) / max(1, len(found)))
            if not photos:
                raise JobError(NO_PHOTOS)
            manifest = _manifest(ctx.project)
            class_ids = sorted(
                {
                    c["id"]
                    for cat in manifest.get("classCatalogues", [])
                    for c in cat.get("classes", [])
                    if isinstance(c, dict) and isinstance(c.get("id"), str)
                }
            )
            return {
                "photos": photos,
                "skipped": len(params["photos"]) - len(photos),
                "classIds": class_ids,
            }

        def detect_step(ctx: StepContext) -> dict[str, Any]:
            from PIL import Image

            from .engine import VlmUnavailable, run_detector

            photos: list[dict[str, Any]] = ctx.outputs("prepare")["photos"]
            client = _client(params["serverFile"])
            total = len(photos) * len(detectors)
            done = ok = failed = streak = 0
            for pi, photo in enumerate(photos):
                for entry in detectors:
                    det = entry["detector"]
                    ctx.progress(done / max(1, total), f"photo {pi + 1} of {len(photos)}, {det['name']}")
                    ctx.check()
                    done += 1
                    staged = ctx.stage(_result_name(pi, photo["id"], det["id"]))
                    if staged.exists():
                        ok += 1
                        streak = 0
                        continue
                    try:
                        with Image.open(photo["path"]) as im:
                            im.load()
                            result = run_detector(client, im, _fit_tiles(det, im.width, im.height))
                    except VlmUnavailable as e:
                        raise JobError(STOPPED) from e
                    except OSError as e:
                        ctx.log(
                            f"Photo {photo['id']} could not be read ({type(e).__name__}); skipped.", "warn"
                        )
                        failed += 1
                        continue
                    for w in result.warnings:
                        ctx.log(f"Photo {photo['id']}, {det['name']}: {w}", "warn")
                    if result.failed:
                        failed += 1
                        streak += 1
                        ctx.log(
                            f"Photo {photo['id']}: the model gave no usable answer for {det['name']}.", "warn"
                        )
                        if streak >= MAX_FAILED_IN_A_ROW:
                            raise JobError(STOPPED)
                        continue
                    streak = 0
                    ok += 1
                    atomic_write_json(
                        staged,
                        {
                            "photo": photo["id"],
                            "detector": det["id"],
                            "candidates": [
                                {"box": list(c.box), "note": c.note, "score": c.score}
                                for c in result.candidates
                            ],
                        },
                    )
            if ok == 0:
                raise JobError(ALL_FAILED)
            ctx.progress(1.0)
            return {"results": ok, "failed": failed}

        def commit_step(ctx: StepContext) -> dict[str, Any]:
            ctx.progress(0.0, "Saving the detections")
            photos: list[dict[str, Any]] = ctx.outputs("prepare")["photos"]
            # a job prepared before classIds existed has none: keep the detector's class as it was
            known = ctx.outputs("prepare").get("classIds")
            class_ids = None if known is None else set(known)
            model = params["model"]
            created = now_iso()
            assessed: list[str] = []
            dets: list[dict[str, Any]] = []
            for pi, photo in enumerate(photos):
                # assessed only when every detector of the run has a result for the photo: one
                # that failed must not read as "checked, nothing found"
                ran_all = True
                for entry in detectors:
                    det = entry["detector"]
                    staged = ctx.stage(_result_name(pi, photo["id"], det["id"]))
                    if not staged.exists():
                        ran_all = False
                        continue
                    result = json.loads(staged.read_text("utf-8"))
                    for k, c in enumerate(result["candidates"]):
                        score = c.get("score")
                        d: dict[str, Any] = {
                            "id": f"{run_id}-{photo['id']}-{det['id']}-{k}",
                            "photo": photo["id"],
                            "class": det["classId"],
                            "severity": "uncertain",
                        }
                        if class_ids is not None and det["classId"] not in class_ids:
                            # the project lacks the class: offer the detector's name as a new one.
                            # `class` keeps the detector's class id (aio.detections/1 needs a
                            # non-empty class; the review reads an unknown one as no class yet)
                            d["label"] = det["name"]
                            d["suggestedNew"] = True
                        if score is not None:
                            d["confidence"] = round(float(score), 4)
                        d["note"] = c.get("note", "")
                        d["status"] = "draft"
                        d["bbox"] = [round(float(v), 1) for v in c["box"]]
                        d["space"] = "source"
                        d["width"] = photo["width"]
                        d["height"] = photo["height"]
                        if score is None:
                            d["unscored"] = True
                        elif score < entry["threshold"]:
                            d["belowThreshold"] = True
                        d["origin"] = {
                            "runId": run_id,
                            "model": model,
                            "detectorId": det["id"],
                            "detectorVersion": det["version"],
                            "modelSha256": params["modelSha256"],
                            "threshold": entry["threshold"],
                        }
                        dets.append(d)
                if ran_all:
                    assessed.append(photo["id"])
            doc = {
                "schema": DETECTIONS_SCHEMA,
                "source": "model",
                "producer": f"{model} (local)",
                "layer": params["layer"],
                "assessed": assessed,
                "detectors": [
                    {
                        "id": e["detector"]["id"],
                        "version": e["detector"]["version"],
                        "classId": e["detector"]["classId"],
                        "name": e["detector"]["name"],
                        "modelSha256": params["modelSha256"],
                        "threshold": e["threshold"],
                    }
                    for e in detectors
                ],
                "createdAt": created,
                "run": {
                    "id": run_id,
                    "at": created,
                    "provider": "local",
                    "model": model,
                    "promptVersion": "detectors",
                    "images": len(assessed),
                    "detections": len(dets),
                },
                "detections": dets,
            }
            rel = _pass_name(run_id)
            atomic_write_json(ctx.stage(rel), doc)
            commit_files(ctx, [(rel, f"detections/{rel}")])
            ctx.log(f"{len(dets)} candidates on {len(assessed)} photos.")
            ctx.progress(1.0)
            return {"pass": f"detections/{rel}", "photos": len(assessed), "detections": len(dets)}

        return [
            Step("prepare", "Finding the photos", prepare_step, 0.05),
            Step("detect", "Running detectors", detect_step, 0.9),
            Step("commit", "Saving the detections", commit_step, 0.05),
        ]


def _pass_name(run_id: str) -> str:
    return f"vlm-{re.sub(r'[^A-Za-z0-9._-]', '-', run_id)[:100]}.json"


def _result_name(index: int, photo_id: str, detector_id: str) -> str:
    return f"results/{index}-{re.sub(r'[^A-Za-z0-9._-]', '_', photo_id)[:80]}--{detector_id}.json"


def _manifest(project: Path) -> dict[str, Any]:
    from ..inspection.frame import read_manifest

    return read_manifest(project)


def _find_photos(
    manifest: dict[str, Any], project: Path, params: dict[str, Any]
) -> tuple[list[tuple[str, Path]], list[str]]:
    """The (photo id, file) pairs that exist, in the order asked and without repeats, and a
    warning for each one left out."""
    from ..inspection.frame import asset_path

    layer = next(
        (
            x
            for x in manifest.get("layers", [])
            if x.get("id") == params["layer"] and x.get("kind") == "photos"
        ),
        None,
    )
    if layer is None:
        raise JobError(f'The project has no photos layer "{params["layer"]}".')
    items = {it.get("id"): it for it in layer.get("items", []) if isinstance(it, dict)}
    found: list[tuple[str, Path]] = []
    problems: list[str] = []
    seen: set[str] = set()
    for photo_id in params["photos"]:
        if photo_id in seen:
            continue
        seen.add(photo_id)
        item = items.get(photo_id)
        if item is None:
            problems.append(f"Photo {photo_id} is not in the photos layer; skipped.")
            continue
        path = asset_path(project, item.get("src"))
        if path is None or not path.is_file():
            problems.append(f"Photo {photo_id} is missing from the project folder; skipped.")
            continue
        found.append((photo_id, path))
    return found, problems


def _image_size(path: Path) -> tuple[int, int] | None:
    from PIL import Image

    try:
        with Image.open(path) as im:
            return im.width, im.height
    except (OSError, ValueError):
        return None


def _fit_tiles(det: dict[str, Any], width: int, height: int) -> dict[str, Any]:
    """A photo no bigger than the size sent to the model is sent whole (n = 1): tiling it would
    only enlarge pieces of it further."""
    tiles = det["tiles"]
    if tiles["n"] > 1 and width <= tiles["sendW"] and height <= tiles["sendH"]:
        return {**det, "tiles": {**tiles, "n": 1}}
    return det


def _client(server_file: str):
    from .engine import VlmClient

    try:
        state = json.loads(Path(server_file).read_text("utf-8"))
        return VlmClient(state["url"], api_key=state["apiKey"])
    except (OSError, ValueError, KeyError, TypeError) as e:
        raise JobError(STOPPED) from e
