"""survey.qa: a surface against checkpoints and against the previous survey at the site QA level.

Parameters as ``SurveyQaParams`` in ``@aio/schema`` (``jobs.ts``); the result is
``survey/qa/<capture>.json`` (``SurveyQa``, ``aio.survey-qa/1``, data-conventions section 29).

- **Checkpoints** come from a CSV (an absolute path; a header names the columns, else the columns
  are name, E, N, Z) or from the M10 GCP file of a run (``{ gcp }``, its check points, or its
  control points when it has none), in the project's coordinate system (a GCP file in another one is
  converted with PROJ). The prepared surface is sampled bilinearly at each point (``grid.bilinear``,
  as every engine sample is); ``dz`` = surface minus surveyed height, ``null`` where the surface
  has no data. RMSE, mean and largest absolute ``dz`` are over the points with a height.
- **Compare to previous survey**: the previous capture's prepared surface (``previous``, or the
  survey before ``capture`` by date) and this one over their overlap through the survey engine's
  core (``compare.compare_item`` on the grid path, at most ``MAX_SHARE_CELLS`` cells); the share
  of the covered area where ``|dz|`` reaches the level's threshold.
- **Levels** (``LEVELS``): RMSE limits 5, 10 and 20 cm (the site's ``qa.rmseM`` replaces the limit
  of the site's own level), and the compare-to-previous limits (Strict: more than 50 % of the area
  beyond 0.10 m; Moderate: more than 60 % beyond 0.20 m; Lenient: more than 60 % beyond 0.40 m).
  ``off`` measures without a verdict (status ``unchecked``; the previous check at Moderate's
  threshold, for information).
- **Status**: ``hold`` with ``hold.reason`` when a check fails (main records the hold as a
  ``survey.hold`` op when the job finishes; only a person releases it, with a note), ``pass`` when
  every check that ran passed, ``unchecked`` when the level is off or nothing could be checked.

Nothing else in the project changes: the surface, the checkpoints and earlier results stay.
"""

from __future__ import annotations

import csv
import io
import json
import math
from pathlib import Path
from typing import Any

import numpy as np

from ..params import known_keys
from ..runtime import JobError, Step, StepContext, atomic_write_json, commit_files, now_iso
from .compare import GridOut, ProjectSurfaces, compare_item, weighted_volumes
from .grid import bilinear

SAFE_ID = __import__("re").compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$")
LEVEL_NAMES = ("strict", "moderate", "lenient", "off")
LABEL = {"strict": "Strict", "moderate": "Moderate", "lenient": "Lenient", "off": "Off"}
#: RMSE limit (m), and the compare-to-previous threshold (m) and largest share of the area beyond it.
LEVELS: dict[str, dict[str, float]] = {
    "strict": {"rmseM": 0.05, "thresholdM": 0.10, "share": 0.50},
    "moderate": {"rmseM": 0.10, "thresholdM": 0.20, "share": 0.60},
    "lenient": {"rmseM": 0.20, "thresholdM": 0.40, "share": 0.60},
}
#: Largest comparison grid of the compare-to-previous check (cells); a finer surface is sampled coarser.
MAX_SHARE_CELLS = 4_000_000
MAX_CSV_BYTES = 20 * 1024 * 1024
MAX_POINTS = 10_000
QA_DIR = "survey/qa"

NAME_COLS = ("name", "id", "point", "pt", "label", "pointid", "point id", "p")
E_COLS = ("easting", "east", "e", "x")
N_COLS = ("northing", "north", "n", "y")
Z_COLS = ("elevation", "elev", "height", "z", "h", "rl", "level")


# ------------------------------------------------------------------------------------ checkpoints


def _number(s: str) -> float | None:
    try:
        v = float(s.strip())
    except ValueError:
        return None
    return v if math.isfinite(v) else None


