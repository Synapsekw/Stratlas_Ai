"""Coordinate systems for photogrammetry runs: PROJ (through rasterio's GDAL), geoid grids, ENU frames.

Every conversion goes through PROJ. Axis order is longitude first everywhere in this module
(rasterio uses GDAL's traditional GIS order, so EPSG:4326 is ``lon, lat`` here, not PROJ's
authority ``lat, lon``).

Frames used by ``photo.align`` and ``photo.georef``:

- **geodetic**: longitude, latitude (degrees, WGS84) and a height (see "Heights" below);
- **ECEF**: EPSG:4978, metres;
- **ENU**: a local east-north-up tangent frame at a chosen geodetic point, metres. Rigid and
  truly metric, so similarity fits and bundle adjustment run in it (never in a projected CRS,
  whose grid scale factor is up to 4 cm per 100 m off in UTM);
- **grid**: the run's projected CRS (the project CRS) minus the project origin, ``x`` east, ``y``
  north, ``z`` up (the run's ``sparse/`` model and what ``photo.products`` reads).

Heights: PROJ treats the height of EPSG:4979 as ellipsoidal. Drone ``AbsoluteAltitude`` is
nominally above mean sea level; the run decides (``PhotoHeights``) and converts with a **named**
geoid grid. PROJ silently passes heights through when a grid named by an EPSG code is missing
(``EPSG:4326+3855`` without ``us_nga_egm08_25.tif`` returns the input unchanged), so this module
only ever names the grid file explicitly and refuses when it is not there.
"""

from __future__ import annotations

import math
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np

from ..runtime import JobError

#: PROJ-data file names of the geoid models (NGA, public domain).
GEOID_GRIDS = {"egm96": "us_nga_egm96_15.tif", "egm2008": "us_nga_egm08_25.tif"}
#: Environment variable naming an extra folder with geoid grids (tests, the pack's ``share/proj``).
GEOID_DIR_ENV = "AIO_GEOID_DIR"

WGS84_A = 6378137.0
WGS84_F = 1 / 298.257223563


def crs_of(value: Any):
    """A rasterio CRS from a manifest-style ``{ epsg }`` / ``{ wkt }``, an int, a string or a CRS."""
    from rasterio.crs import CRS

    if value is None:
        raise JobError("No coordinate system was given.")
    try:
        if isinstance(value, CRS):
            return value
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
    """The manifest-style record of a CRS (``{ epsg }`` when it has one, else ``{ wkt }``)."""
    crs = crs_of(crs)
    epsg = crs.to_epsg()
    return {"epsg": int(epsg)} if epsg else {"wkt": crs.to_wkt()}


def utm_epsg(lon: float, lat: float) -> int:
    """The WGS84 UTM zone EPSG code for a point (with the Norway and Svalbard exceptions)."""
    zone = math.floor((lon + 180) / 6) + 1
    if 56 <= lat < 64 and 3 <= lon < 12:
        zone = 32
    if 72 <= lat < 84:
        for lo, hi, z in ((0, 9, 31), (9, 21, 33), (21, 33, 35), (33, 42, 37)):
            if lo <= lon < hi:
                zone = z
    zone = min(max(zone, 1), 60)
    return (32600 if lat >= 0 else 32700) + zone


def _transform(src, dst, x, y, z=None):
    from rasterio.warp import transform

    x = np.asarray(x, dtype=np.float64).ravel()
    y = np.asarray(y, dtype=np.float64).ravel()
    if z is None:
        xs, ys = transform(src, dst, x.tolist(), y.tolist())
        return np.asarray(xs), np.asarray(ys)
    z = np.asarray(z, dtype=np.float64).ravel()
    xs, ys, zs = transform(src, dst, x.tolist(), y.tolist(), z.tolist())
    return np.asarray(xs), np.asarray(ys), np.asarray(zs)


def geodetic_to_crs(crs, lon, lat) -> tuple[np.ndarray, np.ndarray]:
    """Longitude and latitude (WGS84) to the CRS's horizontal coordinates."""
    return _transform(crs_of("EPSG:4326"), crs_of(crs), lon, lat)


