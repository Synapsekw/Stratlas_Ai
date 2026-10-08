"""The site's one PROJ pipeline and the renderer's tables (M11 G1, ADR 0010, data-conventions 25).

Every coordinate a person reads or exports goes through :class:`SitePipeline`: PROJ (pyproj) with
the site's horizontal CRS, vertical datum, geoid grid and calibration, in the controller's order:

1. the data CRS (manifest ``crs``) to the display CRS through the operation PROJ chooses, or, for a
   calibrated site, to the calibration's base projection;
2. heights: stored heights (ellipsoidal, or orthometric on a named geoid) to ellipsoidal, then to
   the display datum: ``project`` keeps them as stored, ``ellipsoidal``, ``geoid`` subtracts the
   geoid's undulation (PROJ ``vgridshift`` on the pack's grid file), ``calibration`` puts them on
   the calibration's geoid (or keeps them ellipsoidal) and adds its vertical adjustment;
3. the calibration (``SiteCalibration``): the horizontal similarity (Helmert 2D) and the inclined
   plane, as one PROJ ``affine`` pipeline. The inclined plane is evaluated on the local (calibrated)
   grid coordinates: ``dz = shiftM + slopeN * (N' - originN) + slopeE * (E' - originE)``.

Nothing reaches the network: ``PROJ_NETWORK`` is ``OFF`` for the whole process (set when this
module is imported, and again by every entry point). A grid PROJ would need and does not have is an
exact refusal naming it ("needs the AUSGeoid2020 geoid pack", "needs the PROJ grid
uk_os_OSTN15_NTv2_OSGBtoETRS.tif"), never a silent fallback to a coarser operation or the ellipsoid.

All coordinates in and out are metres (SI inside): a CRS in feet is converted at the PROJ edge.
"""

from __future__ import annotations

import hashlib
import json
import math
import os
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import numpy as np

from ..runtime import JobError

os.environ["PROJ_NETWORK"] = "OFF"

#: Geoid ids that ship in the pipeline pack (PROJ-data names, NGA, public domain).
GLOBAL_GEOIDS = {"egm96": "us_nga_egm96_15.tif", "egm2008": "us_nga_egm08_25.tif"}
#: Folders searched for geoid pack files, separated by ``os.pathsep`` (main sets it to
#: ``<data>/packs/geoid``; tests point it at fixtures).
GEOID_DIRS_ENV = "QUADRION_GEOID_DIRS"
#: Cells per table at most; a larger site gets a coarser spacing (parity is still asserted).
MAX_CELLS = 1_000_000

SITE_TRANSFORM_FILE = "survey/geodesy/site-transform.json"
GRID_FILE = "site-grid.f64"
GEOID_FILE = "geoid-site.f64"


def network_off() -> None:
    """Switch PROJ's network access off (environment and the loaded library)."""
    os.environ["PROJ_NETWORK"] = "OFF"
    from pyproj import network

    network.set_network_enabled(False)


def proj_network_enabled() -> bool:
    from pyproj import network

    return bool(network.is_network_enabled())


# ------------------------------------------------------------------------------------------ CRS


def crs_of(value: Any):
    """A pyproj CRS from ``{ epsg }`` / ``{ wkt }``, an int or a string."""
    from pyproj import CRS

    try:
        if isinstance(value, dict):
            if isinstance(value.get("epsg"), int):
                return CRS.from_epsg(value["epsg"])
            if isinstance(value.get("wkt"), str):
                return CRS.from_wkt(value["wkt"])
            raise JobError("A coordinate system needs an EPSG code or WKT.")
        if isinstance(value, int):
            return CRS.from_epsg(value)
        return CRS.from_user_input(value)
    except JobError:
        raise
    except Exception as e:
        raise JobError(f"The coordinate system could not be read: {e}") from e


def crs_record(crs) -> dict[str, Any]:
    epsg = crs.to_epsg()
    return {"epsg": int(epsg)} if epsg else {"wkt": crs.to_wkt()}


def metres_per_unit(crs) -> float:
    """Metres per horizontal unit of a projected CRS (1 for metres, exactly 1200/3937 for US feet).

    Geographic CRSs (degrees) answer 1: their coordinates pass through unscaled.
    """
    if not crs.is_projected:
        return 1.0
    try:
        axes = crs.axis_info
        if axes:
            name = str(axes[0].unit_name).lower()
            if name == "us survey foot":
                return 1200 / 3937
            if name == "foot":
                return 0.3048
            if axes[0].unit_conversion_factor:
                return float(axes[0].unit_conversion_factor)
    except Exception:
        pass
    return 1.0


