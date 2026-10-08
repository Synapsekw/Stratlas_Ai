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
        # a calibration as geo.calibration imports it from a synthetic JobXML (for the TS contract)
        from aio_pipelines.geodesy.calibration import compute_calibration

        jxl = tmp / "synthetic.jxl"
        jxl.write_bytes(synthetic_jobxml()[0])
        cal = compute_calibration({"src": str(jxl), "crs": {"epsg": 32639}})
        cal.update(id="cal-jobxml", computedAt=NOW)
        cal["source"].pop("name", None)
        text = json.dumps(cal, indent=2) + "\n"
        (out / "calibration-jobxml.json").write_text(text, encoding="utf-8", newline="")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


# ------------------------------------------------------------------------------------------ JobXML


def synthetic_jobxml(
    *,
    rotation_deg: float = 0.75,
    rotation_cw: bool = False,
    plane_on_grid: bool = False,
    noise_m: float = 0.004,
    n_points: int = 6,
    seed: int = 7,
    geoid: str | None = None,
    geoid_dir: Path | None = None,
) -> tuple[bytes, dict[str, Any]]:
    """A vendor-shaped JobXML (JobXML schema 6.x element names) with a known site calibration.

    The base projection is a transverse Mercator at a fictional Doha site. Local positions follow
    the model with ``noise_m`` of noise, and the controller residuals in the file are the model's own
    residuals in the file's convention (``rotation_cw``: clockwise rotation; ``plane_on_grid``: the
    inclined plane on base projection coordinates). Answers the bytes and the truth.
    """
    sys.path.insert(0, str(ROOT / "python" / "src"))
    from pyproj import CRS, Transformer

    from aio_pipelines.geodesy.calibration import apply_horizontal, plane_dz
    from aio_pipelines.geodesy.site import geoid_file, undulation

    rng = np.random.default_rng(seed)
    tm = "+proj=tmerc +lat_0=25.29 +lon_0=51.53 +k=1.00002 +x_0=10000 +y_0=20000 +a=6378137 +rf=298.257223563 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs +type=crs"
    base = CRS.from_proj4(tm)
    inv = Transformer.from_crs(base, CRS.from_epsg(4979), always_xy=True)
    th = math.radians(rotation_deg) * (-1 if rotation_cw else 1)
    h = {
        "originE": 10000.0,
        "originN": 20000.0,
        "shiftE": 4987.654,
        "shiftN": -18011.321,
        "rotationRad": th,
        "scale": 1.000025,
    }
    v = {"originE": 14990.0, "originN": 1990.0, "shiftM": -0.832, "slopeN": 12e-6, "slopeE": -7e-6}
    ge = 10000 + rng.uniform(-400, 400, n_points)
    gn = 20000 + rng.uniform(-400, 400, n_points)
    hh = 20 + rng.uniform(0, 30, n_points)
    lon, lat, _ = inv.transform(ge, gn, hh)
    n_geoid = (
        undulation(geoid_file(geoid, [geoid_dir] if geoid_dir else None), lon, lat)
        if geoid
        else np.zeros(n_points)
    )
    big_h = hh - n_geoid
    le, ln = apply_horizontal(h, ge, gn)
    dz = plane_dz(v, ge, gn) if plane_on_grid else plane_dz(v, le, ln)
    model = np.column_stack([le, ln, big_h + dz])
    local = model + rng.normal(0, noise_m, model.shape)
    res_h = np.hypot(local[:, 0] - model[:, 0], local[:, 1] - model[:, 1])
    res_v = local[:, 2] - model[:, 2]
    vtype = "GeoidModelAndInclinedPlane" if geoid else "InclinedPlane"
    geoid_xml = f"<GeoidName>{geoid}</GeoidName>" if geoid else ""
    rec_id = iter(range(1, 10_000))

    def rid() -> str:
        return f"{next(rec_id):08X}"

    pts = []
    cals = []
    for i in range(n_points):
        pts.append(
            f'<PointRecord ID="{rid()}" TimeStamp="2026-10-01T09:00:00"><Name>CP{i + 1}</Name>'
            "<Method>KeyedIn</Method><Classification>Normal</Classification><Deleted>false</Deleted>"
            f"<Grid><North>{local[i, 1]:.4f}</North><East>{local[i, 0]:.4f}</East><Elevation>{local[i, 2]:.4f}</Elevation></Grid>"
            "</PointRecord>"
        )
        pts.append(
            f'<PointRecord ID="{rid()}" TimeStamp="2026-10-01T09:05:00"><Name>GPS{i + 1}</Name>'
            "<Method>GpsCalibrationPoint</Method><Classification>Normal</Classification><Deleted>false</Deleted>"
            f"<WGS84><Latitude>{lat[i]:.11f}</Latitude><Longitude>{lon[i]:.11f}</Longitude><Height>{hh[i]:.4f}</Height></WGS84>"
            "</PointRecord>"
        )
        cals.append(
            f'<CalibrationPointRecord ID="{rid()}" TimeStamp="2026-10-01T10:00:00">'
            f"<GridPointName>CP{i + 1}</GridPointName><WGS84PointName>GPS{i + 1}</WGS84PointName>"
            f"<Dimension>3D</Dimension><HorizontalResidual>{res_h[i]:.4f}</HorizontalResidual>"
            f"<VerticalResidual>{res_v[i]:.4f}</VerticalResidual></CalibrationPointRecord>"
        )
    rot_file = rotation_deg  # the file always states the angle; the convention is the reader's
    xml = (
        '<?xml version="1.0" encoding="utf-8"?>\n'
        '<JOBFile jobName="Fictional site" version="6.30" product="Synthetic" productVersion="1">'
        "<Environment><CoordinateSystem>"
        "<SystemName>Synthetic</SystemName><ZoneName>Doha site TM</ZoneName><DatumName>WGS 1984</DatumName>"
        "<Ellipsoid><EarthRadius>6378137</EarthRadius><Flattening>0.00335281066474748</Flattening></Ellipsoid>"
        "<Projection><Type>TransverseMercator</Type><Scale>1.00002</Scale><CentralMeridian>51.53</CentralMeridian>"
        "<OriginLatitude>25.29</OriginLatitude><FalseNorthing>20000</FalseNorthing><FalseEasting>10000</FalseEasting></Projection>"
        "<HorizontalAdjustment><Type>PlaneAdjustment</Type>"
        f"<OriginNorth>{h['originN']}</OriginNorth><OriginEast>{h['originE']}</OriginEast>"
        f"<TranslationNorth>{h['shiftN']}</TranslationNorth><TranslationEast>{h['shiftE']}</TranslationEast>"
        f"<Rotation>{rot_file!r}</Rotation><ScaleFactor>{h['scale']!r}</ScaleFactor></HorizontalAdjustment>"
        f"<VerticalAdjustment><Type>{vtype}</Type>"
        f"<OriginNorth>{v['originN']}</OriginNorth><OriginEast>{v['originE']}</OriginEast>"
        f"<SlopeNorthPerUnit>{v['slopeN']!r}</SlopeNorthPerUnit><SlopeEastPerUnit>{v['slopeE']!r}</SlopeEastPerUnit>"
        f"<ConstantAdjustment>{v['shiftM']!r}</ConstantAdjustment>{geoid_xml}</VerticalAdjustment>"
        "<UnknownFutureElement><Anything>kept out</Anything></UnknownFutureElement>"
        "</CoordinateSystem></Environment>"
        f"<FieldBook>{''.join(pts)}{''.join(cals)}</FieldBook>"
        "</JOBFile>\n"
    )
    truth = {"horizontal": h, "vertical": v, "residualH": res_h, "residualV": res_v, "projection": tm}
    return xml.encode("utf-8"), truth


if __name__ == "__main__":
    write_fixtures()
