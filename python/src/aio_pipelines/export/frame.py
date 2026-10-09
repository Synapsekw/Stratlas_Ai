"""Where an export's numbers go, and what the file says about it (M11 G7, data-conventions 25).

An export's frame is one of:

- ``site``: the site grid of the survey settings, through G1's one PROJ pipeline
  (:func:`aio_pipelines.geodesy.site.site_pipeline`): the display CRS, the vertical datum and
  geoid, and the applied site calibration when there is one ("site grid" means calibrated);
- ``wgs84``: longitude and latitude (EPSG:4326) with the site's heights; a vertical datum that
  follows the calibration becomes ellipsoidal heights (a calibration's plane belongs to its grid);
- ``{ epsg }``: any EPSG CRS, heights as for WGS 84.

Nothing here re-implements a datum: every coordinate goes through ``SitePipeline.to_site`` (and
its PROJ inverse for raster cells). Stored values are metres (SI inside); the units (``m``, ``ft``
for the international foot, ``us-ft`` for the US survey foot) apply only at the edge:

- formats that carry their CRS (GeoTIFF, LAS/LAZ, SHP, GeoJSON) write horizontal coordinates in
  the CRS's own unit, so ``units`` must be that unit for a projected CRS (a file in US feet on a
  metric grid would land in the wrong place); heights are in ``units``;
- formats that do not (DXF, LandXML, 12da, CSV) write everything in ``units``;
- KML is WGS 84 longitude and latitude with heights in metres, by its specification;
- a geographic CRS (WGS 84) writes degrees, with heights in ``units``; CAD formats need a grid.

Every export states its CRS, vertical datum, geoid, calibration and units (``Frame.meta`` and
``Frame.notes()``) and carries a file name suffix (``Frame.suffix``):
``_<crs>[_<heights>]_<units>``, for example ``_site-grid_usft``, ``_site-grid-cal_egm2008_m``,
``_wgs84_ellh_m``, ``_epsg2227_usft``. ``<crs>`` is ``site-grid`` (``site-grid-cal`` with a
calibration), ``wgs84`` or ``epsg<code>``; ``<heights>`` is left out for project heights, ``ellh``
for ellipsoidal heights, the geoid id for a geoid and ``cal`` for the calibration's vertical
adjustment; ``<units>`` is ``m``, ``ft`` or ``usft``.
"""

from __future__ import annotations

import json
import math
import re
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import numpy as np

from ..runtime import JobError

#: Metres per output length unit (the international foot and the US survey foot are distinct).
LINEAR: dict[str, float] = {"m": 1.0, "ft": 0.3048, "us-ft": 1200 / 3937}
UNIT_WORD = {"m": "m", "ft": "ft", "us-ft": "usft"}
UNIT_LABEL = {
    "m": "metres",
    "ft": "feet (international, 0.3048 m)",
    "us-ft": "US survey feet (1200/3937 m)",
}
#: Formats whose files carry their own CRS.
EMBEDDED = frozenset({"geotiff", "laz", "shp", "geojson", "kml"})
#: Formats that need a grid (no longitude and latitude).
GRID_ONLY = frozenset({"dxf", "landxml", "12da"})
#: Vertical EPSG codes of the geoids that ship in the pack, when the settings name none.
GEOID_EPSG = {"egm96": 5773, "egm2008": 3855}
PRODUCT = "Quadrion AI"


def unit_of(crs: Any) -> str | None:
    """``m``, ``ft`` or ``us-ft`` for a projected CRS's horizontal unit; None for degrees or other units."""
    from ..geodesy.site import metres_per_unit

    if not crs.is_projected:
        return None
    k = metres_per_unit(crs)
    for name, v in LINEAR.items():
        if math.isclose(k, v, rel_tol=1e-12):
            return name
    return None


def _slug(s: str) -> str:
    return re.sub(r"[^a-z0-9-]+", "", s.lower()) or "geoid"