def horizontal_transformer(src, dst):
    """PROJ's best operation from ``src`` to ``dst`` (x east, y north), refusing a missing grid.

    Ballpark operations are never used; when the most accurate operation needs a grid that is not
    installed, the refusal names it rather than taking a less accurate one.
    """
    import warnings

    from pyproj.transformer import TransformerGroup

    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        group = TransformerGroup(src, dst, always_xy=True, allow_ballpark=False)
    if not group.best_available:
        names = sorted({g.short_name for op in group.unavailable_operations[:1] for g in op.grids})
        raise JobError(
            f"Converting {src.name} to {dst.name} needs the PROJ grid {', '.join(names) or '(unnamed)'}, "
            "which is not installed. Install the geoid or grid pack that has it."
        )
    if not group.transformers:
        raise JobError(f"PROJ has no exact operation from {src.name} to {dst.name}.")
    return group.transformers[0]


# ------------------------------------------------------------------------------------------ geoids


def geoid_dirs(extra: Sequence[Path] | None = None) -> list[Path]:
    dirs = [Path(p) for p in (extra or [])]
    env = os.environ.get(GEOID_DIRS_ENV)
    if env:
        dirs.extend(Path(p) for p in env.split(os.pathsep) if p)
    from ..photo.crs import geoid_search_dirs

    dirs.extend(geoid_search_dirs())
    return dirs


def geoid_file(geoid: str, dirs: Sequence[Path] | None = None) -> Path:
    """The grid file of a geoid pack id (``<id>.tif``/``.gtx``, or a global grid), or a refusal."""
    names = [f"{geoid}.tif", f"{geoid}.gtx"]
    if geoid in GLOBAL_GEOIDS:
        names.insert(0, GLOBAL_GEOIDS[geoid])
    for d in geoid_dirs(dirs):
        for n in names:
            p = d / n
            if p.is_file():
                return p
        meta = d / f"{geoid}.json"
        if meta.is_file():
            try:
                pf = json.loads(meta.read_text(encoding="utf-8")).get("projFile")
                if isinstance(pf, str) and (d / pf).is_file():
                    return d / pf
            except Exception:
                pass
    raise JobError(f"Showing heights on this site needs the {geoid} geoid pack, which is not installed.")


def _vgrid(path: Path):
    from pyproj import Transformer

    return Transformer.from_pipeline(f"+proj=vgridshift +grids={path.as_posix()} +multiplier=1")


def undulation(path: Path, lon, lat) -> np.ndarray:
    """The geoid undulation N (metres) from a grid file at longitudes and latitudes, via PROJ."""
    lon = np.asarray(lon, dtype=np.float64).ravel()
    lat = np.asarray(lat, dtype=np.float64).ravel()
    _, _, n = _vgrid(path).transform(lon, lat, np.zeros_like(lon), errcheck=False)
    n = np.asarray(n, dtype=np.float64)
    n[~np.isfinite(n)] = np.nan
    return n


# ------------------------------------------------------------------------------------------ pipeline


def calibration_pipeline(cal: dict[str, Any]) -> str | None:
    """The calibration's horizontal similarity and inclined plane as a PROJ ``affine`` pipeline."""
    steps: list[str] = []
    h = cal.get("horizontal")
    if isinstance(h, dict):
        s, th = float(h["scale"]), float(h["rotationRad"])
        oe, on = float(h["originE"]), float(h["originN"])
        c, si = s * math.cos(th), s * math.sin(th)
        xoff = oe + float(h["shiftE"]) - (c * oe - si * on)
        yoff = on + float(h["shiftN"]) - (si * oe + c * on)
        steps.append(
            f"+step +proj=affine +xoff={xoff!r} +yoff={yoff!r} +s11={c!r} +s12={-si!r} +s21={si!r} +s22={c!r}"
        )
    v = cal.get("vertical")
    if isinstance(v, dict):
        se, sn = float(v["slopeE"]), float(v["slopeN"])
        zoff = float(v["shiftM"]) - sn * float(v["originN"]) - se * float(v["originE"])
        steps.append(f"+step +proj=affine +zoff={zoff!r} +s31={se!r} +s32={sn!r} +s33=1")
    if not steps:
        return None
    return "+proj=pipeline " + " ".join(steps)


