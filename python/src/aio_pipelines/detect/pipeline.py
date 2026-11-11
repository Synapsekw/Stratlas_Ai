"""`detect.vlm`: run the project's local vision-model detectors over photos and write a draft pass.

Steps (each resumable):

1. prepare: finds each photo's file in the photos layer and reads its size. A photo that is not in
   the layer, is missing or cannot be read is skipped with a warning.
2. detect: reads the server state file (the model server is started by the app), then for each
   photo and detector runs the engine (`engine.run_detector`) and stages `results/<n>-<photo>--<detector>.json`.
   A result already staged is not run again, so a cancelled or stopped job continues with the
   photos left. Results with every tile failed are not staged (a resume tries them again). A
   detector with ``objectSizeM`` gets its tile count from the photo's ground sample distance when
   prepare could read one (near-nadir photos); a result cut to ``engine.MAX_CANDIDATES`` is staged
   with ``capped`` and counted in the step outputs (``capped``).
3. commit: assembles `detections/vlm-<run>.json` (an `aio.detections/1` pass of draft detections)
   from the staged results and moves it into the project. Before it is written, the multi-view
   vote (``multiview/``) folds the drafts of one object seen in several posed photos into one
   draft with a ``vote``; single-view outliers are kept and flagged.

Walk frames (``frames: [{layer, t}]``, pipeline pack 0.35.0): a run reads either photos or the
frames of one 360 walk, never both (the app makes one run per layer). ``layer`` is then the walk
layer, every frame names it, and ``photos`` is empty. Prepare decodes each frame of the walk's
playback copy (``src``) at ``t`` with ffmpeg (``-ss t -frames:v 1``; a frame that does not decode
is skipped with a warning, as a missing photo) and cuts ``equirect.FACE_YAWS`` perspective faces
(``equirect.render_face``, ``FACE_FOV`` wide, ``FACE_SIZE`` square) into staging. Detect runs
every detector on every face as on a photo (one staged result per face, so a resume continues).
Commit maps the face boxes back to the frame (``face_box_to_frame``; x1 past the width wraps the
seam), folds the boxes of overlapping faces (``merge_face_boxes``) and writes drafts with
``frame: {layer, t}``, ``space: "source"`` and the playback copy's size. The pass is still
``detections/vlm-<run>.json``, its ``layer`` the walk layer and its ``assessed`` the frames as
``t:<milliseconds>`` (the local model's walk passes use the same names); a frame is assessed when
every face has a result for every detector. Frame drafts are then tracked and placed by
``inspection.walktrack`` (one draft per object, ``track``) instead of the multi-view vote.

A detector item may carry ``examples`` (absolute crop files with ``is`` / ``is-not``, chosen by the
app from the detector and the review ledger): they are read once per run and shown to the model in
every yes/no check (``fewshot``).

Every candidate is kept; one scored under its detector's threshold carries ``belowThreshold``, one
the model could not score carries ``unscored`` and no ``confidence``. A detector whose class is not
in the project's catalogues keeps its class id in ``class`` and adds ``label`` (its name) and
``suggestedNew``.
"""

from __future__ import annotations

import json
import math
import re
from pathlib import Path
from typing import Any

from ..inspection import equirect as EQ
from ..multiview.scene import radius_for, vote_pass
from ..params import known_keys
from ..runtime import JobError, Step, StepContext, atomic_write_json, commit_files, now_iso
from .fewshot import Example, load_examples, summary, validate_examples

DETECTIONS_SCHEMA = "aio.detections/1"
DETECTOR_SCHEMA = "aio.vlm-detector/1"
RUN_ID = re.compile(r"^run-[a-z0-9-]{1,60}$")
DETECTOR_ID = re.compile(r"^[a-z0-9][a-z0-9-]{1,60}$")
SHA256 = re.compile(r"^[a-f0-9]{64}$")
ABSOLUTE = re.compile(r"^([A-Za-z]:[\\/]|/|\\\\)")
WHERE = ("shipped", "project", "library")
MAX_PHOTOS = 5000
MAX_FRAMES = 2000
MAX_DETECTORS = 10
FRAME_DECODE_TIMEOUT_S = 120.0
MAX_FAILED_IN_A_ROW = 3

