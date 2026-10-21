"""Raster files of ``thermal.decode`` and the rules they are written by (contract row of M1).

- ``thermal/rasters/<layerId>/<photoId>.f32``: little-endian float32 °C, row-major, no header;
- ``<photoId>.json`` (``aio.thermalRaster/1``, ``ThermalRasterMeta`` in
  packages/schema/src/thermal.ts);
- ``index.json`` (``ThermalRasterIndex``): the status of every photo decoded so far, with the
  reason for any that has no raster. Each entry also keeps the ``settingsKey`` it was decided
  with (so an unchanged photo is skipped whatever its status) and the file has ``crosscheck``:
  ``ok``, ``failed`` or ``skipped`` (no ExifTool). The schema's objects are plain, so these extra
  fields pass the app's reader.
"""

from __future__ import annotations

import hashlib
import json
import math
import re
from pathlib import Path
from typing import Any

import numpy as np

from .physics import ThermalSettingsPy

RASTER_SCHEMA = "aio.thermalRaster/1"
THERMAL_SCHEMA = "aio.thermal/1"

#: Plausibility bounds (global constraints): every finite value, and the photo's median.
MIN_C, MAX_C = -70.0, 1000.0
MEDIAN_MIN_C, MEDIAN_MAX_C = -40.0, 80.0

FALLBACK_DISTANCE_M = 10.0
DESIGN_DEFAULTS: dict[str, Any] = {
    "emissivity": 0.95,
    "distanceM": FALLBACK_DISTANCE_M,
    "airC": 25.0,
    "humidityPct": 50.0,
    "reflectedC": None,
}
SETTINGS_FIELDS = ("emissivity", "distanceM", "airC", "humidityPct", "reflectedC")


class BadSettings(ValueError):
    """Settings in ``thermal.json`` the formula cannot use."""


# ---------------------------------------------------------------------------- settings


def parse_settings(raw: object) -> dict[str, Any]:
    """A ``ThermalSettings`` object, checked as the schema does (numbers as floats)."""
    if not isinstance(raw, dict):
        raise BadSettings("the settings are not an object")
    out: dict[str, Any] = {}
    for k in SETTINGS_FIELDS:
        v = raw.get(k)
        if k == "reflectedC" and v is None:
            out[k] = None
            continue
        if isinstance(v, bool) or not isinstance(v, int | float) or not math.isfinite(v):
            raise BadSettings(f"{k} is not a number")
        out[k] = float(v)
    if not 0.0 < out["emissivity"] <= 1.0:
        raise BadSettings(f"emissivity {out['emissivity']:g} is outside 0 to 1")
    if out["distanceM"] < 0.0:
        raise BadSettings(f"distance {out['distanceM']:g} m is below 0")
    if not 0.0 <= out["humidityPct"] <= 100.0:
        raise BadSettings(f"humidity {out['humidityPct']:g} % is outside 0 to 100")
    return out


def to_py(s: dict[str, Any]) -> ThermalSettingsPy:
    return ThermalSettingsPy(
        emissivity=s["emissivity"],
        distance_m=s["distanceM"],
        air_c=s["airC"],
        humidity_pct=s["humidityPct"],
        reflected_c=s["reflectedC"],
    )


def from_py(s: ThermalSettingsPy) -> dict[str, Any]:
    return {
        "emissivity": float(s.emissivity),
        "distanceM": float(s.distance_m),
        "airC": float(s.air_c),
        "humidityPct": float(s.humidity_pct),
        "reflectedC": None if s.reflected_c is None else float(s.reflected_c),
    }


_REL_ALT = re.compile(rb'drone-dji:RelativeAltitude\s*=\s*"([^"]+)"|<drone-dji:RelativeAltitude>([^<]+)<')


def xmp_rel_alt(head: bytes) -> float | None:
    """DJI's ``RelativeAltitude`` (height above the take-off point) from the photo's XMP."""
    m = _REL_ALT.search(head)
    if not m:
        return None
    try:
        v = float((m.group(1) or m.group(2)).decode("ascii", "ignore").strip())
    except ValueError:
        return None
    return v if math.isfinite(v) else None