def read_checkpoint_csv(path: Path) -> list[dict[str, Any]]:
    """``[{name, e, n, z}]`` from a CSV of checkpoints (comma, semicolon, tab or space separated)."""
    try:
        size = path.stat().st_size
    except OSError as e:
        raise JobError(f"The checkpoint file could not be read: {e}") from e
    if size > MAX_CSV_BYTES:
        raise JobError(
            f"The checkpoint file is {size / 1e6:.0f} MB; at most {MAX_CSV_BYTES // 2**20} MB is read."
        )
    raw = path.read_bytes()
    try:
        text = raw.decode("utf-8-sig")
    except UnicodeDecodeError:
        text = raw.decode("latin-1")
    lines = [ln for ln in text.splitlines() if ln.strip() and not ln.lstrip().startswith("#")]
    if not lines:
        raise JobError(f"The checkpoint file {path.name} is empty.")
    first = lines[0]
    delim = max((",", ";", "\t"), key=first.count)
    if first.count(delim) == 0:
        rows = [ln.split() for ln in lines]
    else:
        rows = list(csv.reader(io.StringIO("\n".join(lines)), delimiter=delim))
    head = [c.strip().lower() for c in rows[0]]
    numeric = sum(_number(c) is not None for c in rows[0])
    if numeric < 3:
        cols = {
            "name": next((head.index(k) for k in NAME_COLS if k in head), None),
            "e": next((head.index(k) for k in E_COLS if k in head), None),
            "n": next((head.index(k) for k in N_COLS if k in head), None),
            "z": next((head.index(k) for k in Z_COLS if k in head), None),
        }
        missing = [k.upper() for k in ("e", "n", "z") if cols[k] is None]
        if missing:
            raise JobError(
                f"The checkpoint file {path.name} has no column for {', '.join(missing)}: "
                "name the columns easting, northing and elevation (or E, N, Z)."
            )
        body = rows[1:]
    else:
        width = len(rows[0])
        cols = {"name": 0, "e": 1, "n": 2, "z": 3} if width >= 4 else {"name": None, "e": 0, "n": 1, "z": 2}
        body = rows
    if len(body) > MAX_POINTS:
        raise JobError(f"The checkpoint file has {len(body)} points; at most {MAX_POINTS} are checked.")
    out: list[dict[str, Any]] = []
    for k, row in enumerate(body):
        vals = {}
        for key in ("e", "n", "z"):
            c = cols[key]
            v = _number(row[c]) if c is not None and c < len(row) else None
            if v is None:
                raise JobError(
                    f"Line {k + 2 if numeric < 3 else k + 1} of {path.name} has no number for {key.upper()}."
                )
            vals[key] = v
        c = cols["name"]
        name = row[c].strip() if c is not None and c < len(row) and row[c].strip() else f"P{k + 1}"
        out.append({"name": name[:120], **vals})
    if not out:
        raise JobError(f"The checkpoint file {path.name} has no points.")
    return out


def read_gcp_checkpoints(project: Path, rel: str, manifest_crs: dict[str, Any]) -> list[dict[str, Any]]:
    """The check points of an M10 ``gcp.json`` (its control points when it has none), project CRS."""
    from ..runtime import safe_project_path

    p = safe_project_path(project, rel)
    try:
        doc = json.loads(p.read_text("utf-8"))
    except (OSError, ValueError) as e:
        raise JobError(f"The ground control file {rel} could not be read: {e}") from e
    if not isinstance(doc, dict) or doc.get("schema") != "aio.gcp/1":
        raise JobError(f"{rel} is not a ground control file (aio.gcp/1).")
    pts = [q for q in doc.get("points") or [] if isinstance(q, dict) and not q.get("disabled")]
    use = [q for q in pts if q.get("role") == "check"] or [q for q in pts if q.get("role") == "control"]
    if not use:
        raise JobError(f"{rel} has no ground control or check points.")
    xyz = np.array([[float(v) for v in q["xyz"]] for q in use], dtype=np.float64)
    src = doc.get("crs")
    if isinstance(src, dict) and src != manifest_crs:
        from ..geodesy.site import crs_of, horizontal_transformer

        t = horizontal_transformer(crs_of(src), crs_of(manifest_crs))
        e, n = t.transform(xyz[:, 0], xyz[:, 1])
        xyz[:, 0], xyz[:, 1] = e, n
    return [
        {
            "name": str(q.get("label") or q.get("id"))[:120],
            "e": float(v[0]),
            "n": float(v[1]),
            "z": float(v[2]),
        }
        for q, v in zip(use, xyz, strict=True)
    ]


def checkpoint_stats(points: list[dict[str, Any]], heights: np.ndarray) -> dict[str, Any]:
    """``SurveyQa.checkpoints`` from surveyed points and the surface heights at them (NaN: no data)."""
    dz = heights - np.array([p["z"] for p in points], dtype=np.float64)
    ok = np.isfinite(dz)
    d = dz[ok]
    return {
        "count": int(ok.sum()),
        "rmseM": float(np.sqrt(np.mean(d * d))) if d.size else 0.0,
        "meanM": float(d.mean()) if d.size else 0.0,
        "maxAbsM": float(np.abs(d).max()) if d.size else 0.0,
        "points": [
            {"name": p["name"], "dz": float(v) if math.isfinite(v) else None}
            for p, v in zip(points, dz, strict=True)
        ],
    }


# ---------------------------------------------------------------------------- compare to previous


