"""Synthetic road survey inputs for road-builder.spec.ts (no client data).

    python road-fixture.py <folder>

Writes a 200 m x 40 m RGBA orthomosaic (5 cm, EPSG:32638) with a grey carriageway along x,
three defect polygons (GeoJSON, lon/lat) and prints JSON: the road centre and the centreline end
points in lon/lat.
"""

import json
import sys
from pathlib import Path

import numpy as np
import rasterio
from rasterio.transform import from_origin
from rasterio.warp import transform

out = Path(sys.argv[1])
out.mkdir(parents=True, exist_ok=True)
LAT, LON = 29.3765, 47.9900
(E,), (N,) = transform("EPSG:4326", "EPSG:32638", [LON], [LAT])
E, N = round(E), round(N)
RES, W, H = 0.05, 200.0, 40.0
x0, y1 = E - W / 2, N + H / 2
w, h = round(W / RES), round(H / RES)

yy, xx = np.mgrid[0:h, 0:w]
north = y1 - (yy + 0.5) * RES
road = np.abs(north - N) <= 3.65
rgb = np.empty((3, h, w), np.uint8)
rgb[0] = np.where(road, 92, 196)
rgb[1] = np.where(road, 94, 170)
rgb[2] = np.where(road, 98, 128)
alpha = np.full((h, w), 255, np.uint8)
alpha[:, :20] = 0  # a no-data edge, as orthos have

DEFECTS = [("Alligator Cracker", "Few", 40), ("Potholes", "Extensive", 100), ("Raveling", "Intermediate", 160)]
feats = []
for name, stage, dx in DEFECTS:
    ex0, ex1 = x0 + dx, x0 + dx + 2.0
    ny0, ny1 = N - 1.0, N + 0.5
    c0, c1 = round((ex0 - x0) / RES), round((ex1 - x0) / RES)
    r0, r1 = round((y1 - ny1) / RES), round((y1 - ny0) / RES)
    rgb[:, r0:r1, c0:c1] = 30
    lon, lat = transform("EPSG:32638", "EPSG:4326", [ex0, ex1, ex1, ex0, ex0], [ny0, ny0, ny1, ny1, ny0])
    feats.append(
        {
            "type": "Feature",
            "geometry": {"type": "Polygon", "coordinates": [[[a, b] for a, b in zip(lon, lat, strict=True)]]},
            "properties": {"DefectName": name, "Stages": stage},
        }
    )

with rasterio.open(
    out / "road-ortho.tif", "w", driver="GTiff", width=w, height=h, count=4, dtype="uint8",
    crs="EPSG:32638", transform=from_origin(x0, y1, RES, RES), photometric="RGB", alpha="YES",
    tiled=True, compress="deflate",
) as d:
    d.write(np.concatenate([rgb, alpha[None]]))
(out / "defects.geojson").write_text(json.dumps({"type": "FeatureCollection", "features": feats}))

lon, lat = transform("EPSG:32638", "EPSG:4326", [x0 + 5, x0 + W - 5], [N, N])
print(
    json.dumps(
        {
            "centre": [LAT, LON],
            "line": [[lon[0], lat[0]], [lon[1], lat[1]]],
            "ortho": str(out / "road-ortho.tif"),
            "defects": str(out / "defects.geojson"),
        }
    )
)
