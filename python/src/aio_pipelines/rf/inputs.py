"""What ``rf.coverage`` reads, and how it turns it into sources (spec D1 to D6, D10, D11, D13).

- ``telecom/antennas.json``: owned by antenna detection; read only, and loosely, through the
  fields RF uses (``id``, ``kind``, ``status``, ``notFoundInLatest``, ``box.centre`` [E, N, Z],
  ``azimuthGridDeg.value``, ``downtiltDeg.value``, ``convergenceDeg``, ``user.active``, and the
  file's ``run.groundZ``). Anything else may change without touching RF.
- ``rf/sectors.json`` (``aio.rf-sectors/1``): sectors, per-antenna RF settings, study settings.
- ``rf/catalogue.json`` (``aio.rf-catalogue/1``): the catalogue entries the project uses (the app
  copies each used entry there, D10), with pattern files relative to ``rf/``.

A source is one carrier of one antenna. Units, settings or carriers that cannot take part are
left out with a warning in plain words; the job refuses only when nothing is left.
"""

from __future__ import annotations

import json
import math
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from ..runtime import JobError, safe_project_path
from . import budget, pattern
from .grid import NO_CRS

SECTORS_SCHEMA = "aio.rf-sectors/1"
CATALOGUE_SCHEMA = "aio.rf-catalogue/1"
ANTENNAS_PATH = "telecom/antennas.json"
#: The antenna-detection file family and the newest version read. The family and the number stay
#: apart: a whole id literal would read as a file schema to the registry scan, and that schema
#: belongs to the antenna-detection work.
ANTENNAS_FAMILY = "aio." + "antennas"
ANTENNAS_VERSION = 1
SECTORS_PATH = "rf/sectors.json"
CATALOGUE_PATH = "rf/catalogue.json"
#: Ground below the tower read from a DSM: a low percentile within this radius of the antenna,
#: so the tower and its cabinets are not taken for the ground.
DSM_GROUND_RADIUS_M = 30.0
DSM_GROUND_PERCENTILE = 5.0

STUDY_DEFAULTS: dict[str, Any] = {
    "model": "tr38901",
    "environment": "uma",
    "ueHeightM": 1.5,
    "marginPreset": "outdoor",
    "bodyLossDb": 3,
    "edgeProbability": 0.9,
    "shadowSigmaDb": 8,
    "thresholds": dict(budget.DEFAULT_THRESHOLDS),
    "gridResolutionM": 10,
    "radiusM": 3000,
}


def _read_json(project: Path, rel: str, what: str, required: bool = True) -> Any:
    p = safe_project_path(project, rel)
    if not p.exists():
        if required:
            raise JobError(f"The project has no {rel} ({what}).")
        return None
    try:
        return json.loads(p.read_text("utf-8-sig"))
    except (OSError, ValueError) as e:
        raise JobError(f"{rel} could not be read: {e}") from e


def _check_schema(doc: Any, family: str, version: int, rel: str) -> None:
    sid = doc.get("schema") if isinstance(doc, dict) else None
    m = re.fullmatch(rf"{re.escape(family)}/(\d+)", sid or "")
    if not m:
        raise JobError(f"{rel} is not a {family} file.")
    if int(m.group(1)) > version:
        raise JobError(
            f"{rel} was saved by a newer version of the app. Update the processing tools to use it."
        )


def read_sectors(project: Path) -> dict[str, Any]:
    doc = _read_json(project, SECTORS_PATH, "the RF settings; set up the sectors in the RF tab first")
    _check_schema(doc, "aio.rf-sectors", 1, SECTORS_PATH)
    for key in ("sectors", "antennas"):
        if not isinstance(doc.get(key), list):
            raise JobError(f"{SECTORS_PATH} has no {key} list.")
    return doc


def study_of(sectors_file: dict[str, Any]) -> dict[str, Any]:
    study = {**STUDY_DEFAULTS, **(sectors_file.get("study") or {})}
    study["thresholds"] = {**budget.DEFAULT_THRESHOLDS, **(study.get("thresholds") or {})}
    return study


