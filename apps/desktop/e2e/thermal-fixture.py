"""Writes the synthetic photos of thermal-bench.spec.ts (thermalFixture.ts builds the project).

Usage: python thermal-fixture.py <photos folder>. Writes two FLIR radiometric JPEGs (``th1.jpg``,
``th2.jpg``) with a 3 x 3 hot patch at 85.0 °C on a 30.0 °C background, and their visual twin
(``vis1.jpg``, an ordinary JPEG of the same camera with no thermal record), with
``python/tests/thermal_fixtures.make_flir_jpeg``. The settings stored in each record are the design
defaults the decode uses for a photo with no height: emissivity 0.95, distance 10 m, air 25 °C,
humidity 50 %. Prints the image size, the patch and the temperatures as JSON. Synthetic data only.
"""

import json
import sys
from pathlib import Path

import numpy as np

REPO = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO / "python" / "tests"))

import thermal_fixtures as tf  # noqa: E402
from aio_pipelines.thermal.physics import ThermalSettingsPy  # noqa: E402

WIDTH, HEIGHT = 64, 48
BACKGROUND_C, HOT_C = 30.0, 85.0
#: The patch's top-left pixel; it is 3 x 3, so its centre pixel is (32, 24).
PATCH_X, PATCH_Y, PATCH = 31, 23, 3
SETTINGS = ThermalSettingsPy(
    emissivity=0.95, distance_m=10.0, air_c=25.0, humidity_pct=50.0, reflected_c=None
)

out = Path(sys.argv[1])
out.mkdir(parents=True, exist_ok=True)
temps = np.full((HEIGHT, WIDTH), BACKGROUND_C)
temps[PATCH_Y : PATCH_Y + PATCH, PATCH_X : PATCH_X + PATCH] = HOT_C
for name in ("th1.jpg", "th2.jpg"):
    tf.make_flir_jpeg(out / name, temps, settings=SETTINGS)
(out / "vis1.jpg").write_bytes(tf.plain_jpeg(WIDTH * 2, HEIGHT * 2, "FLIR", "XT2"))
print(
    json.dumps(
        {
            "width": WIDTH,
            "height": HEIGHT,
            "patch": {"x": PATCH_X, "y": PATCH_Y, "size": PATCH},
            "hotC": HOT_C,
            "backgroundC": BACKGROUND_C,
        }
    )
)
