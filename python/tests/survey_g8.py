"""Projects for the survey QA and cleanup tests (M11 G8): G13's synthetic sites with prepared surfaces.

``site_project`` writes a project folder (manifest with the site's captures) and one prepared
surface per capture (``survey/surfaces/s-<capture>/``, ``aio.height-tiles/1``) sampled from the
site's analytic heights, plus ``survey/settings.json``. ``put_surface`` writes any height grid as a
prepared surface. Synthetic only.
"""

from __future__ import annotations

import hashlib
import json
import math
from pathlib import Path

import numpy as np

from aio_pipelines.survey.grid import TILE, encode_tile
from survey_synth import SITE_EPSG, Grid, SurveySite, survey_settings

NOW = "2026-10-09T10:00:00Z"


def put_surface(
    project: Path, sid: str, h: np.ndarray, oe: float, on: float, cell: float, capture: str | None = None
) -> dict:
    """``h`` (row 0 south, NaN no data) as a prepared surface ``survey/surfaces/<sid>/``."""
    folder = project / "survey" / "surfaces" / sid
    (folder / "0").mkdir(parents=True, exist_ok=True)
    ny, nx = h.shape
    cols, rows = math.ceil(nx / TILE), math.ceil(ny / TILE)
    present = []
    for r in range(rows):
        for c in range(cols):
            t = np.full((TILE, TILE), np.nan)
            part = h[r * TILE : (r + 1) * TILE, c * TILE : (c + 1) * TILE]
            t[: part.shape[0], : part.shape[1]] = part
            if np.isfinite(t).any():
                (folder / "0" / f"{c}_{r}.bin").write_bytes(encode_tile(t))
                present.append(f"{c}_{r}")
    ok = np.isfinite(h)
    jj, ii = np.nonzero(ok)
    meta = {
        "schema": "aio.height-tiles/1",
        "id": sid,
        "name": f"Surface {sid}",
        "source": {"kind": "dsm", "layer": f"dsm-{capture or sid}"},
        **({"capture": capture} if capture else {}),
        "crs": {"epsg": SITE_EPSG},
        "cellM": cell,
        "tileSize": TILE,
        "originE": oe,
        "originN": on,
        "cols": cols,
        "rows": rows,
        "levels": 1,
        "bounds": [
            oe + ii.min() * cell,
            on + jj.min() * cell,
            float(h[ok].min()),
            oe + (ii.max() + 1) * cell,
            on + (jj.max() + 1) * cell,
            float(h[ok].max()),
        ],
        "tiles": present,
        "fingerprint": "sha256:" + hashlib.sha256(np.nan_to_num(h, nan=-1e9).tobytes()).hexdigest(),
        "preparedAt": NOW,
    }
    (folder / "tiles.json").write_text(json.dumps(meta), "utf-8")
    return meta


def put_grid(project: Path, sid: str, g: Grid, capture: str | None = None) -> dict:
    """A survey_synth ``Grid`` (row 0 north) as a prepared surface."""
    return put_surface(project, sid, g.z[::-1].copy(), g.x0, g.y1 - g.height * g.res, g.res, capture)


def manifest(project: Path, captures: list[dict], origin: list[float], layers: list | None = None) -> None:
    project.mkdir(parents=True, exist_ok=True)
    doc = {
        "schema": "aio.project/1",
        "id": "g8-test",
        "name": "G8 test (synthetic)",
        "crs": {"epsg": SITE_EPSG},
        "origin": origin,
        "captures": [{"id": c["id"], "label": c["label"], "date": c["date"]} for c in captures],
        "layers": layers or [],
    }
    (project / "manifest.json").write_text(json.dumps(doc), "utf-8")


def site_project(project: Path, site: SurveySite, level: str | None = None) -> None:
    """The site as a project with a prepared surface ``s-<capture>`` per capture."""
    manifest(project, site.captures, [site.centre[0], site.centre[1], site.h0])
    for cap in site.captures:
        put_grid(project, f"s-{cap['id']}", site.grid(cap["id"]), cap["id"])
    settings = survey_settings(site)
    if level is not None:
        settings["qa"] = {"level": level}
    (project / "survey" / "settings.json").write_text(json.dumps(settings), "utf-8")


def tree_hash(folder: Path) -> str:
    h = hashlib.sha256()
    for p in sorted(folder.rglob("*")):
        if p.is_file():
            h.update(p.relative_to(folder).as_posix().encode())
            h.update(p.read_bytes())
    return h.hexdigest()
