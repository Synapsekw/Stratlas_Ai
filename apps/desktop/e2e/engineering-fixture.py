"""Synthetic inputs for engineering-flow.spec.ts (no client data).

    python engineering-fixture.py <project folder> <photo folder>

Writes a partial, noisy synthetic chimney cloud (the south quarter missing) as
`<project>/clouds/scan.las` in the project's frame (EPSG:32633, origin 500000 3200000 10, the
same as the Python tests' `make_project`), coloured with its paint bands, and one ordinary photo
of a synthetic chimney as `<photo folder>/synth_01.jpg`. Prints the cloud's truth as JSON.
"""

import json
import sys
from pathlib import Path

import numpy as np

TESTS = Path(__file__).resolve().parents[3] / "python" / "tests"
sys.path.insert(0, str(TESTS))

from synth_assets import stack_cloud, synth_photos, write_las

project = Path(sys.argv[1])
photos = Path(sys.argv[2])
ORIGIN = (500000.0, 3200000.0, 10.0)

cloud, truth = stack_cloud(seed=7, partial=True, noise=0.03, points=40_000)
rgb = np.tile(np.array([150, 148, 140], dtype=np.uint8), (len(cloud), 1))
rgb[(cloud[:, 1] >= 100) & (cloud[:, 1] < 104)] = [190, 40, 35]
(project / "clouds").mkdir(parents=True, exist_ok=True)
write_las(cloud, project / "clouds" / "scan.las", offset=ORIGIN, rgb=rgb)
synth_photos(photos, n=1, seed=4)
print(json.dumps(truth))