def crs_to_geodetic(crs, x, y) -> tuple[np.ndarray, np.ndarray]:
    """The CRS's horizontal coordinates to longitude and latitude (WGS84)."""
    return _transform(crs_of(crs), crs_of("EPSG:4326"), x, y)


def geodetic_to_ecef(lon, lat, h) -> np.ndarray:
    """Longitude, latitude, ellipsoidal height to ECEF (EPSG:4978), through PROJ. Shape (n, 3)."""
    x, y, z = _transform(crs_of(4979), crs_of(4978), lon, lat, h)
    return np.stack([x, y, z], axis=1)


def ecef_to_geodetic(xyz) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    xyz = np.asarray(xyz, dtype=np.float64).reshape(-1, 3)
    return _transform(crs_of(4978), crs_of(4979), xyz[:, 0], xyz[:, 1], xyz[:, 2])


def enu_rotation(lon0: float, lat0: float) -> np.ndarray:
    """Rows are the east, north and up unit vectors at a point, in ECEF."""
    lo, la = math.radians(lon0), math.radians(lat0)
    return np.array(
        [
            [-math.sin(lo), math.cos(lo), 0.0],
            [-math.sin(la) * math.cos(lo), -math.sin(la) * math.sin(lo), math.cos(la)],
            [math.cos(la) * math.cos(lo), math.cos(la) * math.sin(lo), math.sin(la)],
        ]
    )


@dataclass(frozen=True)
class EnuFrame:
    """A local east-north-up frame at a geodetic point (heights in the run's height system)."""

    lon0: float
    lat0: float
    h0: float

    @property
    def origin_ecef(self) -> np.ndarray:
        return geodetic_to_ecef([self.lon0], [self.lat0], [self.h0])[0]

    @property
    def rotation(self) -> np.ndarray:
        return enu_rotation(self.lon0, self.lat0)

    def from_geodetic(self, lon, lat, h) -> np.ndarray:
        ecef = geodetic_to_ecef(lon, lat, h)
        return (ecef - self.origin_ecef) @ self.rotation.T

    def to_geodetic(self, enu) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        enu = np.asarray(enu, dtype=np.float64).reshape(-1, 3)
        return ecef_to_geodetic(enu @ self.rotation + self.origin_ecef)

    def record(self) -> dict[str, float]:
        return {"lon": self.lon0, "lat": self.lat0, "h": self.h0}


@dataclass(frozen=True)
class GridFrame:
    """The run's projected CRS minus an origin: ``x`` east, ``y`` north, ``z`` up (metres)."""

    crs: Any
    origin: tuple[float, float, float]

    def from_geodetic(self, lon, lat, h) -> np.ndarray:
        e, n = geodetic_to_crs(self.crs, lon, lat)
        h = np.asarray(h, dtype=np.float64).ravel()
        o = self.origin
        return np.stack([e - o[0], n - o[1], h - o[2]], axis=1)

    def to_geodetic(self, xyz) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        xyz = np.asarray(xyz, dtype=np.float64).reshape(-1, 3)
        o = self.origin
        lon, lat = crs_to_geodetic(self.crs, xyz[:, 0] + o[0], xyz[:, 1] + o[1])
        return lon, lat, xyz[:, 2] + o[2]

    def record(self) -> dict[str, Any]:
        return {"crs": crs_record(self.crs), "origin": list(self.origin)}


def enu_to_grid(enu_frame: EnuFrame, grid: GridFrame, xyz) -> np.ndarray:
    return grid.from_geodetic(*enu_frame.to_geodetic(xyz))


def grid_to_enu(enu_frame: EnuFrame, grid: GridFrame, xyz) -> np.ndarray:
    return enu_frame.from_geodetic(*grid.to_geodetic(xyz))