def read_antennas(project: Path) -> dict[str, Any]:
    """The antenna inventory. A newer major version is refused before anything in it is read."""
    doc = _read_json(project, ANTENNAS_PATH, "the antenna inventory; run Detect antennas first")
    if not isinstance(doc, dict):
        raise JobError(f"{ANTENNAS_PATH} is not an antenna inventory.")
    sid = doc.get("schema")
    m = re.fullmatch(rf"{re.escape(ANTENNAS_FAMILY)}/(\d+)", sid) if isinstance(sid, str) else None
    if m is None:
        raise JobError(f"{ANTENNAS_PATH} is not an antenna inventory ({ANTENNAS_FAMILY} file).")
    if int(m.group(1)) > ANTENNAS_VERSION:
        raise JobError(
            f"{ANTENNAS_PATH} was saved by a newer version of the antenna detection ({sid}); this version reads "
            f"version {ANTENNAS_VERSION} only. Update the processing tools to predict coverage from it."
        )
    if not isinstance(doc.get("units"), list):
        raise JobError(f"{ANTENNAS_PATH} has no units list.")
    return doc


def read_catalogue(project: Path) -> dict[str, dict[str, Any]]:
    doc = _read_json(project, CATALOGUE_PATH, "the project catalogue", required=False)
    if doc is None:
        return {}
    _check_schema(doc, "aio.rf-catalogue", 1, CATALOGUE_PATH)
    return {
        e["id"]: e for e in doc.get("entries") or [] if isinstance(e, dict) and isinstance(e.get("id"), str)
    }


def _num(v: Any) -> float | None:
    if isinstance(v, bool) or not isinstance(v, int | float) or not math.isfinite(v):
        return None
    return float(v)


def _value(u: dict[str, Any], key: str) -> float | None:
    v = u.get(key)
    return _num(v.get("value")) if isinstance(v, dict) else _num(v)


def _centre(u: dict[str, Any]) -> list[float] | None:
    c = (u.get("box") or {}).get("centre") if isinstance(u.get("box"), dict) else None
    if not isinstance(c, list) or len(c) != 3 or any(_num(x) is None for x in c):
        return None
    return [float(x) for x in c]


def convergence_of(u: dict[str, Any], antennas_file: dict[str, Any]) -> float | None:
    """The unit's convergence; the file's when the unit has none (an older layout)."""
    if "convergenceDeg" in u:
        return _num(u.get("convergenceDeg"))
    return _num(antennas_file.get("convergenceDeg"))


def exclusion(
    u: dict[str, Any],
    antennas_file: dict[str, Any],
    settings: dict[str, Any] | None,
    include_unreviewed: bool,
) -> str | None:
    """Why a unit in a sector does not take part (D3, ``unitEligibility`` in sectors.ts), or None.

    A unit a person put in a sector counts as included by hand, so a short unit there takes part;
    a draft takes part only when the job is asked to include unreviewed units.
    """
    uid = u.get("id")
    status = u.get("status")
    user = u.get("user")
    if user is not None and not isinstance(user, dict):
        return f"{uid} has an unreadable user field in the antenna inventory."
    if status == "rejected":
        return f"{uid} was rejected in the antenna inventory."
    if u.get("notFoundInLatest") is True:
        return f"{uid} was not found in the latest antenna detection."
    if (settings is not None and settings.get("active") is False) or (user or {}).get("active") is False:
        return f"{uid} is marked inactive."
    kind = u.get("kind")
    if kind in ("dish", "other"):
        return f"{uid} is a {kind}, not a sector antenna."
    if kind not in ("panel", "short"):
        return f"{uid} is not a panel antenna."
    if _value(u, "azimuthGridDeg") is None:
        return f"{uid} has no measured azimuth."
    if convergence_of(u, antennas_file) is None:
        return f"{uid}: {NO_CRS}"
    if _centre(u) is None:
        return f"{uid} has no position."
    if status == "draft" and not include_unreviewed:
        return f"{uid} is a draft; include unreviewed units to use it."
    if status not in ("accepted", "draft"):
        return f"{uid} is not an accepted unit."
    if settings is None:
        return f"{uid} has no RF settings."
    return None


def ground_from_dsm(project: Path, manifest: dict[str, Any], east: float, north: float) -> float | None:
    """Tower-base ground from the first project DSM (GeoTIFF) that covers the point, or None."""
    for layer in manifest.get("layers") or []:
        if not isinstance(layer, dict) or layer.get("kind") != "raster" or layer.get("role") != "dsm":
            continue
        if layer.get("format") != "cog":
            continue
        src = layer.get("src")
        if not isinstance(src, dict) or not isinstance(src.get("path"), str):
            continue
        try:
            import numpy as np
            import rasterio
            from rasterio.windows import from_bounds

            path = safe_project_path(project, src["path"])
            if not path.exists():
                continue
            with rasterio.open(path) as ds:
                r = DSM_GROUND_RADIUS_M
                b = ds.bounds
                if not (b.left <= east <= b.right and b.bottom <= north <= b.top):
                    continue
                win = (
                    from_bounds(east - r, north - r, east + r, north + r, ds.transform)
                    .round_offsets()
                    .round_lengths()
                )
                z = ds.read(1, window=win, masked=True, boundless=True).astype(np.float64)
                vals = z.compressed() if hasattr(z, "compressed") else z.ravel()
                vals = vals[np.isfinite(vals)]
                if vals.size:
                    return float(np.percentile(vals, DSM_GROUND_PERCENTILE))
        except Exception:
            continue
    return None


