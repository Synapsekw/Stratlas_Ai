"""Writes G3's synthetic aligned photo project (python/tests/products_synth.py) for photo-products.spec.ts.

Usage: python photo-fixture.py <project folder>. Prints the run id, the project origin, the GCP
target positions (metres east and north of the origin) and the photos' ground sample distance as
JSON. Synthetic data only: a fictional desert site, rendered with known cameras.
"""

import json
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO / "python" / "tests"))

import products_synth as ps  # noqa: E402

root = Path(sys.argv[1])
ps.write_project(root, ps.make_scene(step=0.03))
print(json.dumps({"run": ps.RUN, "origin": list(ps.ORIGIN), "targets": ps.TARGETS, "gsd": ps.GSD}))