@dataclass
class SitePipeline:
    """Project CRS (E, N, z), metres, to the site's display coordinates (E, N, Z), metres."""

    data_crs: Any
    to_crs: Any
    horizontal: Any
    geographic: Any
    stored_geoid: Path | None
    display_geoid: Path | None
    vertical_kind: str
    calibration: Any | None
    calibration_id: str | None
    geoid_id: str | None
    operation: str
    data_scale: float
    to_scale: float

    def to_site(self, e, n, z=None) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        e = np.asarray(e, dtype=np.float64).ravel() / self.data_scale
        n = np.asarray(n, dtype=np.float64).ravel() / self.data_scale
        zz = np.zeros_like(e) if z is None else np.asarray(z, dtype=np.float64).ravel().copy()
        x, y = self.horizontal.transform(e, n, errcheck=False)
        x = np.asarray(x, dtype=np.float64) * self.to_scale
        y = np.asarray(y, dtype=np.float64) * self.to_scale
        offset = self.height_offset(e * self.data_scale, n * self.data_scale)
        zz = zz + offset
        if self.calibration is not None:
            x, y, zz = self.calibration.transform(x, y, zz, errcheck=False)
            x, y, zz = (np.asarray(a, dtype=np.float64) for a in (x, y, zz))
        return x, y, zz

    def height_offset(self, e, n) -> np.ndarray:
        """What is added to a stored height before the calibration's plane (metres)."""
        e = np.asarray(e, dtype=np.float64).ravel()
        if self.vertical_kind == "project":
            return np.zeros_like(e)
        lon, lat = self.geographic.transform(e / self.data_scale, np.asarray(n).ravel() / self.data_scale)
        off = np.zeros_like(e)
        if self.stored_geoid is not None:  # stored orthometric: back to ellipsoidal (h = H + N)
            off = off + undulation(self.stored_geoid, lon, lat)
        if self.display_geoid is not None:  # to orthometric (H = h - N)
            off = off - undulation(self.display_geoid, lon, lat)
        return off


def site_pipeline(
    data_crs: Any,
    settings: dict[str, Any],
    calibration: dict[str, Any] | None = None,
    *,
    stored_geoid: str | None = None,
    geoid_dirs_extra: Sequence[Path] | None = None,
) -> SitePipeline:
    """Build the site's pipeline from the manifest CRS, ``SurveySettings`` and the applied calibration.

    ``stored_geoid``: the geoid the stored heights are orthometric on (``None``: ellipsoidal).
    A calibration is used only when ``settings["calibration"]`` names it (an applied one).
    """
    network_off()
    from pyproj import CRS, Transformer

    src = crs_of(data_crs)
    vd = settings.get("verticalDatum") or {"kind": "project"}
    kind = vd.get("kind", "project")
    cal = calibration if calibration and settings.get("calibration") == calibration.get("id") else None
    if kind == "calibration" and cal is None:
        raise JobError("The heights follow the site calibration, but no calibration is applied.")
    if cal is not None:
        dst = crs_of(cal["projection"])
    else:
        dst = crs_of(settings["crs"]) if settings.get("crs") else src
    horizontal = horizontal_transformer(src, dst)
    geog = src.geodetic_crs or CRS.from_epsg(4326)
    geographic = Transformer.from_crs(src, geog, always_xy=True)

    display_geoid_id: str | None = None
    if kind == "geoid":
        display_geoid_id = str(vd["geoid"])
    elif kind == "calibration" and cal is not None and cal.get("geoid"):
        display_geoid_id = str(cal["geoid"])
    dirs = list(geoid_dirs_extra or [])
    display_geoid = geoid_file(display_geoid_id, dirs) if display_geoid_id else None
    stored = geoid_file(stored_geoid, dirs) if stored_geoid and kind != "project" else None
    cal_tr = None
    ops = [horizontal.description or horizontal.definition]
    if display_geoid is not None:
        ops.append(f"geoid {display_geoid_id} ({display_geoid.name})")
    if cal is not None:
        # the inclined plane only when the heights follow the calibration
        used = cal if kind == "calibration" else {k: v for k, v in cal.items() if k != "vertical"}
        pipe = calibration_pipeline(used)
        if pipe:
            cal_tr = Transformer.from_pipeline(pipe)
            ops.append(f"site calibration {cal.get('name', cal.get('id'))}")
    return SitePipeline(
        data_crs=src,
        to_crs=dst,
        horizontal=horizontal,
        geographic=geographic,
        stored_geoid=stored,
        display_geoid=display_geoid,
        vertical_kind=kind,
        calibration=cal_tr,
        calibration_id=cal.get("id") if cal else None,
        geoid_id=display_geoid_id,
        operation="; ".join(ops)[:2000],
        data_scale=metres_per_unit(src),
        to_scale=metres_per_unit(dst),
    )