STOPPED = "The detector model stopped. Run the remaining photos again."
ALL_FAILED = "The detector model could not read any of the photos. Run the detectors again."
NO_PHOTOS = "None of the chosen photos could be opened. Check that the photo files are still in the project."
NO_FRAMES = (
    "None of the chosen walk frames could be read. Check that the walk's video is still in the project."
)

_DETECTOR_KEYS = {
    "schema", "id", "name", "version", "classId", "assetTypes", "looksLike", "ignore", "question",
    "tiles", "threshold", "tunedOn", "author", "createdAt", "updatedAt", "source", "status",
    "samples", "examples", "objectSizeM",
}  # fmt: skip
_DETECTOR_REQUIRED = _DETECTOR_KEYS - {"samples", "examples", "objectSizeM"}
OBJECT_SIZE_M = (0.01, 100.0)
_ITEM_KEYS = {"where", "detector", "threshold"}
_KEYS = {"run", "layer", "photos", "frames", "detectors", "serverFile", "modelSha256", "model"}


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
    size = det.get("objectSizeM")
    if size is not None and (not _is_number(size) or not OBJECT_SIZE_M[0] <= size <= OBJECT_SIZE_M[1]):
        raise JobError(f"A detector's objectSizeM must be from {OBJECT_SIZE_M[0]} to {OBJECT_SIZE_M[1]:g} m.")
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
            or not len(photos) <= MAX_PHOTOS
            or not all(isinstance(p, str) and 1 <= len(p) <= 128 for p in photos)
        ):
            raise JobError(f"photos must be a list of up to {MAX_PHOTOS} photo ids.")
        frames = _validate_frames(params.get("frames"), layer)
        if photos and frames:
            raise JobError("A run reads photos or the frames of one walk, not both.")
        if not photos and not frames:
            raise JobError("A run needs at least one photo or walk frame.")
        items = params.get("detectors")
        if not isinstance(items, list) or not 1 <= len(items) <= MAX_DETECTORS:
            raise JobError(f"detectors must be a list of 1 to {MAX_DETECTORS} detectors.")
        detectors: list[dict[str, Any]] = []
        for item in items:
            if not isinstance(item, dict) or not _ITEM_KEYS <= set(item) <= _ITEM_KEYS | {"examples"}:
                raise JobError("Each detector entry must be {where, detector, threshold, examples?}.")
            if item["where"] not in WHERE:
                raise JobError(f"where must be one of {', '.join(WHERE)}.")
            if not _is_number(item["threshold"]) or not 0 <= item["threshold"] <= 1:
                raise JobError("threshold must be between 0 and 1.")
            entry = {
                "where": item["where"],
                "detector": _validate_detector(item["detector"]),
                "threshold": float(item["threshold"]),
            }
            if "examples" in item:
                entry["examples"] = validate_examples(item["examples"])
            detectors.append(entry)
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
        out = {
            "run": run,
            "layer": layer,
            "photos": list(photos),
            "detectors": detectors,
            "serverFile": server_file,
            "modelSha256": sha,
            "model": model,
        }
        if frames:
            out["frames"] = frames
        return out

    def inputs(self, params: dict[str, Any], project: Path) -> list[str]:
        """The photo files (or the walk's video), so a resumed job refuses inputs that changed."""
        if params.get("frames"):
            try:
                return [str(_find_walk(_manifest(project), project, params["layer"])[1])]
            except JobError:
                return ["manifest.json"]
        try:
            files = [str(p) for _, p in _find_photos(_manifest(project), project, params)[0]]
        except JobError:
            return ["manifest.json"]
        return files or ["manifest.json"]

    def plan(self, params: dict[str, Any]) -> list[Step]:
        run_id = params["run"]
        detectors: list[dict[str, Any]] = params["detectors"]

        def prepare_step(ctx: StepContext) -> dict[str, Any]:
            if params.get("frames"):
                return {"photos": [], "frames": _prepare_frames(ctx, params), "skipped": 0} | {
                    "classIds": _class_ids(_manifest(ctx.project))
                }
            ctx.progress(0.0, "Finding the photos")
            found, problems = _find_photos(_manifest(ctx.project), ctx.project, params)
            for problem in problems:
                ctx.log(problem, "warn")
            photos: list[dict[str, Any]] = []
            # the photo metadata is read only when a detector of the run can use a GSD
            sized = any(e["detector"].get("objectSizeM") for e in detectors)
            for k, (photo_id, path) in enumerate(found):
                ctx.check()
                size = _image_size(path)
                if size is None:
                    ctx.log(f"Photo {photo_id} cannot be opened as an image; skipped.", "warn")
                    continue
                photos.append(
                    {
                        "id": photo_id,
                        "path": str(path),
                        "width": size[0],
                        "height": size[1],
                        "gsdM": _gsd(path, size[0], size[1]) if sized else None,
                    }
                )
                ctx.progress((k + 1) / max(1, len(found)))
            if not photos:
                raise JobError(NO_PHOTOS)
            return {
                "photos": photos,
                "skipped": len(params["photos"]) - len(photos),
                "classIds": _class_ids(_manifest(ctx.project)),
            }

        def detect_step(ctx: StepContext) -> dict[str, Any]:
            from PIL import Image

            from .engine import MAX_CANDIDATES, VlmUnavailable, box_frame, run_detector

            units = _units(ctx.outputs("prepare"))
            client = _client(params["serverFile"])
            frame = box_frame(params["model"])
            total = len(units) * len(detectors)
            done = ok = failed = streak = capped = 0
            shots = _load_shots(ctx, detectors)
            for ui, unit in enumerate(units):
                for entry in detectors:
                    det = entry["detector"]
                    ctx.progress(done / max(1, total), f"{unit['progress']}, {det['name']}")
                    ctx.check()
                    done += 1
                    staged = ctx.stage(unit["result"](det["id"]))
                    if staged.exists():
                        ok += 1
                        streak = 0
                        capped += bool(json.loads(staged.read_text("utf-8")).get("capped"))
                        continue
                    try:
                        with Image.open(unit["path"]) as im:
                            im.load()
                            result = run_detector(
                                client,
                                im,
                                _fit_tiles(det, im.width, im.height, unit.get("gsdM")),
                                frame=frame,
                                start_tile=ui,
                                examples=shots[det["id"]],
                            )
                    except VlmUnavailable as e:
                        raise JobError(STOPPED) from e
                    except OSError as e:
                        ctx.log(f"{unit['label']} could not be read ({type(e).__name__}); skipped.", "warn")
                        failed += 1
                        continue
                    for w in result.warnings:
                        ctx.log(f"{unit['label']}, {det['name']}: {w}", "warn")
                    if result.failed:
                        failed += 1
                        streak += 1
                        ctx.log(
                            f"{unit['label']}: the model gave no usable answer for {det['name']}.", "warn"
                        )
                        if streak >= MAX_FAILED_IN_A_ROW:
                            raise JobError(STOPPED)
                        continue
                    streak = 0
                    ok += 1
                    capped += result.capped
                    atomic_write_json(
                        staged,
                        {
                            unit["kind"]: unit["id"],
                            "detector": det["id"],
                            "candidates": [
                                {"box": list(c.box), "note": c.note, "score": c.score}
                                for c in result.candidates
                            ],
                            "capped": result.capped,
                        },
                    )
            if ok == 0:
                raise JobError(ALL_FAILED)
            if capped:
                ctx.log(
                    f"{capped} photo results had more than {MAX_CANDIDATES} candidates; "
                    f"kept {MAX_CANDIDATES} of each (the first answers of each tile).",
                    "warn",
                )
            ctx.progress(1.0)
            return {"results": ok, "failed": failed, "capped": capped}

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
            capped = 0  # photo results cut to MAX_CANDIDATES
            looked: dict[str, set[str]] = {}  # class -> photos its detector ran on

            def draft(entry: dict[str, Any], c: dict[str, Any], id_part: str, k: int, w: int, h: int):
                det = entry["detector"]
                score = c.get("score")
                d: dict[str, Any] = {"id": f"{run_id}-{id_part}-{det['id']}-{k}"}
                d["class"] = det["classId"]
                d["severity"] = "uncertain"
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
                d["width"] = w
                d["height"] = h
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
                return d

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
                    looked.setdefault(det["classId"], set()).add(photo["id"])  # seenBy counts only these
                    result = json.loads(staged.read_text("utf-8"))
                    capped += bool(result.get("capped"))
                    for k, c in enumerate(result["candidates"]):
                        d = draft(entry, c, photo["id"], k, photo["width"], photo["height"])
                        dets.append({"id": d.pop("id"), "photo": photo["id"], **d})
                if ran_all:
                    assessed.append(photo["id"])
            frames: list[dict[str, Any]] = ctx.outputs("prepare").get("frames") or []
            for fi, fr in enumerate(frames):
                ran_all = True
                found: list[dict[str, Any]] = []
                for entry in detectors:
                    det = entry["detector"]
                    boxes: list[dict[str, Any]] = []
                    for yaw in fr["yaws"]:
                        staged = ctx.stage(_face_result_name(fi, fr["ms"], yaw, det["id"]))
                        if not staged.exists():
                            ran_all = False
                            continue
                        result = json.loads(staged.read_text("utf-8"))
                        capped += bool(result.get("capped"))
                        for c in result["candidates"]:
                            box = EQ.face_box_to_frame(
                                c["box"], yaw, EQ.FACE_FOV, EQ.FACE_SIZE, fr["width"], fr["height"]
                            )
                            boxes.append(
                                {
                                    "class": det["classId"],
                                    "bbox": box,
                                    "confidence": c.get("score"),
                                    "_inside": EQ.face_box_inside(c["box"], EQ.FACE_SIZE),
                                    "_c": {**c, "box": box},
                                }
                            )
                    # the faces overlap: one box per object of this detector
                    for k, m in enumerate(EQ.merge_face_boxes(boxes, fr["width"])):
                        d = draft(entry, m["_c"], f"t{fr['ms']}", k, fr["width"], fr["height"])
                        found.append({**d, "frame": {"layer": params["layer"], "t": fr["t"]}})
                dets.extend(found)
                if ran_all:
                    assessed.append(f"t:{fr['ms']}")
            sizes = {e["detector"]["id"]: e["detector"] for e in detectors}
            voted = tracked = None
            if frames:
                # one draft per object followed across the walk's frames (inspection/walktrack)
                from ..inspection.walkjob import track_doc

                doc0 = {"layer": params["layer"], "assessed": assessed, "detections": dets}
                doc1, tracked = track_doc(ctx, doc0, params["layer"])
                dets = doc1["detections"]
            else:
                # one draft per object seen in several posed photos (multiview/, vision audit 3.6)
                dets, voted = vote_pass(ctx, params["layer"], dets, radius_for(sizes), assessed=looked)
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
            what = "walk frames" if frames else "photos"
            ctx.log(f"{len(dets)} candidates on {len(assessed)} {what}.")
            ctx.progress(1.0)
            out = {
                "pass": f"detections/{rel}",
                "photos": 0 if frames else len(assessed),
                "detections": len(dets),
                "capped": capped,
            }
            if frames:
                out["frames"] = len(assessed)
            if tracked is not None:
                out["tracked"] = tracked
            if voted:
                out["voted"] = {k: voted[k] for k in ("merged", "singleView")} | {
                    "objects": voted["clusters"]
                }
            return out

        return [
            Step("prepare", "Finding the photos", prepare_step, 0.05),
            Step("detect", "Running detectors", detect_step, 0.9),
            Step("commit", "Saving the detections", commit_step, 0.05),
        ]


