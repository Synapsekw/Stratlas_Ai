"""Writes the two cross-tool GeoTIFF fixtures used by export.test.ts.

Run from python/:  uv run python ../apps/desktop/src/main/rf/__fixtures__/make_rasterio_fixtures.py <out dir>

stripped.tif: 4 x 3 Float32, uncompressed, strips, EPSG:32640, nodata -9999, 10 m pixels, origin (500000, 2700000).
tiled.tif: 16 x 16 Float32 with 16 x 16 tiles (the reader must refuse it).
"""

import sys

import numpy as np
import rasterio
from rasterio.transform import from_origin

out = sys.argv[1]
data = np.array(
    [[-70.5, -80.25, -90, -100], [-110.125, -9999, -85, -95], [-105, -115, -75, -65.75]],
    dtype="float32",
)


def write(path, arr, **kw):
    h, w = arr.shape
    with rasterio.open(
        path, "w", driver="GTiff", height=h, width=w, count=1, dtype="float32",
        crs="EPSG:32640", transform=from_origin(500000, 2700000, 10, 10),
        nodata=-9999, compress="none", **kw,
    ) as d:
        d.write(arr, 1)


write(out + "/stripped.tif", data, tiled=False)
write(out + "/tiled.tif", np.arange(256, dtype="float32").reshape(16, 16) * -0.5 - 60,
      tiled=True, blockxsize=16, blockysize=16)
