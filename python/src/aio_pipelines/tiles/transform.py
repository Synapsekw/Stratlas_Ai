"""Project coordinates to the Earth-centred frame of 3D Tiles, per vertex in float64.

The project local frame (data-conventions section 1: x east, y up, z south, metres) relates to the
project CRS by ``E = origin[0] + x``, ``N = origin[1] - z``, ``H = origin[2] + y``. A tileset is
written in ECEF (EPSG:4978) through that CRS, never by treating UTM metres as a tangent plane
(data-conventions section 22): each vertex goes CRS to longitude and latitude (GDAL through
rasterio), then to ECEF on the WGS84 ellipsoid, then into the east-north-up frame of the tileset
root (``root.transform``), stored as float32 offsets from each tile's centre.

Heights: the project height ``H`` is taken as the height above the ellipsoid (the pack has no geoid
grids offline). The tileset names this in ``extras.aio.heights`` so the Globe, which knows the
geoid separation of its terrain, can add it as one vertical shift at the site.

glTF content is y-up; 3D Tiles turns it to z-up with x unchanged, y to z and z to minus y. Content
written as (east, up, -north) therefore lands in the root's east-north-up frame exactly, which is
also the site view's own axis order (x east, y up, z south).
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any

import numpy as np

from ..runtime import JobError

A = 6378137.0
F = 1 / 298.257223563
E2 = F * (2 - F)


def crs_of(manifest: dict[str, Any]) -> Any:
    from rasterio.crs import CRS

    crs = manifest.get("crs") or {}
    try:
        if isinstance(crs, dict) and isinstance(crs.get("epsg"), int):
            return CRS.from_epsg(crs["epsg"])
        if isinstance(crs, dict) and isinstance(crs.get("wkt"), str):
            return CRS.from_wkt(crs["wkt"])
    except Exception as e:
        raise JobError(f"The project CRS is not one GDAL knows: {e}") from e
    raise JobError("The project has no CRS; 3D Tiles are placed through it.")


def origin_of(manifest: dict[str, Any]) -> np.ndarray:
    o = manifest.get("origin")
    if not isinstance(o, list) or len(o) != 3:
        raise JobError("The project has no origin.")
    return np.asarray(o, dtype=np.float64)


def geodetic_to_ecef(lon_deg: np.ndarray, lat_deg: np.ndarray, h: np.ndarray) -> np.ndarray:
    lon = np.radians(np.asarray(lon_deg, dtype=np.float64))
    lat = np.radians(np.asarray(lat_deg, dtype=np.float64))
    h = np.asarray(h, dtype=np.float64)
    sl, cl = np.sin(lat), np.cos(lat)
    n = A / np.sqrt(1 - E2 * sl * sl)
    return np.stack(
        [(n + h) * cl * np.cos(lon), (n + h) * cl * np.sin(lon), (n * (1 - E2) + h) * sl], axis=-1
    )


def enu_rotation(lon_deg: float, lat_deg: float) -> np.ndarray:
    """3 x 3 whose columns are east, north and up at a place, in ECEF."""
    lon, lat = math.radians(lon_deg), math.radians(lat_deg)
    sl, cl, so, co = math.sin(lat), math.cos(lat), math.sin(lon), math.cos(lon)
    east = [-so, co, 0.0]
    north = [-sl * co, -sl * so, cl]
    up = [cl * co, cl * so, sl]
    return np.array([east, north, up], dtype=np.float64).T


@dataclass(frozen=True)
class SiteFrame:
    """The tileset root frame: east, north, up at the project origin."""

    crs: Any
    origin: np.ndarray  # project CRS E, N, H of the local frame origin
    lonlat: tuple[float, float]
    ecef: np.ndarray  # ECEF of the origin
    rot: np.ndarray  # ENU to ECEF rotation

    @classmethod
    def of(cls, manifest: dict[str, Any]) -> SiteFrame:
        crs = crs_of(manifest)
        origin = origin_of(manifest)
        lon, lat = crs_to_lonlat(crs, origin[:1], origin[1:2])
        ecef = geodetic_to_ecef(lon, lat, origin[2:3])[0]
        return cls(
            crs, origin, (float(lon[0]), float(lat[0])), ecef, enu_rotation(float(lon[0]), float(lat[0]))
        )

    def root_transform(self) -> list[float]:
        """Column-major 4 x 4 from the root's east-north-up frame to ECEF."""
        m = np.eye(4)
        m[:3, :3] = self.rot
        m[:3, 3] = self.ecef
        return [float(v) for v in m.T.ravel()]

    def local_to_ecef(self, xyz: np.ndarray) -> np.ndarray:
        """Project local frame (x east, y up, z south) to ECEF, per point, float64."""
        p = np.asarray(xyz, dtype=np.float64)
        e = self.origin[0] + p[:, 0]
        n = self.origin[1] - p[:, 2]
        h = self.origin[2] + p[:, 1]
        lon, lat = crs_to_lonlat(self.crs, e, n)
        return geodetic_to_ecef(lon, lat, h)

    def local_to_enu(self, xyz: np.ndarray) -> np.ndarray:
        """Project local frame to the root's east-north-up frame (float64)."""
        return (self.local_to_ecef(xyz) - self.ecef) @ self.rot

    def extras(self, manifest: dict[str, Any]) -> dict[str, Any]:
        return {
            "crs": manifest.get("crs"),
            "origin": [float(v) for v in self.origin],
            "originLonLat": [self.lonlat[0], self.lonlat[1]],
            "heights": "project-heights-as-ellipsoidal",
        }


def crs_to_lonlat(crs: Any, e: np.ndarray, n: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    from rasterio.warp import transform

    e = np.asarray(e, dtype=np.float64)
    n = np.asarray(n, dtype=np.float64)
    if crs.is_geographic:
        return e, n
    lon_out = np.empty_like(e)
    lat_out = np.empty_like(n)
    step = 500_000
    for i in range(0, e.size, step):
        lon, lat = transform(crs, "EPSG:4326", e[i : i + step], n[i : i + step])
        lon_out[i : i + step] = lon
        lat_out[i : i + step] = lat
    return lon_out, lat_out


def enu_to_gltf(enu: np.ndarray) -> np.ndarray:
    """East-north-up to glTF y-up (east, up, -north)."""
    return np.stack([enu[:, 0], enu[:, 2], -enu[:, 1]], axis=-1)


def gltf_to_enu(p: np.ndarray) -> np.ndarray:
    return np.stack([p[:, 0], -p[:, 2], p[:, 1]], axis=-1)


def box_of(enu: np.ndarray, pad: float = 0.0) -> list[float]:
    """A 3D Tiles bounding ``box`` (centre and three half axes) around east-north-up points."""
    lo = enu.min(axis=0) - pad
    hi = enu.max(axis=0) + pad
    c = (lo + hi) / 2
    h = np.maximum((hi - lo) / 2, 1e-3)
    return [
        float(c[0]),
        float(c[1]),
        float(c[2]),
        float(h[0]),
        0.0,
        0.0,
        0.0,
        float(h[1]),
        0.0,
        0.0,
        0.0,
        float(h[2]),
    ]