def _load_shots(ctx: StepContext, detectors: list[dict[str, Any]]) -> dict[str, list[Example]]:
    """Each detector's few-shot example crops (``fewshot``), read once per run and logged."""
    out: dict[str, list[Example]] = {}
    for entry in detectors:
        det = entry["detector"]
        shots, warnings = load_examples(entry.get("examples") or [])
        for w in warnings:
            ctx.log(f"{det['name']}: {w}", "warn")
        if shots:
            ctx.log(f"{det['name']}: the yes/no check shows the model {summary(shots)} example crops.")
        out[det["id"]] = shots
    return out


def _pass_name(run_id: str) -> str:
    return f"vlm-{re.sub(r'[^A-Za-z0-9._-]', '-', run_id)[:100]}.json"


def _result_name(index: int, photo_id: str, detector_id: str) -> str:
    return f"results/{index}-{re.sub(r'[^A-Za-z0-9._-]', '_', photo_id)[:80]}--{detector_id}.json"


def _face_result_name(index: int, ms: int, yaw: float, detector_id: str) -> str:
    return f"results/f{index}-t{ms}-y{round(yaw)}--{detector_id}.json"


def _validate_frames(frames: Any, layer: str) -> list[dict[str, Any]]:
    """``frames`` as ``[{layer, t}]`` of the run's walk layer (none: an empty list)."""
    if frames is None:
        return []
    if not isinstance(frames, list) or len(frames) > MAX_FRAMES:
        raise JobError(f"frames must be a list of up to {MAX_FRAMES} walk frames.")
    out: list[dict[str, Any]] = []
    for f in frames:
        if not isinstance(f, dict) or set(f) != {"layer", "t"}:
            raise JobError("Each frame must be {layer, t}.")
        t = f["t"]
        if not _is_number(t) or not math.isfinite(t) or t < 0:
            raise JobError("A frame's t must be a number of seconds from 0.")
        if f["layer"] != layer:
            raise JobError("Every frame must be on the run's walk layer (layer).")
        out.append({"layer": layer, "t": t})
    return out


