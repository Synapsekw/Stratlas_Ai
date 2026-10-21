"""thermal.decode: the radiometric photos of a photo layer to temperature rasters (thermal M1).

Parameters as ``ThermalDecodeParams`` in packages/schema/src/thermal.ts: ``layerId``, optional
``photos`` (photo ids; all of the layer when absent) and ``force`` (decode even unchanged photos).

Steps:

1. **decode** reads each photo's review copy (the layer item's ``src``), works out its settings
   (its own in ``thermal/thermal.json``, else the file's ``defaults``, else the design defaults
   with the distance from the photo's height above take-off, 10 m when unknown) and its
   ``settingsKey``. A photo whose key matches the index is skipped. Otherwise:

   - a FLIR radiometric JPEG goes through ``flir.read_flir`` and ``physics.to_celsius``; the first
     photo of each camera model in the run is checked against the bundled ExifTool
     (``crosscheck.py``), and any difference leaves every photo of that model ``unverified``.
     Without ExifTool (tests and dev runs) the photos decode and the index says
     ``crosscheck: "skipped"``; the pack build's smoke test requires it present;
   - a DJI R-JPEG goes through the DJI Thermal SDK with its settings clamped into the SDK's
     ranges, the clamped names recorded in the raster's ``clamped``; one left unread because the
     SDK was missing or would not load is marked ``sdk: "unavailable"`` and read again once the
     SDK is installed;
   - anything else is ``unsupported``, with the reason.

   A decoded photo outside the plausibility bounds is ``implausible``. Only ``ok`` photos get a
   raster. Rasters and the merged ``index.json`` are written into the job's staging area.
2. **commit** moves them into ``thermal/rasters/<layerId>/`` (rasters first, the index last) and
   removes the rasters of photos that no longer decode to one.

The result (the decode step's outputs) counts ``decoded``, ``skipped``, ``unsupported``,
``unverified`` and ``implausible`` photos.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

import numpy as np

from ..change.imagery import read_manifest
from ..params import known_keys
from ..photo.native import find_tool
from ..runtime import JobError, Step, StepContext, atomic_write_json, commit_files, safe_project_path
from . import crosscheck, raster
from .dji_tsdk import Tsdk, TsdkError, clamp_for_tsdk, is_dji_rjpeg
from .flir import parse_flir
from .physics import to_celsius

THERMAL_JSON = "thermal/thermal.json"
RASTERS_DIR = "thermal/rasters"
STAGED = "rasters"
REMOVE_LIST = ".remove.json"
HEAD_BYTES = 256 * 1024
#: Decoder ids, part of every ``settingsKey``: change one when its numbers would change.
FLIR_DECODER = "aio-flir/1"
DJI_DECODER = "dji-tsdk/1.9"
NO_DECODER = "none"
#: Ids that can name a file: the layer's folder and each photo's raster.
SAFE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
STATUSES = ("unsupported", "unverified", "implausible")

READ_ONLY = (
    "This project folder is read-only, so its thermal photos cannot be decoded. "
    "Open a copy of the project that you can write to."
)
NO_RADIOMETRY = "No temperature data: a visual photo, or a camera that does not record temperatures."
FLIR_DAMAGED = "The FLIR thermal record in this photo is damaged or incomplete."
NO_TSDK = "The DJI Thermal SDK is not in the installed processing tools, so this DJI photo cannot be read."


def _safe(v: object) -> bool:
    return isinstance(v, str) and bool(SAFE_ID.match(v)) and ".." not in v


def _read_sidecar(project: Path) -> dict[str, Any] | None:
    p = project / THERMAL_JSON
    if not p.exists():
        return None
    try:
        doc = json.loads(p.read_text("utf-8-sig"))
    except (OSError, ValueError) as e:
        raise JobError(f"The thermal settings file {THERMAL_JSON} could not be read: {e}") from e
    if not isinstance(doc, dict) or doc.get("schema") != raster.THERMAL_SCHEMA:
        raise JobError(f"{THERMAL_JSON} is not a thermal settings file ({raster.THERMAL_SCHEMA}).")
    return doc


def _photo_path(project: Path, item: dict[str, Any]) -> Path | None:
    ref = item.get("src") or {}
    rel = ref.get("path") or (f"assets/sha256/{ref['hash']}" if ref.get("hash") else None)
    if not isinstance(rel, str):
        return None
    try:
        path = safe_project_path(project, rel)
    except JobError:
        return None
    # A link or junction inside the project may point out of it: read only what really is inside.
    try:
        if not path.resolve().is_relative_to(project.resolve()):
            return None
    except OSError:
        return None
    return path


class ThermalDecode:
    name = "thermal.decode"
    title = "Decoding thermal photos"
    description = (
        "Temperatures from the radiometric photos of a photo layer (FLIR and DJI thermal cameras), "
        "one raster per photo, checked against ExifTool and against plausible bounds."
    )

    def validate(self, params: dict[str, Any]) -> dict[str, Any]:
        known_keys(params, {"layerId", "photos", "force"}, self.name)
        if not _safe(params.get("layerId")):
            raise JobError("layerId must be the id of a photo layer.")
        photos = params.get("photos")
        if photos is not None and (
            not isinstance(photos, list) or not photos or not all(_safe(p) for p in photos)
        ):
            raise JobError("photos must be a list of photo ids.")
        if "force" in params and not isinstance(params["force"], bool):
            raise JobError("force must be true or false.")
        return dict(params)

    def inputs(self, params: dict[str, Any]) -> list[str]:
        return ["manifest.json", THERMAL_JSON]

    def plan(self, params: dict[str, Any]) -> list[Step]:
        return [
            Step("decode", "Decoding thermal photos", self._decode, weight=0.95),
            Step("commit", "Saving the temperatures", self._commit, weight=0.05),
        ]

    # -------------------------------------------------------------------------------------- decode

    def _decode(self, ctx: StepContext) -> dict[str, Any]:
        p = ctx.params
        layer_id: str = p["layerId"]
        force = bool(p.get("force"))
        manifest = read_manifest(ctx.project)
        layer = next(
            (
                lay
                for lay in manifest.get("layers") or []
                if isinstance(lay, dict) and lay.get("id") == layer_id and lay.get("kind") == "photos"
            ),
            None,
        )
        if layer is None:
            raise JobError(f'There is no photo layer "{layer_id}" in this project.')
        items = {str(i["id"]): i for i in layer.get("items") or [] if isinstance(i, dict) and "id" in i}
        wanted = p.get("photos")
        if wanted is not None:
            missing = [w for w in wanted if w not in items]
            if missing:
                raise JobError(f"The layer has no photo {', '.join(missing[:5])}.")
            ids = list(dict.fromkeys(wanted))
        else:
            ids = list(items)

        out_dir = ctx.out(f"{RASTERS_DIR}/{layer_id}")
        self._check_writable(out_dir)
        sidecar = _read_sidecar(ctx.project)
        prev = raster.read_index(out_dir / "index.json")
        prev_photos: dict[str, Any] = prev["photos"]

        staged = ctx.stage(f"{STAGED}/.keep").parent
        for f in staged.iterdir():
            f.unlink()

        exiftool = find_tool("exiftool")
        sdk_there = find_tool("dji_tsdk") is not None
        verdicts: dict[str, tuple[str, str | None]] = {}  # camera -> (ok, mismatch or error; why)
        tsdk: list[Any] = []  # the SDK, loaded on the first DJI photo
        entries: dict[str, dict[str, Any]] = {}
        n = {"decoded": 0, "skipped": 0, "unsupported": 0, "unverified": 0, "implausible": 0}
        flir_tried = False

        for k, pid in enumerate(ids):
            ctx.check()
            ctx.progress(k / max(1, len(ids)), f"Photo {k + 1} of {len(ids)}")
            item = items[pid]
            if not _safe(pid):
                entries[pid] = {"status": "unsupported", "reason": "The photo id cannot name a file."}
                n["unsupported"] += 1
                continue
            path = _photo_path(ctx.project, item)
            try:
                data = path.read_bytes() if path is not None else None
                st = path.stat() if path is not None else None
            except OSError:
                data, st = None, None
            if data is None or st is None:
                entries[pid] = {"status": "unsupported", "reason": "The photo file is missing."}
                n["unsupported"] += 1
                continue
            head = data[:HEAD_BYTES]

            dji = is_dji_rjpeg(head)
            rec = None if dji else parse_flir(data)
            decoder = DJI_DECODER if dji else FLIR_DECODER if rec is not None else NO_DECODER
            try:
                settings = raster.effective_settings(sidecar, layer_id, pid, item, head)
            except raster.BadSettings as e:
                entries[pid] = {
                    "status": "unverified",
                    "reason": f"The settings of this photo cannot be used: {e}.",
                }
                n["unverified"] += 1
                continue
            key = raster.settings_key(settings, decoder, st.st_size, st.st_mtime_ns)

            old = prev_photos.get(pid)
            # a photo decoded without a cross-check (no ExifTool, or ExifTool failed) is decoded
            # again once ExifTool is there; a genuine mismatch stays until settings change or force
            unchecked = isinstance(old, dict) and old.get("check") in ("skipped", "error")
            # likewise a DJI photo left unread because the SDK was missing or would not load is
            # read again once the SDK is installed
            no_sdk = isinstance(old, dict) and old.get("sdk") == "unavailable"
            if (
                not force
                and isinstance(old, dict)
                and old.get("settingsKey") == key
                and not (unchecked and exiftool is not None)
                and not (no_sdk and sdk_there)
                and self._intact(out_dir, pid, old, key)
            ):
                entries[pid] = old
                n["skipped"] += 1
                continue

            check: str | None = None
            sdk_missing = False
            if dji:
                status, reason, t, meta = self._dji(tsdk, path, settings, f"{dji[0]} {dji[1]}")
                sdk_missing = not tsdk
            elif rec is not None:
                flir_tried = True
                status, reason, t, meta, check = self._flir(rec, pid, path, settings, exiftool, verdicts)
            else:
                damaged = b"FLIR\x00\x01" in data
                status, reason, t, meta = (
                    "unsupported",
                    FLIR_DAMAGED if damaged else NO_RADIOMETRY,
                    None,
                    None,
                )

            if status == "ok" and t is not None:
                why = raster.implausible(t)
                if why is not None:
                    status, reason = "implausible", why
            entry: dict[str, Any] = {"status": status, "settingsKey": key}
            if reason:
                entry["reason"] = reason
            if check is not None:
                entry["check"] = check
            if sdk_missing:
                entry["sdk"] = "unavailable"
            entries[pid] = entry
            if status == "ok" and t is not None and meta is not None:
                h, w = t.shape
                raster.write(
                    staged,
                    pid,
                    t,
                    {
                        "schema": raster.RASTER_SCHEMA,
                        "width": int(w),
                        "height": int(h),
                        **meta,
                        **raster.stats(t),
                        "decoder": decoder,
                        "settingsKey": key,
                    },
                )
                n["decoded"] += 1
            else:
                n[status] += 1

        if flir_tried:
            summary = (
                "skipped"
                if exiftool is None
                else "failed"
                if any(kind != "ok" for kind, _ in verdicts.values())
                else "ok"
            )
        else:
            was = prev.get("crosscheck")
            summary = was if was in ("ok", "failed", "skipped") else "skipped"
        # photos no longer in the layer leave the index, and their rasters go
        gone = [pid for pid in prev_photos if pid not in items]
        kept = {pid: e for pid, e in prev_photos.items() if pid in items}
        index = {"schema": raster.RASTER_SCHEMA, "crosscheck": summary, "photos": {**kept, **entries}}
        atomic_write_json(staged / "index.json", index)
        remove = sorted({*gone, *(pid for pid, e in entries.items() if e.get("status") != "ok")})
        atomic_write_json(staged / REMOVE_LIST, remove)
        ctx.progress(1.0, "Done")
        return {**n, "crosscheck": summary}

    @staticmethod
    def _check_writable(out_dir: Path) -> None:
        probe = out_dir / ".write-probe"
        try:
            out_dir.mkdir(parents=True, exist_ok=True)
            probe.write_bytes(b"")
            probe.unlink()
        except OSError as e:
            raise JobError(READ_ONLY) from e

    @staticmethod
    def _intact(out_dir: Path, pid: str, old: dict[str, Any], key: str) -> bool:
        """An ``ok`` photo is skipped only while its raster is there and of the same key."""
        if old.get("status") != "ok":
            return True
        try:
            meta = json.loads((out_dir / f"{pid}.json").read_text("utf-8"))
            size = (out_dir / f"{pid}.f32").stat().st_size
        except (OSError, ValueError):
            return False
        return (
            isinstance(meta, dict)
            and meta.get("settingsKey") == key
            and size == int(meta.get("width", 0)) * int(meta.get("height", 0)) * 4
        )

    @staticmethod
    def _flir(
        rec,
        pid: str,
        path: Path,
        settings: dict[str, Any],
        exiftool: str | None,
        verdicts: dict[str, tuple[str, str | None]],
    ):
        """(status, reason, temperatures, meta, check): ``check`` is the cross-check state the
        index keeps for the photo (``ok``, ``mismatch``, ``error`` or ``skipped``)."""
        camera = f"{rec.make} {rec.model}".strip()
        # a photo that names no camera model shares no verdict: it is checked on its own
        group = camera if rec.model.strip() else f"photo:{pid}"
        check = "skipped"
        if exiftool is not None:
            if group not in verdicts:
                try:
                    why = crosscheck.check(exiftool, path, rec)
                    verdicts[group] = ("ok", None) if why is None else ("mismatch", why)
                except crosscheck.CrosscheckError as e:
                    verdicts[group] = ("error", str(e))
            check, why = verdicts[group]
            if check == "mismatch":
                first = f"the first {camera} photo of this run" if group == camera else "this photo"
                reason = f"The decoder and ExifTool disagree on {first}: {why}"
                return "unverified", reason, None, None, check
            if check == "error":
                return (
                    "unverified",
                    f"ExifTool could not check this photo's decoding: {why}",
                    None,
                    None,
                    check,
                )
        try:
            t = to_celsius(rec.raw, rec.planck, rec.atmos, raster.to_py(settings))
        except ValueError as e:
            reason = f"The temperature formula cannot use this photo's values: {e}."
            return "unverified", reason, None, None, check
        meta = {
            "family": "flir",
            "camera": camera,
            "constants": crosscheck.record_constants(rec),
            "settings": settings,
            "clamped": [],
        }
        return "ok", None, np.asarray(t, dtype=np.float32), meta, check

    @staticmethod
    def _dji(tsdk: list[Any], path: Path, settings: dict[str, Any], camera: str):
        if not tsdk:
            folder = find_tool("dji_tsdk")
            if folder is None:
                return "unsupported", NO_TSDK, None, None
            try:
                tsdk.append(Tsdk(folder))
            except (OSError, AttributeError) as e:  # a missing library, or one without the entry points
                return "unsupported", f"The DJI Thermal SDK could not be loaded: {e}", None, None
        try:
            used, clamped = clamp_for_tsdk(raster.to_py(settings))
        except ValueError as e:
            return "unverified", f"The settings of this photo cannot be used: {e}.", None, None
        try:
            t = tsdk[0].measure(path, used)
        except (TsdkError, OSError, ValueError) as e:
            return "unsupported", f"The DJI Thermal SDK could not read this photo: {e}.", None, None
        meta = {"family": "dji-tsdk", "camera": camera, "settings": raster.from_py(used), "clamped": clamped}
        return "ok", None, np.asarray(t, dtype=np.float32), meta

    # -------------------------------------------------------------------------------------- commit

    def _commit(self, ctx: StepContext) -> dict[str, Any]:
        layer_id = ctx.params["layerId"]
        rel = f"{RASTERS_DIR}/{layer_id}"
        root = safe_project_path(ctx.staging, STAGED)
        out_dir = ctx.out(rel)
        try:
            remove_file = root / REMOVE_LIST
            remove = json.loads(remove_file.read_text("utf-8")) if remove_file.exists() else []
            for pid in remove:
                if _safe(pid):
                    for ext in (".f32", ".json"):
                        (out_dir / f"{pid}{ext}").unlink(missing_ok=True)
            files = (
                sorted(f.name for f in root.iterdir() if f.is_file() and not f.name.startswith("."))
                if root.exists()
                else []
            )
            rasters = [f for f in files if f != "index.json"]
            moves = [(f"{STAGED}/{f}", f"{rel}/{f}") for f in rasters]
            if "index.json" in files or not (out_dir / "index.json").exists():
                moves.append((f"{STAGED}/index.json", f"{rel}/index.json"))
            commit_files(ctx, moves, announce=False)
        except PermissionError as e:
            raise JobError(READ_ONLY) from e
        ctx.artifact(rel, "folder")
        return {"rasters": rel}
