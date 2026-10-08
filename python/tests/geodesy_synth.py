"""Synthetic geodesy fixtures (M11 G1): a smooth geoid grid, calibrations with known parameters and
the site-transform parity fixtures the renderer is tested against.

No real geoid model is available offline in CI, so heights are tested on a synthetic geoid grid
(``synth-geoid``, a GTX file PROJ reads like any geoid grid); every number is still computed by PROJ.

``uv run python tests/geodesy_synth.py`` rewrites ``packages/geo/src/__fixtures__/site/``: for each
fixture site the ``site-transform.json`` and float64 tables ``write_site_tables`` writes, and
``points.json``: 1,000 random points of the site with PROJ's own answer (``to_site`` evaluated
directly, not from the tables).
"""

from __future__ import annotations

import json
import math
import shutil
import struct
import sys
import tempfile
from pathlib import Path
from typing import Any

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
FIXTURES = ROOT / "packages" / "geo" / "src" / "__fixtures__" / "site"
GEOID_ID = "synth-geoid"
NOW = "2026-10-09T08:00:00.000Z"


def synthetic_geoid(folder: Path, lon0=46.0, lat0=22.0, cols=101, rows=101, step=0.1) -> Path:
    """A smooth synthetic geoid (metres) over the Gulf as GTX: ``N = -25 + 2 sin + 1.5 cos``."""
    folder.mkdir(parents=True, exist_ok=True)
    lat = lat0 + step * np.arange(rows)[:, None]
    lon = lon0 + step * np.arange(cols)[None, :]
    n = -25.0 + 2.0 * np.sin(np.radians(lon) * 7.0) + 1.5 * np.cos(np.radians(lat) * 5.0)
    p = folder / f"{GEOID_ID}.gtx"
    header = struct.pack(">ddddii", lat0, lon0, step, step, rows, cols)
    p.write_bytes(header + n.astype(">f4").tobytes())
    return p


def utm_tm_site() -> dict[str, Any]:
    """A local transverse Mercator at a Doha site: the base projection of the calibrated fixture."""
    return {
        "wkt": None,
        "proj": "+proj=tmerc +lat_0=25.29 +lon_0=51.53 +k=1 +x_0=10000 +y_0=20000 +datum=WGS84 +units=m +type=crs",
    }


def known_calibration(projection: dict[str, Any], geoid: str | None = None) -> dict[str, Any]:
    """A calibration with known, non-trivial parameters (rotation 0.75 degree, scale 25 ppm)."""
    cal: dict[str, Any] = {
        "schema": "aio.site-calibration/1",
        "id": "cal-synth",
        "name": "Synthetic site calibration",
        "source": {"format": "pairs"},
        "projection": projection,
        "horizontal": {
            "originE": 10000.0,
            "originN": 20000.0,
            "shiftE": 4987.654,
            "shiftN": -18011.321,
            "rotationRad": math.radians(0.75),
            "scale": 1.000025,
        },
        "vertical": {
            "originE": 15000.0,
            "originN": 2000.0,
            "shiftM": -0.832,
            "slopeN": 12e-6,
            "slopeE": -7e-6,
        },
        "pairs": [],
        "computedAt": NOW,
    }
    if geoid:
        cal["geoid"] = geoid
    return cal


def _settings(**kw: Any) -> dict[str, Any]:
    base: dict[str, Any] = {"schema": "aio.survey-settings/1", "verticalDatum": {"kind": "project"}}
    base.update(kw)
    return base


def fixture_sites(geoid_dir: Path) -> dict[str, dict[str, Any]]:
    tm = utm_tm_site()["proj"]
    from pyproj import CRS

    tm_wkt = CRS.from_proj4(tm).to_wkt()
    return {
        # Doha: WGS 84 UTM 39N data to Qatar National Grid (QND95, Helmert), heights on the geoid
        "utm39n-qatar": {
            "data_crs": {"epsg": 32639},
            "settings": _settings(crs={"epsg": 2932}, verticalDatum={"kind": "geoid", "geoid": GEOID_ID}),
            "extent": (252000.0, 2798000.0, 252080.0, 2798080.0),
            "calibration": None,
        },
        # Atlanta: NAD83 UTM 16N data to Georgia West state plane in US survey feet
        "stateplane-usft": {
            "data_crs": {"epsg": 26916},
            "settings": _settings(crs={"epsg": 2240}, verticalDatum={"kind": "ellipsoidal"}),
            "extent": (741000.0, 3734000.0, 741080.0, 3734080.0),
            "calibration": None,
        },
        # Doha again: a calibrated local grid (local TM, Helmert 2D, inclined plane on the geoid)
        "calibrated-local": {
            "data_crs": {"epsg": 32639},
            "settings": _settings(verticalDatum={"kind": "calibration"}, calibration="cal-synth"),
            "extent": (252000.0, 2798000.0, 252080.0, 2798080.0),
            "calibration": known_calibration({"wkt": tm_wkt}, geoid=GEOID_ID),
        },
    }


def write_fixtures(out: Path = FIXTURES, n_points: int = 1000) -> None:
    sys.path.insert(0, str(ROOT / "python" / "src"))
    from aio_pipelines.geodesy.site import site_pipeline, write_site_tables

    tmp = Path(tempfile.mkdtemp())
    try:
        geoid_dir = tmp / "geoid"
        synthetic_geoid(geoid_dir)
        if out.exists():
            shutil.rmtree(out)
        rng = np.random.default_rng(20261009)
        for name, site in fixture_sites(geoid_dir).items():
            root = tmp / name
            header = write_site_tables(
                root,
                data_crs=site["data_crs"],
                settings=site["settings"],
                extent=site["extent"],
                calibration=site["calibration"],
                geoid_dirs_extra=[geoid_dir],
            )
            dst = out / name
            dst.mkdir(parents=True)
            for f in (root / "survey" / "geodesy").iterdir():
                shutil.copy(f, dst / f.name)
            header_path = dst / "site-transform.json"
            # a stable header for the repository (the time it was written is not part of a fixture)
            header["writtenAt"] = NOW
            header_path.write_text(json.dumps(header, indent=2) + "\n", encoding="utf-8", newline="")
            pipe = site_pipeline(
                site["data_crs"], site["settings"], site["calibration"], geoid_dirs_extra=[geoid_dir]
            )
            x0, y0, x1, y1 = site["extent"]
            e = rng.uniform(x0, x1, n_points)
            n = rng.uniform(y0, y1, n_points)
            z = rng.uniform(-5.0, 60.0, n_points)
            xs, ys, zs = pipe.to_site(e, n, z)
            pts = [[round(float(a), 6) for a in row] for row in zip(e, n, z, xs, ys, zs, strict=True)]
            (dst / "points.json").write_text(
                json.dumps({"columns": ["e", "n", "z", "siteE", "siteN", "siteZ"], "points": pts}) + "\n",
                encoding="utf-8",
                newline="",
            )
            print(f"{name}: {header['operation']}")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    write_fixtures()