def name_suffix(crs: Any, calibrated: bool, vertical: str, geoid: str | None, units: str) -> str:
    """The file name suffix of an export (the TypeScript ``exportSuffix`` is the same rule).

    ``crs``: ``site``, ``wgs84`` or ``{ epsg }``; ``calibrated``: a calibration is applied (it is
    used only by the site grid); ``vertical``: the site's vertical datum kind; ``geoid``: its geoid
    id; ``units``: ``m``, ``ft`` or ``us-ft``.
    """
    if crs == "site":
        word = "site-grid-cal" if calibrated else "site-grid"
    elif crs == "wgs84":
        word = "wgs84"
    else:
        word = f"epsg{int(crs['epsg'])}"
    if vertical == "calibration" and crs != "site":
        vertical = "ellipsoidal"
    v = {"project": "", "ellipsoidal": "ellh", "calibration": "cal"}.get(vertical)
    if v is None:
        v = _slug(geoid or "geoid")
    return "_" + "_".join(w for w in (word, v, UNIT_WORD[units]) if w)


def read_json(path: Path, what: str) -> dict[str, Any] | None:
    if not path.is_file():
        return None
    try:
        v = json.loads(path.read_text("utf-8"))
    except (OSError, ValueError) as e:
        raise JobError(f"The {what} could not be read: {e}") from e
    return v if isinstance(v, dict) else None


def site_files(project: Path) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any] | None]:
    """(manifest CRS, survey settings, the applied calibration or None) of a project."""
    m = read_json(project / "manifest.json", "project manifest") or {}
    crs = m.get("crs")
    if not isinstance(crs, dict) or not (isinstance(crs.get("epsg"), int) or isinstance(crs.get("wkt"), str)):
        raise JobError("The project has no coordinate system; set one before exporting survey data.")
    data_crs = {"epsg": crs["epsg"]} if isinstance(crs.get("epsg"), int) else {"wkt": crs["wkt"]}
    settings = read_json(project / "survey" / "settings.json", "survey settings") or {}
    cal = read_json(project / "survey" / "calibration.json", "site calibration")
    if cal is not None and not (
        cal.get("appliedAt") and settings.get("calibration") and settings.get("calibration") == cal.get("id")
    ):
        cal = None
    return data_crs, settings, cal


@dataclass
class Frame:
    """The output frame of one export: ``forward`` places project (E, N, Z) metres in it."""

    kind: str
    fmt: str
    pipe: Any
    geographic: bool
    calibrated: bool
    #: the unit heights (and, for files without a CRS, every coordinate) are written in
    units: str
    #: the unit horizontal coordinates are written in; None for degrees
    horizontal: str | None
    epsg: int | None
    vertical_epsg: int | None
    #: the CRS written into files that carry one, as WKT (a local CRS for a calibrated grid)
    wkt: str
    meta: dict[str, Any] = field(default_factory=dict)
    suffix: str = ""

    @property
    def k_h(self) -> float:
        return 1.0 if self.horizontal is None else LINEAR[self.horizontal]

    @property
    def k_z(self) -> float:
        return LINEAR[self.units]

    def forward(self, e: Any, n: Any, z: Any = None) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        """Project E, N, Z (metres) to output numbers (x east or longitude, y north or latitude, z)."""
        x, y, zz = self.pipe.to_site(e, n, z)
        if not (np.all(np.isfinite(x)) and np.all(np.isfinite(y))):
            raise JobError("PROJ could not convert every point of the export to the chosen coordinates.")
        k = self.k_h
        return x / k, y / k, zz / self.k_z

    def forward_xyz(self, xyz: np.ndarray) -> np.ndarray:
        a = np.asarray(xyz, dtype=np.float64).reshape(-1, 3)
        if len(a) == 0:
            return a.copy()
        x, y, z = self.forward(a[:, 0], a[:, 1], a[:, 2])
        return np.stack([x, y, z], axis=1)

    def inverse_xy(self, x: Any, y: Any) -> tuple[np.ndarray, np.ndarray]:
        """Output x, y back to project E, N (metres): PROJ's inverse of the same operations."""
        from pyproj.enums import TransformDirection

        p = self.pipe
        xs = np.asarray(x, dtype=np.float64).ravel() * self.k_h
        ys = np.asarray(y, dtype=np.float64).ravel() * self.k_h
        if p.calibration is not None:
            xs, ys, _ = p.calibration.transform(
                xs, ys, np.zeros_like(xs), direction=TransformDirection.INVERSE, errcheck=False
            )
            xs, ys = np.asarray(xs, dtype=np.float64), np.asarray(ys, dtype=np.float64)
        es, ns = p.horizontal.transform(
            xs / p.to_scale, ys / p.to_scale, direction=TransformDirection.INVERSE, errcheck=False
        )
        return np.asarray(es, dtype=np.float64) * p.data_scale, np.asarray(
            ns, dtype=np.float64
        ) * p.data_scale

    def notes(self, title: str | None = None) -> list[str]:
        """The statement every export carries, one fact per line."""
        m = self.meta
        lines = [title] if title else []
        lines += [
            f"Coordinate system: {m['crs']}",
            f"Horizontal units: {m['horizontalUnits']}",
            f"Vertical datum: {m['verticalDatum']}",
            f"Geoid: {m['geoid'] or 'none'}",
            f"Site calibration: {m['calibration'] or 'none'}",
            f"Height units: {m['units']}",
            f"Operation: {m['operation']}",
            f"Written by {PRODUCT} survey.export on {m['writtenAt']}",
        ]
        return lines