def height_above_takeoff(item: dict[str, Any], head: bytes) -> float | None:
    """The renderer's ``heightAbove`` (renderer/thermal/settings.ts): the drone log's relative
    altitude when above 0. The item's ``dji.relAlt`` comes first; photo layer items do not carry it
    today, so the photo's own XMP (where the import reads ``dji.relAlt`` from) gives it. The
    ``pos`` height minus the take-off height is left out: no take-off height is stored with a
    layer, so the job cannot know it."""
    dji = item.get("dji")
    rel = dji.get("relAlt") if isinstance(dji, dict) else None
    if isinstance(rel, bool) or not isinstance(rel, int | float):
        rel = xmp_rel_alt(head)
    if rel is not None and math.isfinite(rel) and rel > 0:
        return float(rel)
    return None


def effective_settings(
    sidecar: dict[str, Any] | None, layer_id: str, photo_id: str, item: dict[str, Any], head: bytes
) -> dict[str, Any]:
    """The photo's own settings, else the file's defaults, else the design defaults with the
    distance from the photo's height above take-off (10 m when unknown). Raises ``BadSettings``."""
    if sidecar:
        own = (sidecar.get("photos") or {}).get(f"{layer_id}/{photo_id}")
        if isinstance(own, dict) and "settings" in own:
            return parse_settings(own["settings"])
        if sidecar.get("defaults") is not None:
            return parse_settings(sidecar["defaults"])
    h = height_above_takeoff(item, head)
    return {**DESIGN_DEFAULTS, "distanceM": h if h is not None else FALLBACK_DISTANCE_M}


def settings_key(settings: dict[str, Any], decoder: str, size: int, mtime_ns: int) -> str:
    """sha256 of the canonical settings JSON, the decoder id and the source's size and mtime."""
    canonical = json.dumps(settings, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(f"{canonical}\n{decoder}\n{size}\n{mtime_ns}".encode()).hexdigest()


# ---------------------------------------------------------------------------- the raster


def implausible(t: np.ndarray) -> str | None:
    """Why a decoded photo cannot be right, or None when it is within the bounds."""
    finite = t[np.isfinite(t)]
    if finite.size == 0:
        return "No pixel gave a temperature."
    lo, hi = float(finite.min()), float(finite.max())
    if lo < MIN_C:
        return f"A pixel reads {lo:.1f} °C, below {MIN_C:g} °C."
    if hi > MAX_C:
        return f"A pixel reads {hi:.1f} °C, above {MAX_C:g} °C."
    med = float(np.median(finite))
    if not MEDIAN_MIN_C <= med <= MEDIAN_MAX_C:
        return f"The photo's median reads {med:.1f} °C, outside {MEDIAN_MIN_C:g} to {MEDIAN_MAX_C:g} °C."
    return None


def stats(t: np.ndarray) -> dict[str, float]:
    finite = t[np.isfinite(t)].astype(np.float64)
    return {"minC": float(finite.min()), "maxC": float(finite.max()), "medianC": float(np.median(finite))}


def write(folder: Path, photo_id: str, t: np.ndarray, meta: dict[str, Any]) -> None:
    """The ``.f32`` and its ``.json`` into ``folder`` (the job's staging area)."""
    folder.mkdir(parents=True, exist_ok=True)
    np.ascontiguousarray(t, dtype="<f4").tofile(folder / f"{photo_id}.f32")
    (folder / f"{photo_id}.json").write_text(json.dumps(meta, indent=1) + "\n", "utf-8")


def read_index(path: Path) -> dict[str, Any]:
    """The layer's index, or an empty one when missing or unreadable."""
    try:
        doc = json.loads(path.read_text("utf-8"))
    except (OSError, ValueError):
        doc = None
    if (
        not isinstance(doc, dict)
        or doc.get("schema") != RASTER_SCHEMA
        or not isinstance(doc.get("photos"), dict)
    ):
        return {"schema": RASTER_SCHEMA, "photos": {}}
    return doc