def changed_share(
    ps: ProjectSurfaces,
    prev: tuple[str, str],
    cur: tuple[str, str],
    threshold: float,
    check=lambda: None,
) -> dict[str, Any]:
    """The share of the covered overlap of two prepared surfaces where ``|dz| >= threshold``."""
    a = ps.grid(prev[1], prev[0])
    b = ps.grid(cur[1], cur[0])
    assert a.grid is not None and b.grid is not None
    ea = a.extent or a.grid.bounds
    eb = b.extent or b.grid.bounds
    x0, y0, x1, y1 = max(ea[0], eb[0]), max(ea[1], eb[1]), min(ea[2], eb[2]), min(ea[3], eb[3])
    if x0 >= x1 or y0 >= y1:
        raise JobError("This survey and the previous one do not overlap.")
    finest = min(a.grid.cell, b.grid.cell)
    cell = max(finest, math.sqrt((x1 - x0) * (y1 - y0) / MAX_SHARE_CELLS))
    item = {
        "id": "qa-previous",
        "from": {"kind": "survey", "surface": prev[1], "capture": prev[0]},
        "to": {"kind": "survey", "surface": cur[1], "capture": cur[0]},
        "useDeadband": False,
        **({"cellM": cell} if cell > finest else {}),
    }
    ring = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]
    outs: list[GridOut] = []
    res = compare_item(ring, item, ps.resolve, None, check, now="1970-01-01T00:00:00Z", grid_out=outs)
    if not outs:
        raise JobError(f"The previous survey could not be compared: {res.get('reason') or res['status']}.")
    changed = covered = 0.0
    for sub, dz, w in outs[0].bands:
        t = weighted_volumes(dz, w, sub.cell, threshold, True)
        changed += t.area_fill + t.area_cut
        covered += t.area_fill + t.area_cut + t.area_unchanged
    if covered <= 0:
        raise JobError("This survey and the previous one have no heights in common.")
    return {
        "capture": prev[0],
        "thresholdM": threshold,
        "changedShare": min(1.0, max(0.0, changed / covered)),
    }


def previous_of(ps: ProjectSurfaces, capture: str) -> tuple[str, str] | None:
    """The survey before ``capture`` by date that has a prepared surface, and that surface."""
    caps = [c for c in ps.captures() if ps.surface_of_capture(c)]
    if capture not in caps:
        return None
    k = caps.index(capture)
    if k == 0:
        return None
    prev = caps[k - 1]
    sid = ps.surface_of_capture(prev)
    return (prev, sid) if sid else None


# ---------------------------------------------------------------------------------------- verdict


def site_rmse_limit(project: Path, level: str) -> float | None:
    """The RMSE limit of ``level``: the site's ``qa.rmseM`` when the site's level is ``level``."""
    if level not in LEVELS:
        return None
    p = project / "survey" / "settings.json"
    if p.is_file():
        try:
            qa = (json.loads(p.read_text("utf-8")) or {}).get("qa") or {}
        except (OSError, ValueError) as e:
            raise JobError(f"The survey settings could not be read: {e}") from e
        r = qa.get("rmseM")
        if qa.get("level") == level and isinstance(r, int | float) and not isinstance(r, bool) and r > 0:
            return float(r)
    return LEVELS[level]["rmseM"]


def _cm(v: float) -> str:
    return f"{v * 100:.1f} cm"


def verdict(
    level: str, rmse_limit: float | None, checkpoints: dict[str, Any] | None, previous: dict[str, Any] | None
) -> tuple[str, list[str]]:
    """The status (``pass``, ``hold`` or ``unchecked``) and the reasons a check failed."""
    if level == "off" or (checkpoints is None and previous is None):
        return "unchecked", []
    lv = LEVELS[level]
    reasons = []
    if checkpoints is not None and rmse_limit is not None and checkpoints["rmseM"] > rmse_limit:
        reasons.append(
            f"Checkpoint RMSE {_cm(checkpoints['rmseM'])} is above the {LABEL[level]} limit of {_cm(rmse_limit)}."
        )
    if previous is not None and previous["changedShare"] > lv["share"]:
        reasons.append(
            f"{previous['changedShare'] * 100:.0f}% of the area changed by more than "
            f"{previous['thresholdM']:.2f} m since the previous survey; {LABEL[level]} allows "
            f"{lv['share'] * 100:.0f}%."
        )
    return ("hold" if reasons else "pass"), reasons


# --------------------------------------------------------------------------------------- pipeline