def _vertical(
    vd: dict[str, Any], cal: dict[str, Any] | None, site: bool, ellipsoid: str
) -> tuple[dict[str, Any], str, str | None, str, int | None]:
    """(vertical datum used, its words, geoid id, file name word, vertical EPSG)."""
    kind = vd.get("kind", "project")
    if kind == "calibration" and not site:
        kind, vd = "ellipsoidal", {"kind": "ellipsoidal"}
    if kind == "project":
        return vd, "Project heights, as stored", None, "", None
    if kind == "ellipsoidal":
        return vd, f"Ellipsoidal heights ({ellipsoid})", None, "ellh", None
    if kind == "geoid":
        gid = str(vd.get("geoid"))
        epsg = vd.get("epsg") if isinstance(vd.get("epsg"), int) else GEOID_EPSG.get(gid)
        words = f"Orthometric heights on the {gid} geoid" + (f" (EPSG:{epsg})" if epsg else "")
        return vd, words, gid, _slug(gid), epsg
    if cal is None:
        raise JobError("The heights follow the site calibration, but no calibration is applied.")
    gid = cal.get("geoid")
    on = f"the {gid} geoid" if gid else f"ellipsoidal heights ({ellipsoid})"
    return vd, f"Site calibration vertical adjustment on {on}", str(gid) if gid else None, "cal", None