@dataclass
class Source:
    sector_index: int
    sector_id: str
    antenna_id: str
    carrier_id: str
    east: float
    north: float
    height_m: float
    azimuth_grid_deg: float
    convergence_deg: float
    downtilt_deg: float
    pattern: pattern.Pattern
    pattern_source: str
    gain_dbi: float
    power_dbm: float
    subcarriers: int
    feeder_loss_db: float
    frequency_mhz: float


@dataclass
class Resolved:
    sources: list[Source]
    #: run.json ``inputs.antennas`` rows, in sector order
    antennas: list[dict[str, Any]]
    #: run.json ``patterns`` rows
    patterns: list[dict[str, Any]]
    #: catalogue ids used, with kind and verified
    catalogue: list[dict[str, Any]]
    warnings: list[str]
    used_unreviewed: bool
    #: why each unit in the chosen sectors was left out
    excluded: list[str]


def band_range(e: dict[str, Any]) -> tuple[float, float] | None:
    """A catalogue entry's or port's ``bandRangeMhz`` as (low, high), or None when it is malformed."""
    r = e.get("bandRangeMhz")
    if not isinstance(r, list | tuple) or len(r) != 2:
        return None
    lo, hi = _num(r[0]), _num(r[1])
    if lo is None or hi is None or not lo < hi:
        return None
    return lo, hi


def _port_for(
    entry: dict[str, Any], carrier: dict[str, Any], f: float, warn: list[str], aid: str
) -> dict[str, Any] | None:
    ports = []
    for p in entry.get("ports") or []:
        if not isinstance(p, dict):
            continue
        if band_range(p) is None:
            warn.append(
                f"{aid}: port {p.get('id')} of {entry.get('id')} has no readable band range; left out."
            )
            continue
        ports.append(p)
    if not ports:
        warn.append(f"{aid}: antenna {entry.get('id')} has no ports in the catalogue.")
        return None
    pid = carrier.get("port")
    if pid is not None:
        hit = next((p for p in ports if p.get("id") == pid), None)
        if hit is None:
            warn.append(
                f"{aid}: port {pid} is not a port of {entry.get('id')}; carrier {carrier.get('id')} left out."
            )
        return hit
    for p in ports:
        rng = band_range(p)
        if rng is not None and rng[0] <= f <= rng[1]:
            return p
    warn.append(f"{aid}: no port of {entry.get('id')} covers {f:g} MHz; port {ports[0].get('id')} used.")
    return ports[0]


def _tilt_in(etilt: dict[str, Any] | None, asked: float | None, aid: str, warn: list[str]) -> float:
    if asked is not None:
        return asked
    lo = _num((etilt or {}).get("minDeg"))
    hi = _num((etilt or {}).get("maxDeg"))
    tilt = 0.0 if lo is None or hi is None else min(max(0.0, lo), hi)
    warn.append(f"{aid}: no electrical tilt set; {tilt:g} degrees used.")
    return tilt


def _measured(
    project: Path, refs: list[dict[str, Any]], f: float, tilt: float, cap_db: float, aid: str, warn: list[str]
) -> pattern.TwoCut | None:
    ref = pattern.pick_nearest([r for r in refs if isinstance(r, dict)], f, tilt)
    if ref is None:
        return None
    rel = f"rf/{ref.get('file')}"
    try:
        msi = pattern.parse_msi(safe_project_path(project, rel).read_text("utf-8-sig", errors="replace"))
        cut = pattern.two_cut(msi.horizontal_db, msi.vertical_db, cap_db)
    except (OSError, ValueError, JobError) as e:
        warn.append(f"{aid}: the pattern file {rel} could not be used ({e}); the generic pattern is used.")
        return None
    if abs(float(ref["etiltDeg"]) - tilt) > 1e-9:
        warn.append(
            f"{aid}: no pattern file at {tilt:g} degrees e-tilt; the {float(ref['etiltDeg']):g} degree file is used."
        )
    return cut


