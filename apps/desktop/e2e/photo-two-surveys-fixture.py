"""Writes the synthetic two-survey photo project (python/tests/two_surveys_synth.py) for photo-change.spec.ts.

Usage: python photo-two-surveys-fixture.py <project folder> [step]. Prints the runs per capture,
the project origin and the truth (what changed between the surveys, also in <folder>/truth.json)
as JSON. Synthetic data only: a fictional desert site surveyed twice, rendered with known cameras.
"""

import json
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO / "python" / "tests"))

import two_surveys_synth as ts  # noqa: E402

root = Path(sys.argv[1])
step = float(sys.argv[2]) if len(sys.argv) > 2 else 0.05
print(json.dumps(ts.write_project(root, step=step)))