def build_frame(
    project: Path,
    crs: Any,
    fmt: str,
    units: str | None = None,
    geoid_dirs: list[Path] | None = None,
) -> Frame:
    """The frame of an export of ``fmt`` in ``crs`` (``site``, ``wgs84`` or ``{ epsg }``)."""
    from pyproj import CRS

    from ..geodesy.site import crs_of, site_pipeline

    if units is not None and units not in LINEAR:
        raise JobError(
            f"Survey files are written in metres, feet (international) or US survey feet, not {units}."
        )
    data_crs, settings, cal = site_files(project)
    vd_site = settings.get("verticalDatum") or {"kind": "project"}
    if crs == "site":
        kind = "site"
        target = None
        used_cal = cal
        s = dict(settings)
    else:
        kind = "wgs84" if crs == "wgs84" else "epsg"
        code = 4326 if crs == "wgs84" else int(crs["epsg"])
        target = {"epsg": code}
        used_cal = None
        s = {"crs": target}
    ellipsoid_name = crs_of(data_crs).ellipsoid.name if crs_of(data_crs).ellipsoid else "the ellipsoid"
    vd, v_words, geoid, _, v_epsg = _vertical(vd_site, used_cal, kind == "site", ellipsoid_name)
    s["verticalDatum"] = vd
    if used_cal is None:
        s.pop("calibration", None)
    pipe = site_pipeline(data_crs, s, used_cal, geoid_dirs_extra=geoid_dirs)
    calibrated = pipe.calibration_id is not None
    to_crs = pipe.to_crs
    geographic = not calibrated and to_crs.is_geographic
    if fmt == "kml" and not (kind == "wgs84"):
        raise JobError("KML and KMZ hold WGS 84 longitude and latitude; export them in WGS 84.")
    if geographic and fmt in GRID_ONLY:
        raise JobError(
            f"{fmt.upper() if fmt != '12da' else '12da'} files need grid coordinates; export them in the "
            "site grid or a projected EPSG coordinate system, not longitude and latitude."
        )
    crs_unit = None if geographic else ("m" if calibrated else unit_of(to_crs))
    if calibrated:
        base_unit = unit_of(to_crs)
        crs_unit = base_unit if base_unit else "m"
    if not geographic and crs_unit is None:
        raise JobError(f"{to_crs.name} is not in metres or feet; choose another coordinate system.")
    u = units or (crs_unit if crs_unit else "m")
    if fmt in ("kml",) and u != "m":
        raise JobError("KML and KMZ heights are metres by the format's definition; export them in metres.")
    if calibrated:
        horizontal: str | None = u
    elif geographic:
        horizontal = None
    elif fmt in EMBEDDED:
        if u != crs_unit:
            raise JobError(
                f"{to_crs.name} is in {UNIT_LABEL[crs_unit or 'm']}; a {fmt.upper()} file in it holds "
                f"{UNIT_LABEL[crs_unit or 'm']}. Choose those units, or a coordinate system in "
                f"{UNIT_LABEL[u]}."
            )
        horizontal = crs_unit
    else:
        horizontal = u
    epsg = None if calibrated else to_crs.to_epsg()
    if calibrated:
        assert cal is not None
        cal_name = str(cal.get("name") or cal.get("id"))
        base = crs_of(cal["projection"])
        unit_wkt = {
            "m": 'UNIT["metre",1]',
            "ft": 'UNIT["foot",0.3048]',
            "us-ft": 'UNIT["US survey foot",0.304800609601219]',
        }[u]
        wkt = (
            f'LOCAL_CS["{PRODUCT} site grid, calibrated: {cal_name} on {base.name}",'
            f'LOCAL_DATUM["{cal_name}",0],{unit_wkt},AXIS["Easting",EAST],AXIS["Northing",NORTH]]'
        )
        crs_words = f"Site grid, calibrated: {cal_name} on {base.name}" + (
            f" (EPSG:{base.to_epsg()})" if base.to_epsg() else ""
        )
    else:
        wkt = to_crs.to_wkt()
        crs_words = to_crs.name + (f" (EPSG:{epsg})" if epsg else "")
        if kind == "site":
            crs_words = f"Site grid: {crs_words}"
    cal_words = None
    if calibrated and cal is not None:
        parts = [str(cal.get("name") or cal.get("id"))]
        rh, rv = cal.get("rmsH"), cal.get("rmsV")
        if isinstance(rh, int | float) and isinstance(rv, int | float):
            parts.append(f"residuals H {rh * 1000:.0f} mm, V {rv * 1000:.0f} mm")
        cal_words = ", ".join(parts)
    suffix = name_suffix(crs, calibrated, str(vd_site.get("kind", "project")), geoid, u)
    if v_epsg and not geographic and not calibrated and epsg:
        try:
            CRS.from_user_input(f"EPSG:{epsg}+{v_epsg}")
        except Exception:
            v_epsg = None
    meta = {
        "crs": crs_words,
        "crsKind": kind,
        "epsg": epsg,
        "verticalDatum": v_words,
        "verticalEpsg": v_epsg,
        "geoid": geoid,
        "calibration": cal_words,
        "units": UNIT_LABEL[u],
        "unitsId": u,
        "horizontalUnits": "degrees" if horizontal is None else UNIT_LABEL[horizontal],
        "operation": pipe.operation,
        "writtenAt": datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }
    return Frame(
        kind=kind,
        fmt=fmt,
        pipe=pipe,
        geographic=geographic,
        calibrated=calibrated,
        units=u,
        horizontal=horizontal,
        epsg=epsg,
        vertical_epsg=v_epsg,
        wkt=wkt,
        meta=meta,
        suffix=suffix,
    )


def export_name(base: str, frame_suffix: str, ext: str) -> str:
    """``<base><suffix>.<ext>`` with ``base`` made file-name safe."""
    b = re.sub(r"[^A-Za-z0-9._()-]+", "-", base).strip("-.") or "export"
    return f"{b[:120]}{frame_suffix}.{ext}"