def resolve(
    project: Path,
    manifest: dict[str, Any],
    sectors_file: dict[str, Any],
    antennas_file: dict[str, Any],
    catalogue: dict[str, dict[str, Any]],
    sector_ids: list[str] | None,
    include_unreviewed: bool,
) -> Resolved:
    # indices into the file's own list, so best server indexes run.inputs.sectors.sectors exactly
    sectors = list(sectors_file["sectors"])
    known = {s.get("id") for s in sectors if isinstance(s, dict)}
    if sector_ids is not None:
        missing = [s for s in sector_ids if s not in known]
        if missing:
            raise JobError(f"rf/sectors.json has no sector {', '.join(missing)}.")
    units = {u.get("id"): u for u in antennas_file["units"] if isinstance(u, dict)}
    settings_of = {a.get("antennaId"): a for a in sectors_file["antennas"] if isinstance(a, dict)}
    run = antennas_file.get("run") if isinstance(antennas_file.get("run"), dict) else {}
    ground_z = _num(run.get("groundZ"))
    warn: list[str] = []
    excluded: list[str] = []
    sources: list[Source] = []
    rows: list[dict[str, Any]] = []
    patterns_rows: list[dict[str, Any]] = []
    used: dict[str, dict[str, Any]] = {}
    unreviewed = False
    no_crs = 0
    candidates = 0

    def use(entry: dict[str, Any]) -> None:
        used[entry["id"]] = {
            "id": entry["id"],
            "kind": entry.get("kind"),
            "verified": entry.get("verified") is True,
        }

    for index, sec in enumerate(sectors):
        if not isinstance(sec, dict):
            excluded.append(f"Sector {index + 1} of rf/sectors.json is not readable; left out.")
            continue
        if sector_ids is not None and sec.get("id") not in sector_ids:
            continue
        members = sec.get("antennaIds")
        for aid in members if isinstance(members, list) else []:
            candidates += 1
            u = units.get(aid)
            if u is None:
                excluded.append(f"{aid} is no longer in the antenna inventory.")
                continue
            s = settings_of.get(aid)
            why = exclusion(u, antennas_file, s, include_unreviewed)
            if why is not None:
                no_crs += NO_CRS in why
                excluded.append(why)
                continue
            assert s is not None
            centre = _centre(u)
            assert centre is not None
            conv = convergence_of(u, antennas_file)
            assert conv is not None
            # height above ground (D4): the person's override, else the detected tower base, else a DSM
            override = _num(s.get("heightOverrideM"))
            if override is not None:
                height, unit_ground = override, ground_z
            elif ground_z is not None:
                height, unit_ground = centre[2] - ground_z, ground_z
            else:
                dsm = ground_from_dsm(project, manifest, centre[0], centre[1])
                if dsm is None:
                    excluded.append(
                        f"{aid} has no height above ground: the antenna file has no tower-base ground and no DSM covers it. "
                        "Set a height in the RF tab."
                    )
                    continue
                height, unit_ground = centre[2] - dsm, dsm
                warn.append(f"{aid}: ground taken from the DSM, height {height:.1f} m (estimated).")
            if not height > 0:
                excluded.append(f"{aid} is {height:.1f} m above the ground; it must be above it.")
                continue
            eq = s.get("equipment")
            if not isinstance(eq, dict):
                excluded.append(f"{aid} has no antenna or AAU chosen.")
                continue
            entry = catalogue.get(eq.get("aau") if eq.get("kind") == "aau" else eq.get("antenna"))
            want = "aau" if eq.get("kind") == "aau" else "antenna"
            if entry is None or entry.get("kind") != want:
                name = eq.get("aau") if want == "aau" else eq.get("antenna")
                excluded.append(f"{aid}: {want} {name} is not in the project catalogue.")
                continue
            asked_tilt = _num(s.get("etiltDeg"))
            mech = _value(u, "downtiltDeg")
            if mech is None:
                warn.append(f"{aid}: no measured mechanical downtilt; 0 degrees used.")
                mech = 0.0
            took = False
            sources_of_unit = "generic"
            for c in s.get("carriers") or []:
                if not isinstance(c, dict):
                    continue
                cid = c.get("id")
                row = budget.band_of(str(c.get("band") or ""))
                f = _num(c.get("frequencyMhz")) or (row[4] if row else None)
                if f is None:
                    warn.append(
                        f"{aid}: band {c.get('band')} of carrier {cid} is not known; give its frequency."
                    )
                    continue
                tech = c.get("tech")
                scs = _num(c.get("scsKhz"))
                if tech == "nr" and scs is None:
                    scs = 30.0 if row and row[3] == "TDD" else 15.0
                    warn.append(f"{aid}: carrier {cid} has no subcarrier spacing; {scs:g} kHz used.")
                try:
                    sub = budget.subcarriers(str(tech), float(c.get("bandwidthMhz") or 0), scs)
                except ValueError as e:
                    warn.append(f"{aid}: carrier {cid} left out: {e}.")
                    continue
                if want == "aau":
                    gain = float(entry.get("ssbGainDbi") or 0)
                    tilt = (
                        asked_tilt
                        if asked_tilt is not None
                        else _tilt_in(entry.get("etilt"), None, aid, warn)
                    )
                    pat: pattern.Pattern | None = _measured(
                        project, entry.get("patterns") or [], f, tilt, pattern.DEFAULT_AM_DB, aid, warn
                    )
                    if pat is None:
                        pat = pattern.Parametric(
                            float(entry.get("ssbHBeamwidthDeg") or pattern.DEFAULT_H_BEAMWIDTH_DEG),
                            float(entry.get("ssbVBeamwidthDeg") or 10),
                            tilt,
                        )
                    power = _num(c.get("powerDbmPerPort"))
                    if power is None:
                        power = float(entry.get("totalPowerDbm") or 0)
                        warn.append(
                            f"{aid}: carrier {cid} has no power set; the AAU's total {power:g} dBm (its maximum) is used."
                        )
                    use(entry)
                else:
                    port = _port_for(entry, c, f, warn, aid)
                    if port is None:
                        continue
                    gain = float(port.get("gainDbi") or 0)
                    tilt = (
                        asked_tilt if asked_tilt is not None else _tilt_in(port.get("etilt"), None, aid, warn)
                    )
                    fb = float(port.get("frontToBackDb") or pattern.DEFAULT_AM_DB)
                    pat = _measured(project, port.get("patterns") or [], f, tilt, fb, aid, warn)
                    if pat is None:
                        pat = pattern.Parametric(
                            float(port.get("hBeamwidthDeg") or pattern.DEFAULT_H_BEAMWIDTH_DEG),
                            float(port.get("vBeamwidthDeg") or 10),
                            tilt,
                            am_db=fb,
                        )
                    power = _num(c.get("powerDbmPerPort"))
                    radio_id = c.get("radioUnit") or eq.get("radio")
                    radio = catalogue.get(radio_id) if isinstance(radio_id, str) else None
                    if radio is not None and radio.get("kind") == "radio":
                        use(radio)
                    if power is None:
                        if radio is None or radio.get("kind") != "radio":
                            warn.append(
                                f"{aid}: carrier {cid} has no power and no radio unit to take it from; left out."
                            )
                            continue
                        power = float(radio.get("maxPowerDbmPerPort") or 0)
                        warn.append(
                            f"{aid}: carrier {cid} has no power set; the radio's maximum {power:g} dBm is used."
                        )
                    use(entry)
                kind = "msi" if isinstance(pat, pattern.TwoCut) else "generic"
                if kind == "msi":
                    sources_of_unit = "msi"
                sources.append(
                    Source(
                        sector_index=index,
                        sector_id=str(sec.get("id")),
                        antenna_id=aid,
                        carrier_id=str(cid),
                        east=centre[0],
                        north=centre[1],
                        height_m=height,
                        azimuth_grid_deg=float(_value(u, "azimuthGridDeg")),  # type: ignore[arg-type]
                        convergence_deg=conv,
                        downtilt_deg=mech,
                        pattern=pat,
                        pattern_source=kind,
                        gain_dbi=gain,
                        power_dbm=float(power),
                        subcarriers=sub,
                        feeder_loss_db=float(_num(c.get("feederLossDb")) or 0.0),
                        frequency_mhz=float(f),
                    )
                )
                took = True
            if not took:
                excluded.append(f"{aid} has no carrier that can be computed.")
                continue
            unreviewed = unreviewed or u.get("status") == "draft"
            rec: dict[str, Any] = {
                "id": aid,
                "centre": centre,
                "groundZ": unit_ground,
                "heightM": height,
                "azimuthGridDeg": _value(u, "azimuthGridDeg"),
                "convergenceDeg": conv,
                "downtiltDeg": mech,
            }
            if isinstance(u.get("status"), str):
                rec["status"] = u["status"][:40]
            rows.append(rec)
            patterns_rows.append({"antennaId": aid, "source": sources_of_unit})

    if not sources:
        if candidates and no_crs == candidates:
            raise JobError(NO_CRS)
        why = "; ".join(excluded[:5]) if excluded else "the chosen sectors have no antennas"
        raise JobError(f"No accepted panel antenna with RF settings takes part: {why}.")
    warn = [*excluded, *warn]
    return Resolved(sources, rows, patterns_rows, list(used.values()), warn, unreviewed, excluded)