def _class_ids(manifest: dict[str, Any]) -> list[str]:
    return sorted(
        {
            c["id"]
            for cat in manifest.get("classCatalogues", [])
            for c in cat.get("classes", [])
            if isinstance(c, dict) and isinstance(c.get("id"), str)
        }
    )


def _find_walk(manifest: dict[str, Any], project: Path, layer_id: str) -> tuple[dict[str, Any], Path]:
    """The walk layer and its playback copy."""
    from ..inspection.frame import asset_path

    layer = next(
        (x for x in manifest.get("layers", []) if x.get("id") == layer_id and x.get("kind") == "walk"),
        None,
    )
    if layer is None:
        raise JobError(f'The project has no 360 walk layer "{layer_id}".')
    path = asset_path(project, layer.get("src"))
    if path is None or not path.is_file():
        raise JobError(NO_FRAMES)
    return layer, path


def _decode_frame(exe: str, src: Path, t: float, out: Path) -> bool:
    """The frame of ``src`` at ``t`` seconds as a PNG; False when ffmpeg gives none."""
    import subprocess

    from ..walk.ffmpeg import _NO_WINDOW

    tmp = out.with_name(out.stem + ".part.png")
    args = [
        exe,
        "-v",
        "error",
        "-nostdin",
        "-ss",
        f"{t:.3f}",
        "-i",
        str(src),
        "-frames:v",
        "1",
        "-y",
        str(tmp),
    ]
    try:
        res = subprocess.run(
            args, stdin=subprocess.DEVNULL, capture_output=True, timeout=FRAME_DECODE_TIMEOUT_S,
            creationflags=_NO_WINDOW,
        )  # fmt: skip
    except (OSError, subprocess.TimeoutExpired):
        return False
    if res.returncode != 0 or not tmp.is_file() or tmp.stat().st_size == 0:
        tmp.unlink(missing_ok=True)
        return False
    tmp.replace(out)
    return True


