import json
import math
import threading

import numpy as np
import pytest

from aio_pipelines.runtime import Cancelled, Job, JobError
from aio_pipelines.volumetric.grid import resample_dsm
from aio_pipelines.volumetric.pipeline import VolumetricProcess
from conftest import run_job, write_dsm

X0, Y0, SIZE, RES = 500000.0, 3200000.0, 120.0, 0.1
PILES = {"A": (40.0, 80.0, 12.0), "B": (85.0, 35.0, 10.0)}  # east, north (m from the corner), radius


def surface(heights: dict[str, float], res=RES):
    """A gently sloping yard with cone stockpiles; heights per pile in metres."""
    n = round(SIZE / res)
    xs = (np.arange(n) + 0.5) * res
    ys = SIZE - (np.arange(n) + 0.5) * res  # row 0 is the north edge
    XX, YY = np.meshgrid(xs, ys)
    z = 10.0 + 0.01 * XX + 0.005 * YY
    for k, (cx, cy, r) in PILES.items():
        h = heights.get(k, 0.0)
        d = np.hypot(XX - cx, YY - cy)
        z = z + np.clip(h * (1 - d / r), 0, None)
    return z.astype(np.float32)


def config(tmp, epochs):
    grid = {"x0": X0, "y0": Y0, "x1": X0 + SIZE, "y1": Y0 + SIZE, "dsm_res": RES}
    eps = []
    for i, heights in enumerate(epochs, 1):
        p = write_dsm(tmp / f"surveys/e{i}_dsm.tif", surface(heights), X0, Y0 + SIZE, RES)
        eps.append(
            {
                "id": f"e{i}",
                "label": f"Survey {i}",
                "date": f"2026-01-0{i}",
                "dsm": str(p),
                "cp_rmse_z_m": 0.013,
            }
        )
    return {"grid": grid, "epochs": eps, "volume": {"deadband_m": 0.1}}


def cone(r, h):
    return math.pi * r * r * h / 3


def pile_at(piles, epoch, cx, cy):
    for p in piles:
        e = p["epochs"].get(epoch)
        if e and e["bbox"][0] < X0 + cx < e["bbox"][2] and e["bbox"][1] < Y0 + cy < e["bbox"][3]:
            return p
    raise AssertionError(f"no pile at {cx}, {cy}")


def test_resample_is_a_block_mean_on_the_grid(tmp_path):
    z = np.arange(40 * 40, dtype=np.float32).reshape(40, 40)
    z[0, 0] = np.nan
    src = write_dsm(tmp_path / "dsm.tif", z, 0.0, 4.0, 0.1)
    grid = {"x0": 0.0, "y0": 0.0, "x1": 4.0, "y1": 4.0, "dsm_res": 0.2}
    out = tmp_path / "dsm.npy"
    assert resample_dsm(src, grid, out) == (20, 20)
    a = np.load(out)
    assert a[0, 0] == pytest.approx(np.mean([1, 40, 41]))  # the no-data pixel is left out
    assert a[5, 7] == pytest.approx(np.mean(z[10:12, 14:16]))
    assert (tmp_path / "dsm.npy.progress").read_text() == "done"


def test_two_dates_give_piles_volumes_and_change(tmp_path, project):
    cfg = config(tmp_path, [{"A": 8.0, "B": 7.0}, {"A": 5.0, "B": 7.0}])
    result, rec = run_job(VolumetricProcess(), project, {"config": cfg})
    assert result["status"] == "done"
    doc = json.loads((project / "piles.json").read_text())
    assert len(doc["piles"]) == 2
    a = pile_at(doc["piles"], "e1", 40, 80)
    b = pile_at(doc["piles"], "e1", 85, 35)
    assert a["status"] == "matched" and b["status"] == "matched"
    # The kit's outline stops where the pile stands clear of the floor model, a little above the
    # true toe. Above that line a cone keeps its shape, so the plane base must give the analytic
    # volume of the cone above the measured toe; the default (harmonic) base sits close to it.
    for p, e, r, h in ((a, "e1", 12, 8.0), (a, "e2", 12, 5.0), (b, "e1", 10, 7.0)):
        m = p["epochs"][e]
        hm = m["height_m"]
        assert hm == pytest.approx(h, abs=1.0)
        assert m["vol"]["plane"]["net"] == pytest.approx(cone(r * hm / h, hm), rel=0.03)
        assert m["vol"]["tin"]["net"] == pytest.approx(m["vol"]["plane"]["net"], rel=0.15)
        assert m["vol"]["low"]["net"] >= m["vol"]["avg"]["net"]
    # surface-to-surface change does not depend on a base
    assert a["change"]["cut"] == pytest.approx(cone(12, 8) - cone(12, 5), rel=0.05)
    assert a["change"]["fill"] < 5
    assert abs(b["change"]["net"]) < 5
    assert doc["site_change"]["cut"] == pytest.approx(a["change"]["cut"], rel=0.05)
    assert doc["epochs"]["e1"] == {
        "id": "e1",
        "label": "Survey 1",
        "date": "2026-01-01",
        "cp_rmse_z_m": 0.013,
    }
    assert [m["path"] for m in rec.of("artifact")] == ["piles.json"]


def test_one_date_measures_without_change(tmp_path, project):
    cfg = config(tmp_path, [{"A": 8.0}])
    run_job(VolumetricProcess(), project, {"config": cfg, "out": "volumes/piles.json"})
    doc = json.loads((project / "volumes" / "piles.json").read_text())
    assert [p["status"] for p in doc["piles"]] == ["measured"]
    assert "change" not in doc["piles"][0] and "site_change" not in doc


def test_a_cancelled_resample_resumes_from_its_last_block(tmp_path, project):
    cfg = config(tmp_path, [{"A": 8.0}])
    ev = threading.Event()
    seen = []

    def emit(method, msg):
        if method == "progress" and msg["step"] == "resample-1" and msg["state"] == "running":
            seen.append(msg["stepFraction"])
            ev.set()

    with pytest.raises(Cancelled):
        Job("v1", VolumetricProcess(), project, {"config": cfg}, emit, ev).run()
    prog = project / "jobs" / "v1" / "staging" / "work" / "dsm_e1.npy.progress"
    assert prog.read_text() not in ("0", "done")
    assert not (project / "piles.json").exists()
    result, _ = run_job(VolumetricProcess(), project, {"config": cfg}, job_id="v1")
    assert result["status"] == "done" and (project / "piles.json").exists()


def test_job_file_paths_are_relative_to_the_job_file(tmp_path, project):
    cfg = config(project, [{"A": 8.0}])
    for e in cfg["epochs"]:
        e["dsm"] = "surveys/" + e["dsm"].replace("\\", "/").split("/surveys/")[1]
    (project / "job.json").write_text(json.dumps(cfg))
    result, _ = run_job(VolumetricProcess(), project, {})
    assert result["outputs"]["resample-2"] == {"skipped": True}
    assert len(json.loads((project / "piles.json").read_text())["piles"]) == 1


@pytest.mark.parametrize(
    ("cfg", "msg"),
    [
        ({"epochs": []}, "grid needs"),
        ({"grid": {"x0": 0, "y0": 0, "x1": 10, "y1": 10, "dsm_res": 0.1}, "epochs": []}, "one or two"),
        (
            {
                "grid": {"x0": 0, "y0": 0, "x1": 10, "y1": 10, "dsm_res": 0.1},
                "epochs": [{"id": "E 1", "dsm": "x"}],
            },
            "short",
        ),
    ],
)
def test_config_is_checked(cfg, msg):
    with pytest.raises(JobError, match=msg):
        VolumetricProcess().validate({"config": cfg})