class SurveyQa:
    name = "survey.qa"
    title = "Survey QA"
    description = "Checks a surface against checkpoints and against the previous survey at the site QA level."
    keys = frozenset({"capture", "surface", "level", "checkpoints", "previous"})
    required = frozenset({"capture", "surface", "level"})

    def validate(self, params: dict[str, Any]) -> dict[str, Any]:
        known_keys(params, set(self.keys), self.name)
        missing = sorted(k for k in self.required if params.get(k) is None)
        if missing:
            raise JobError(f"{self.name} needs: {', '.join(missing)}.")
        if params["level"] not in LEVEL_NAMES:
            raise JobError(f"level must be one of: {', '.join(sorted(LEVEL_NAMES))}.")
        for k in ("capture", "surface"):
            if not isinstance(params[k], str) or not SAFE_ID.match(params[k]):
                raise JobError(f"{k} must be letters, digits, dot, dash or _.")
        cp = params.get("checkpoints")
        if cp is not None:
            ok = isinstance(cp, dict) and len(cp) == 1
            if ok and "csv" in cp:
                ok = isinstance(cp["csv"], str) and Path(cp["csv"]).is_absolute()
            elif ok and "gcp" in cp:
                ok = isinstance(cp["gcp"], str) and bool(cp["gcp"].strip())
            else:
                ok = False
            if not ok:
                raise JobError("checkpoints must be { csv } (an absolute path) or { gcp } (a project path).")
        prev = params.get("previous")
        if prev is not None and not (
            isinstance(prev, dict)
            and set(prev) == {"capture", "surface"}
            and all(isinstance(prev[k], str) and SAFE_ID.match(prev[k]) for k in prev)
        ):
            raise JobError("previous must be { capture, surface }.")
        return dict(params)

    def inputs(self, params: dict[str, Any]) -> list[str]:
        return ["survey/surfaces", "survey/settings.json"]

    def plan(self, params: dict[str, Any]) -> list[Step]:
        capture = params["capture"]

        def check(ctx: StepContext) -> dict[str, Any]:
            from ..change.imagery import read_manifest

            level = params["level"]
            ps = ProjectSurfaces(ctx.project)
            surf = ps.grid(params["surface"], capture)
            assert surf.grid is not None
            checkpoints = None
            cp = params.get("checkpoints")
            if cp is not None:
                if "csv" in cp:
                    pts = read_checkpoint_csv(ctx.input(cp["csv"]))
                else:
                    crs = read_manifest(ctx.project).get("crs") or {}
                    pts = read_gcp_checkpoints(ctx.project, cp["gcp"], crs)
                xs = np.array([p["e"] for p in pts]) - surf.grid.origin_e
                ys = np.array([p["n"] for p in pts]) - surf.grid.origin_n
                heights = bilinear(surf.grid, xs, ys, 0.0, 0.0)
                checkpoints = checkpoint_stats(pts, heights)
                if checkpoints["count"] == 0:
                    raise JobError(
                        f"None of the {len(pts)} checkpoints is on the surface: check that they are in "
                        "the project's coordinate system, as easting, northing and elevation."
                    )
                ctx.log(f"{checkpoints['count']} of {len(pts)} checkpoints on the surface.")
            ctx.progress(0.3, "Checkpoints")
            previous = None
            prev = params.get("previous")
            pair = (prev["capture"], prev["surface"]) if prev else previous_of(ps, capture)
            if pair is not None:
                thr = LEVELS.get(level, LEVELS["moderate"])["thresholdM"]
                previous = changed_share(ps, pair, (capture, params["surface"]), thr, ctx.check)
            ctx.progress(0.9, "Compared with the previous survey")
            limit = site_rmse_limit(ctx.project, level)
            status, reasons = verdict(level, limit, checkpoints, previous)
            at = now_iso()
            doc: dict[str, Any] = {
                "schema": "aio.survey-qa/1",
                "capture": capture,
                "level": level,
                "status": status,
                **({"checkpoints": checkpoints} if checkpoints is not None else {}),
                **({"previous": previous} if previous is not None else {}),
                **({"hold": {"at": at, "reason": " ".join(reasons)[:500]}} if status == "hold" else {}),
                "checkedAt": at,
            }
            atomic_write_json(ctx.stage(f"qa/{capture}.json"), doc)
            return {
                "status": status,
                **({"rmseM": checkpoints["rmseM"]} if checkpoints else {}),
                **({"changedShare": previous["changedShare"]} if previous else {}),
            }

        def commit(ctx: StepContext) -> dict[str, Any]:
            rel = f"{QA_DIR}/{capture}.json"
            commit_files(ctx, [(f"qa/{capture}.json", rel)])
            return {"out": rel, **ctx.outputs("check")}

        return [Step("check", "Check the survey", check, 3.0), Step("commit", "Save the QA result", commit)]