def _prepare_frames(ctx: StepContext, params: dict[str, Any]) -> list[dict[str, Any]]:
    """Each asked walk frame decoded and cut into perspective faces in staging (resumable)."""
    import numpy as np
    from PIL import Image

    from ..walk.ffmpeg import FFMPEG_MISSING, find_ffmpeg

    ctx.progress(0.0, "Reading the walk frames")
    _layer, src = _find_walk(_manifest(ctx.project), ctx.project, params["layer"])
    exe = find_ffmpeg()
    if exe is None:
        raise JobError(FFMPEG_MISSING)
    asked: dict[int, float] = {}
    for f in params["frames"]:
        asked.setdefault(round(float(f["t"]) * 1000), float(f["t"]))
    out: list[dict[str, Any]] = []
    for k, (ms, t) in enumerate(asked.items()):
        ctx.check()
        ctx.progress(k / max(1, len(asked)), f"frame {k + 1} of {len(asked)}")
        png = ctx.stage(f"frames/{ms}.png")
        faces = [ctx.stage(f"faces/{ms}-y{round(yaw)}.jpg") for yaw in EQ.FACE_YAWS]
        if not png.exists() and not _decode_frame(exe, src, t, png):
            ctx.log(f"The walk frame at {t:g} s could not be read; skipped.", "warn")
            continue
        try:
            with Image.open(png) as im:
                rgb = np.asarray(im.convert("RGB"))
        except (OSError, ValueError):
            ctx.log(f"The walk frame at {t:g} s could not be read; skipped.", "warn")
            continue
        h, w = rgb.shape[:2]
        for yaw, face in zip(EQ.FACE_YAWS, faces, strict=True):
            if not face.exists():
                tmp = face.with_name(face.stem + ".part.jpg")
                Image.fromarray(EQ.render_face(rgb, yaw)).save(tmp, "JPEG", quality=92)
                tmp.replace(face)
        out.append(
            {
                "t": t,
                "ms": ms,
                "width": int(w),
                "height": int(h),
                "yaws": list(EQ.FACE_YAWS),
                "faces": [str(p) for p in faces],
            }
        )
    if not out:
        raise JobError(NO_FRAMES)
    ctx.progress(1.0)
    return out


