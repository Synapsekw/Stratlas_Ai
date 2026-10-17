"""Write the small ``rf.coverage`` run folder the desktop tests read (Python to TypeScript hand-off).

    cd python && uv run python scripts/rf_desktop_fixture.py

Runs the real job on a synthetic two-sector site (``tests/rf/rf_synth.py``, no real site data) with a
21 x 21 pixel grid and copies the run folder to ``apps/desktop/src/main/rf/__fixtures__/py-run/``.
It prints the pixel values that ``apps/desktop/src/main/rf/pyRun.test.ts`` checks; copy them into
the test when the engine changes on purpose.
"""

from __future__ import annotations

import json
import shutil
import sys
import tempfile
import threading
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "tests" / "rf"))

import rf_synth as S  # noqa: E402

from aio_pipelines.rf.pipeline import RfCoverage  # noqa: E402
from aio_pipelines.runtime import Job  # noqa: E402

RUN_ID = "rf-py-fixture"
OUT = HERE.parents[1] / "apps" / "desktop" / "src" / "main" / "rf" / "__fixtures__" / "py-run"
#: (row, col) pixels whose values the desktop test checks
PIXELS = ((10, 10), (4, 10), (16, 10), (10, 3), (0, 0))


def main() -> int:
    with tempfile.TemporaryDirectory() as tmp:
        units = [S.unit(0, 0.0), S.unit(1, 180.0)]
        root = S.write_site(Path(tmp) / "proj", units=units, study={"radiusM": 250, "gridResolutionM": 25})
        Job("j-fixture", RfCoverage(), root, {"runId": RUN_ID}, lambda m, p: None, threading.Event()).run()
        src = root / "rf" / "runs" / RUN_ID
        if OUT.exists():
            shutil.rmtree(OUT)
        shutil.copytree(src, OUT)
    run = json.loads((OUT / "run.json").read_text("utf-8"))
    g = run["grid"]
    print(f"grid {g['width']} x {g['height']} origin {g['origin']} crs {g['crs']} nodata {g['nodata']}")
    import rasterio

    grids = {}
    for name in ("rsrp", "bestServer", "overlap"):
        with rasterio.open(OUT / run["outputs"][name]) as ds:
            grids[name] = ds.read(1)
    for r, c in PIXELS:
        vals = ", ".join(f"{n} {float(grids[n][r, c]):.4f}" for n in grids)
        print(f"pixel row {r} col {c}: {vals}")
    best = grids["bestServer"][grids["bestServer"] != g["nodata"]]
    print(f"best server values {sorted(set(np.unique(best).astype(int).tolist()))}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