# ------------------------------------------------------------------------------------------ tables


def _fingerprint(parts: dict[str, Any]) -> str:
    text = json.dumps(parts, sort_keys=True, separators=(",", ":"), default=str)
    return "sha256:" + hashlib.sha256(text.encode("utf-8")).hexdigest()


def _file_sha(p: Path | None) -> str | None:
    if p is None:
        return None
    h = hashlib.sha256()
    with p.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _lattice(extent: Sequence[float], spacing_m: float) -> tuple[float, float, int, int, float]:
    min_e, min_n, max_e, max_n = (float(v) for v in extent)
    if not (max_e > min_e and max_n > min_n):
        raise JobError("The site extent is empty.")
    spacing = float(spacing_m)
    while True:
        cols = math.floor((max_e - min_e) / spacing) + 2
        rows = math.floor((max_n - min_n) / spacing) + 2
        if cols * rows <= MAX_CELLS:
            return min_e, min_n, cols, rows, spacing
        spacing *= 2


def _proj4_for(pipe: SitePipeline, extent: Sequence[float]) -> str | None:
    """proj4 of the display CRS when it alone reproduces the site's horizontal mapping (25 points).

    Only without a calibration, and when PROJ evaluating the two proj4 strings agrees with the
    site's own operation within 1 mm at a 5 by 5 grid over the extent (proj4js uses the same
    strings; the catalogue checked proj4js against PROJ for the projection itself).
    """
    import warnings

    from pyproj import CRS, Transformer

    if pipe.calibration is not None:
        return None
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            p_from, p_to = pipe.data_crs.to_proj4(), pipe.to_crs.to_proj4()
        if not p_from or not p_to or "nadgrids" in p_to or "geoidgrids" in p_to:
            return None
        t = Transformer.from_crs(CRS.from_proj4(p_from), CRS.from_proj4(p_to), always_xy=True)
    except Exception:
        return None
    min_e, min_n, max_e, max_n = (float(v) for v in extent)
    es = np.repeat(np.linspace(min_e, max_e, 5), 5)
    ns = np.tile(np.linspace(min_n, max_n, 5), 5)
    x1, y1, _ = pipe.to_site(es, ns)
    x2, y2 = t.transform(es / pipe.data_scale, ns / pipe.data_scale)
    d = np.hypot(np.asarray(x2) * pipe.to_scale - x1, np.asarray(y2) * pipe.to_scale - y1)
    return p_to if np.all(np.isfinite(d)) and float(d.max()) <= 0.001 else None