def _units(prepared: dict[str, Any]) -> list[dict[str, Any]]:
    """What the detect step runs each detector on: every photo, or every face of every frame."""
    units: list[dict[str, Any]] = []
    photos = prepared.get("photos") or []
    for pi, p in enumerate(photos):
        units.append(
            {
                "kind": "photo",
                "id": p["id"],
                "path": p["path"],
                "gsdM": p.get("gsdM"),
                "label": f"Photo {p['id']}",
                "progress": f"photo {pi + 1} of {len(photos)}",
                "result": lambda det_id, pi=pi, pid=p["id"]: _result_name(pi, pid, det_id),
            }
        )
    frames = prepared.get("frames") or []
    for fi, f in enumerate(frames):
        for yaw, path in zip(f["yaws"], f["faces"], strict=True):
            units.append(
                {
                    "kind": "frame",
                    "id": f"t:{f['ms']}",
                    "path": path,
                    "gsdM": None,
                    "label": f"The walk frame at {f['t']:g} s",
                    "progress": f"frame {fi + 1} of {len(frames)}",
                    "result": lambda det_id, fi=fi, ms=f["ms"], yaw=yaw: _face_result_name(
                        fi, ms, yaw, det_id
                    ),
                }
            )
    return units


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


def _gsd(path: Path, width: int, height: int) -> float | None:
    """The photo's ground sample distance in metres per pixel, or None (see ``engine.gsd_from_meta``)."""
    from ..aik.cameras import read_meta
    from .engine import gsd_from_meta

    try:
        return gsd_from_meta(read_meta(path), width, height)
    except Exception:  # unreadable metadata only means no GSD: the detector's own tiles apply
        return None


def _fit_tiles(det: dict[str, Any], width: int, height: int, gsd_m: float | None = None) -> dict[str, Any]:
    """The detector with the tile count for this photo. With an ``objectSizeM`` and a known GSD
    the count comes from ``engine.choose_tiles``; otherwise the detector's own ``tiles`` apply. A
    photo no bigger than the size sent to the model is sent whole (n = 1): tiling it would only
    enlarge pieces of it further."""
    from .engine import choose_tiles

    tiles = det["tiles"]
    n = choose_tiles(width, height, tiles, gsd_m, det.get("objectSizeM"))
    if n > 1 and width <= tiles["sendW"] and height <= tiles["sendH"]:
        n = 1
    return det if n == tiles["n"] else {**det, "tiles": {**tiles, "n": n}}


def _client(server_file: str):
    from .engine import VlmClient

    try:
        state = json.loads(Path(server_file).read_text("utf-8"))
        return VlmClient(state["url"], api_key=state["apiKey"])
    except (OSError, ValueError, KeyError, TypeError) as e:
        raise JobError(STOPPED) from e