def transform_rotations(
    convert, centres: np.ndarray, rotations: np.ndarray, arm: float = 10.0
) -> tuple[np.ndarray, np.ndarray]:
    """Carry camera poses through a point conversion (ENU to grid and back).

    ``rotations`` are world-to-camera (``cam = R @ (X - C)``). The conversion is applied to each
    centre and to a point ``arm`` metres along each camera axis; the axes are rebuilt from the
    converted points (orthonormalised), so meridian convergence and the grid scale are honoured.
    """
    centres = np.asarray(centres, dtype=np.float64).reshape(-1, 3)
    rotations = np.asarray(rotations, dtype=np.float64).reshape(-1, 3, 3)
    n = len(centres)
    if n == 0:
        return centres.copy(), rotations.copy()
    pts = [centres]
    for k in range(3):  # camera axes in world: rows of R
        pts.append(centres + arm * rotations[:, k, :])
    out = convert(np.concatenate(pts, axis=0))
    c2 = out[:n]
    axes = np.stack([out[(k + 1) * n : (k + 2) * n] - c2 for k in range(3)], axis=1)  # (n, 3, 3)
    r2 = np.empty_like(rotations)
    for i in range(n):  # nearest rotation (polar decomposition)
        u, _, vt = np.linalg.svd(axes[i])
        r = u @ vt
        if np.linalg.det(r) < 0:
            u[:, -1] *= -1
            r = u @ vt
        r2[i] = r
    return c2, r2


# ------------------------------------------------------------------------------------- geoid


def geoid_search_dirs() -> list[Path]:
    dirs: list[Path] = []
    for key in (GEOID_DIR_ENV, "PROJ_DATA", "PROJ_LIB"):
        v = os.environ.get(key)
        if v:
            dirs.extend(Path(p) for p in v.split(os.pathsep) if p)
    try:  # the pack ships the grids beside rasterio's proj.db when G1 bundles them
        import rasterio

        dirs.append(Path(rasterio.__file__).parent / "proj_data")
    except Exception:  # pragma: no cover - rasterio is a pack dependency
        pass
    return dirs


def geoid_grid(name: str) -> Path | None:
    """The file of a named geoid model (``egm96`` or ``egm2008``), or None when not installed."""
    file = GEOID_GRIDS.get(name)
    if not file:
        raise JobError(f'Unknown geoid model "{name}"; use egm96 or egm2008.')
    for d in geoid_search_dirs():
        p = d / file
        if p.is_file():
            return p
    return None


def _geoid_crs(grid: Path):
    return crs_of(f"+proj=longlat +datum=WGS84 +geoidgrids={grid.as_posix()} +vunits=m +no_defs +type=crs")


def ellipsoidal_to_orthometric(lon, lat, h, geoid: str | Path) -> np.ndarray:
    """``H = h - N`` with the geoid undulation ``N`` from a named grid (or a grid file), via PROJ."""
    grid = Path(geoid) if isinstance(geoid, Path) else geoid_grid(geoid)
    if grid is None or not grid.is_file():
        raise JobError(
            f"The {geoid} geoid grid ({GEOID_GRIDS.get(str(geoid), geoid)}) is not installed, so "
            "ellipsoidal heights cannot be converted. Install the pipeline pack's geoid grids."
        )
    _, _, out = _transform(crs_of(4979), _geoid_crs(grid), lon, lat, h)
    return out


def orthometric_to_ellipsoidal(lon, lat, height, geoid: str | Path) -> np.ndarray:
    grid = Path(geoid) if isinstance(geoid, Path) else geoid_grid(geoid)
    if grid is None or not grid.is_file():
        raise JobError(f"The {geoid} geoid grid is not installed, so heights cannot be converted.")
    _, _, out = _transform(_geoid_crs(grid), crs_of(4979), lon, lat, height)
    return out


def haversine_m(lon1, lat1, lon2, lat2) -> np.ndarray:
    """Great-circle distance on the WGS84 sphere of radius ``a``, metres (pairing, not survey maths)."""
    lon1, lat1, lon2, lat2 = (np.radians(np.asarray(v, dtype=np.float64)) for v in (lon1, lat1, lon2, lat2))
    a = np.sin((lat2 - lat1) / 2) ** 2 + np.cos(lat1) * np.cos(lat2) * np.sin((lon2 - lon1) / 2) ** 2
    return 2 * WGS84_A * np.arcsin(np.sqrt(np.clip(a, 0, 1)))