def write_site_tables(
    project_root: str | Path,
    *,
    data_crs: Any,
    settings: dict[str, Any],
    extent: Sequence[float],
    calibration: dict[str, Any] | None = None,
    stored_geoid: str | None = None,
    geoid_dirs_extra: Sequence[Path] | None = None,
    spacing_m: float = 1.0,
) -> dict[str, Any]:
    """Write ``survey/geodesy/site-transform.json`` and its float64 tables; answer the header.

    Called by ``survey.prepare`` (G2) whenever the CRS, vertical datum, geoid or calibration of the
    site changes. Inputs:

    - ``data_crs``: the manifest ``crs`` (``{ epsg }`` or ``{ wkt }``), what stored E, N are in;
    - ``settings``: the ``SurveySettings`` dict (``survey/settings.json`` or the defaults);
    - ``extent``: ``(minE, minN, maxE, maxN)`` of the site in the data CRS, metres;
    - ``calibration``: the ``SiteCalibration`` dict, used only when ``settings["calibration"]``
      names it;
    - ``stored_geoid``: the geoid id the stored heights are orthometric on (None: ellipsoidal);
    - ``geoid_dirs_extra``: extra folders holding geoid packs (``<data>/packs/geoid``);
    - ``spacing_m``: the table spacing, 1 m by default (doubled until the table has at most
      ``MAX_CELLS`` cells).

    Tables (``F64Grid``, little-endian float64, row-major from the lower-left cell centre at
    ``originX``, ``originY``; rows run north, columns east; nodata NaN):

    - ``site-grid.f64`` (``grid``, 2 bands): the display E and N, metres, of each data E, N;
    - ``geoid-site.f64`` (``geoidGrid``, 1 band, only when heights are not ``project``): ``N_eff``,
      the value subtracted from a stored height to give the displayed height before the
      calibration's plane: the geoid undulation for a ``geoid`` datum (minus the stored geoid's
      when heights are stored orthometric), 0 for ``ellipsoidal`` with ellipsoidal storage. The
      calibration's inclined plane, when heights follow it, is folded in too (``N_eff`` minus
      ``dz``), so the renderer's height is ``z - N_eff`` everywhere.

    Refusals (``JobError``): a missing geoid pack or PROJ grid, an empty extent, or points PROJ
    cannot convert.
    """
    pipe = site_pipeline(
        data_crs,
        settings,
        calibration,
        stored_geoid=stored_geoid,
        geoid_dirs_extra=geoid_dirs_extra,
    )
    out_dir = Path(project_root) / "survey" / "geodesy"
    out_dir.mkdir(parents=True, exist_ok=True)
    x0, y0, cols, rows, spacing = _lattice(extent, spacing_m)
    gx = x0 + spacing * np.arange(cols, dtype=np.float64)
    gy = y0 + spacing * np.arange(rows, dtype=np.float64)
    ee, nn = np.meshgrid(gx, gy)  # rows north, cols east
    xs, ys, zs = pipe.to_site(ee.ravel(), nn.ravel(), np.zeros(ee.size))
    if not (np.all(np.isfinite(xs)) and np.all(np.isfinite(ys))):
        raise JobError("PROJ could not convert every point of the site extent.")
    grid = np.empty((rows * cols, 2), dtype="<f8")
    grid[:, 0], grid[:, 1] = xs, ys
    tmp = out_dir / f"{GRID_FILE}.tmp"
    tmp.write_bytes(grid.tobytes())
    os.replace(tmp, out_dir / GRID_FILE)
    header: dict[str, Any] = {
        "schema": "aio.site-transform/1",
        "from": crs_record(pipe.data_crs),
        "to": crs_record(pipe.to_crs),
        "operation": pipe.operation,
        "grid": {
            "file": GRID_FILE,
            "originX": x0,
            "originY": y0,
            "spacingM": spacing,
            "cols": cols,
            "rows": rows,
            "bands": 2,
        },
    }
    vertical_used = pipe.vertical_kind != "project" or pipe.calibration is not None
    if vertical_used:
        n_eff = -np.asarray(zs, dtype="<f8")
        tmp = out_dir / f"{GEOID_FILE}.tmp"
        tmp.write_bytes(n_eff.astype("<f8").tobytes())
        os.replace(tmp, out_dir / GEOID_FILE)
        header["geoidGrid"] = {**header["grid"], "file": GEOID_FILE, "bands": 1}
    elif (out_dir / GEOID_FILE).exists():
        (out_dir / GEOID_FILE).unlink()
    proj4 = _proj4_for(pipe, extent)
    if proj4:
        header["proj4"] = proj4[:2000]
    if pipe.calibration_id:
        header["calibration"] = pipe.calibration_id
    if pipe.geoid_id:
        header["geoid"] = pipe.geoid_id
    header["fingerprint"] = _fingerprint(
        {
            "from": header["from"],
            "settings": {k: settings.get(k) for k in ("crs", "verticalDatum", "calibration")},
            "calibration": {
                k: (calibration or {}).get(k) for k in ("id", "projection", "geoid", "horizontal", "vertical")
            }
            if pipe.calibration_id
            else None,
            "geoid": _file_sha(pipe.display_geoid),
            "stored": [stored_geoid, _file_sha(pipe.stored_geoid)],
            "extent": [float(v) for v in extent],
            "spacing": spacing,
        }
    )[:200]
    header["writtenAt"] = datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"
    tmp = out_dir / "site-transform.json.tmp"
    tmp.write_text(json.dumps(header, indent=2) + "\n", encoding="utf-8", newline="")
    os.replace(tmp, out_dir / "site-transform.json")
    return header
