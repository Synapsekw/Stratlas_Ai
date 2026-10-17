"""``rf.coverage``: the run folder of a synthetic three-sector site (spec D12 to D18).

Expected class areas come from an independent scalar reference: the stdlib propagation generator
(``gen_propagation.py``, which produced the golden vectors) and a plain per-pixel antenna-frame
rotation, evaluated pixel by pixel. The job itself is vectorised numpy.
"""

from __future__ import annotations

import importlib.util
import json
import math
import threading
import time
from pathlib import Path

import numpy as np
import pytest

import rf_synth as S
from aio_pipelines.pipelines import all_pipelines
from aio_pipelines.rf import pipeline as rf_pipeline
from aio_pipelines.rf import propagation
from aio_pipelines.rf.pipeline import RfCoverage
from aio_pipelines.runtime import Cancelled, JobError
from conftest import run_job

GOLDEN = Path(__file__).resolve().parents[2] / "packages" / "rf" / "fixtures" / "golden"


def _gen_propagation():
    spec = importlib.util.spec_from_file_location("gen_propagation_ref", GOLDEN / "gen_propagation.py")
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


REF = _gen_propagation()


def read_run(root: Path, run_id: str) -> dict:
    return json.loads((root / "rf" / "runs" / run_id / "run.json").read_text("utf-8"))


def read_grid(root: Path, run: dict, name: str) -> np.ndarray:
    """A run grid the way the app reads it (apps/desktop/src/main/rf.ts ``loadGrid``)."""
    import rasterio

    path = root / "rf" / "runs" / run["runId"] / run["outputs"][name]
    g = run["grid"]
    if path.suffix == ".tif":
        with rasterio.open(path) as ds:
            assert ds.count == 1 and (ds.width, ds.height) == (g["width"], g["height"])
            assert ds.compression is None  # the app reads uncompressed TIFFs only
            assert not ds.profile.get("tiled", False)
            return ds.read(1).astype(np.float64)
    data = np.fromfile(path, dtype="<f4")
    assert data.size == g["width"] * g["height"]
    return data.reshape(g["height"], g["width"]).astype(np.float64)


def classic_tiff(path: Path) -> bool:
    head = path.read_bytes()[:4]
    return head in (b"II*\x00", b"MM\x00*")


def run(root: Path, run_id: str = "rf-synth", **params):
    return run_job(RfCoverage(), root, {"runId": run_id, **params}, job_id=f"j-{run_id}")


# ---------------------------------------------------------------------------- scalar reference


def ref_angles(de, dn, du, az_grid, mech):
    """Grid offset into the antenna frame (geometry.ts): the convergence cancels on a grid offset."""
    n = math.sqrt(de * de + dn * dn + du * du)
    e, nn, u = de / n, dn / n, du / n
    sa, ca = math.sin(math.radians(az_grid)), math.cos(math.radians(az_grid))
    f = e * sa + nn * ca
    r = e * ca - nn * sa
    st, ct = math.sin(math.radians(mech)), math.cos(math.radians(mech))
    fwd = f * ct - u * st
    up = f * st + u * ct
    return math.degrees(math.atan2(r, fwd)), -math.degrees(math.atan2(up, math.hypot(fwd, r)))


def job_classes(root: Path, run: dict) -> dict[str, int]:
    rsrp = read_grid(root, run, "rsrp")
    th = run["inputs"]["sectors"]["study"]["thresholds"]
    v = rsrp[rsrp != run["grid"]["nodata"]]
    return {
        "excellent": int(np.sum(v >= th["excellentDbm"])),
        "good": int(np.sum((v >= th["goodDbm"]) & (v < th["excellentDbm"]))),
        "fair": int(np.sum((v >= th["fairDbm"]) & (v < th["goodDbm"]))),
        "poor": int(np.sum((v >= th["poorDbm"]) & (v < th["fairDbm"]))),
        "none": int(np.sum(v < th["poorDbm"])),
    }


def ref_classes(run: dict) -> dict[str, int]:
    g = run["grid"]
    study = run["inputs"]["sectors"]["study"]
    th = study["thresholds"]
    ue = study["ueHeightM"]
    port = S.ANTENNA["ports"][0]
    margin = 0 + study["bodyLossDb"] + 1.2815515655446004 * study["shadowSigmaDb"]
    per_re = 10 * math.log10(12 * 100)
    const = S.POWER_DBM - per_re - S.FEEDER_DB + port["gainDbi"] - margin
    units = run["inputs"]["antennas"]
    counts = {"excellent": 0, "good": 0, "fair": 0, "poor": 0, "none": 0}
    res, (oe, on) = g["resolutionM"], g["origin"]
    for row in range(g["height"]):
        n = on - (row + 0.5) * res
        for col in range(g["width"]):
            e = oe + (col + 0.5) * res
            best = -math.inf
            for u in units:
                de, dn = e - u["centre"][0], n - u["centre"][1]
                d2 = math.hypot(de, dn)
                if d2 > g["radiusM"]:
                    continue
                # the generator clamps the UE inside the model; the angle takes the study UE as set
                pl = REF.tr38901("uma", 1842.5, d2, S.HEIGHT_M, ue)[3]
                az, down = ref_angles(de, dn, ue - S.HEIGHT_M, u["azimuthGridDeg"], u["downtiltDeg"])
                ah = min(12 * (az / port["hBeamwidthDeg"]) ** 2, port["frontToBackDb"])
                av = min(12 * ((down - S.ETILT) / port["vBeamwidthDeg"]) ** 2, 30)
                best = max(best, const - min(ah + av, port["frontToBackDb"]) - pl)
            if best == -math.inf:
                continue
            for name, key in (
                ("excellent", "excellentDbm"),
                ("good", "goodDbm"),
                ("fair", "fairDbm"),
                ("poor", "poorDbm"),
            ):
                if best >= th[key]:
                    counts[name] += 1
                    break
            else:
                counts["none"] += 1
    return counts


# ---------------------------------------------------------------------------- tests


def test_the_pack_lists_rf_coverage():
    p = all_pipelines()["rf.coverage"]
    assert isinstance(p, RfCoverage)
    assert p.title == "Predicting coverage"


def test_params_follow_rf_coverage_params():
    p = RfCoverage()
    assert p.validate({"runId": "rf-a1"}) == {"runId": "rf-a1"}
    for bad in (
        {},
        {"runId": "run-1"},
        {"runId": "rf-a", "bogus": 1},
        {"runId": "rf-a", "sectorIds": []},
        {"runId": "rf-a", "sectorIds": ["s1"]},
        {"runId": "rf-a", "includeUnreviewed": "yes"},
        {"runId": "rf-a", "reusePathLoss": 1},
    ):
        with pytest.raises(JobError):
            p.validate(bad)


def test_three_sector_site_matches_the_reference_class_areas(tmp_path):
    root = S.write_site(tmp_path)
    result, rec = run(root)
    assert result["status"] == "done"
    r = read_run(root, "rf-synth")

    assert r["schema"] == "aio.rf-run/1"
    assert r["runId"] == "rf-synth" and r["status"] == "done"
    assert r["model"] == {"model": "tr38901", "environment": "uma"}
    assert r["usedUnreviewed"] is False
    assert r["inputs"]["sectors"]["schema"] == "aio.rf-sectors/1"
    assert [a["id"] for a in r["inputs"]["antennas"]] == ["ant-s1", "ant-s2", "ant-s3"]
    a0 = r["inputs"]["antennas"][0]
    assert a0["heightM"] == pytest.approx(S.HEIGHT_M)
    assert a0["groundZ"] == S.GROUND_Z and a0["convergenceDeg"] == S.CONVERGENCE
    assert {(c["id"], c["kind"]) for c in r["catalogue"]} == {
        ("generic-panel-65-17", "antenna"),
        ("generic-rru-2x40w", "radio"),
    }
    assert r["patterns"] == [{"antennaId": f"ant-s{k}", "source": "generic"} for k in (1, 2, 3)]
    assert r["timings"]["totalMs"] >= 0

    g = r["grid"]
    assert g["crs"] == "EPSG:32640" and g["resolutionM"] == 25 and g["radiusM"] == 1500
    assert g["width"] == g["height"] == 121  # snapped to the resolution, the site inside
    assert g["origin"][0] % 25 == 0 and g["origin"][1] % 25 == 0
    assert math.isfinite(g["nodata"])

    out = root / "rf" / "runs" / "rf-synth"
    for name in ("rsrp", "bestServer", "overlap"):
        assert classic_tiff(out / r["outputs"][name])
    assert r["outputs"]["pathLossDir"].startswith(("pathloss", "path-loss"))
    index = json.loads((out / r["outputs"]["pathLossDir"] / "index.json").read_text("utf-8"))
    assert len(index["grids"]) == 3
    for item in index["grids"]:
        pl = np.fromfile(out / r["outputs"]["pathLossDir"] / item["file"], dtype="<f4")
        assert pl.size == g["width"] * g["height"]

    rsrp = read_grid(root, r, "rsrp")
    best = read_grid(root, r, "bestServer")
    overlap = read_grid(root, r, "overlap")
    valid = rsrp != g["nodata"]
    assert np.all(np.isfinite(rsrp))
    # best server is the 0-based index into run.inputs.sectors.sectors; overlap counts the best
    assert set(np.unique(best[valid]).astype(int)) == {0, 1, 2}
    assert np.all(best[~valid] == g["nodata"])
    assert np.all(overlap[valid] >= 1) and np.all(overlap[valid] <= 3)
    assert np.all(overlap[~valid] == 0)

    # Exact, pixel for pixel per class. Float32 storage could in principle move a pixel lying
    # within about 1e-5 dB of a class floor; none does on this site, so no tolerance is allowed.
    got, want = job_classes(root, r), ref_classes(r)
    assert got == want
    # 43 dBm over 20 MHz with a 13.3 dB margin: no excellent pixels, every other class present
    assert got["good"] > 0 and got["fair"] > 0 and got["poor"] > 0 and got["none"] > 0
    assert result["outputs"]["predict"]["classAreasM2"]["good"] == got["good"] * 25 * 25

    # three sectors 120 degrees apart serve about a third each
    shares = [np.sum(best[valid] == s) / valid.sum() for s in range(3)]
    assert all(abs(s - 1 / 3) < 0.03 for s in shares)

    plan = rec.of("progress")[0]
    assert plan["state"] == "plan"
    assert any(p.get("state") == "running" for p in rec.of("progress"))
    assert any(a["path"] == "rf/runs/rf-synth" for a in rec.of("artifact"))


def test_a_rerun_with_reuse_takes_the_cached_path_loss(tmp_path):
    root = S.write_site(tmp_path)
    run(root, "rf-first")
    calls = []
    real = propagation.path_loss_db

    def counting(*a, **kw):
        calls.append(1)
        return real(*a, **kw)

    rf_pipeline.propagation.path_loss_db = counting
    try:
        run(root, "rf-second", reusePathLoss=True)
    finally:
        rf_pipeline.propagation.path_loss_db = real
    assert calls == []
    a = read_grid(root, read_run(root, "rf-first"), "rsrp")
    b = read_grid(root, read_run(root, "rf-second"), "rsrp")
    assert np.array_equal(a, b)


def test_cancel_mid_run_leaves_no_partial_run_folder(tmp_path, monkeypatch):
    root = S.write_site(tmp_path)
    cancel = threading.Event()
    real = propagation.path_loss_db
    seen = []

    def cancel_after_first(*a, **kw):
        seen.append(1)
        out = real(*a, **kw)
        cancel.set()  # the next check raises, half way through the sectors
        return out

    monkeypatch.setattr(rf_pipeline.propagation, "path_loss_db", cancel_after_first)
    with pytest.raises(Cancelled):
        run_job(RfCoverage(), root, {"runId": "rf-cut"}, job_id="j-cut", cancel=cancel)
    assert seen == [1]
    runs = root / "rf" / "runs"
    assert not (runs / "rf-cut").exists()
    assert not list(runs.rglob("run.json")) if runs.exists() else True

    # a resume (same job id) finishes it
    monkeypatch.setattr(rf_pipeline.propagation, "path_loss_db", real)
    result, _ = run_job(RfCoverage(), root, {"runId": "rf-cut"}, job_id="j-cut")
    assert result["status"] == "done"
    assert (runs / "rf-cut" / "run.json").exists()


def test_cancel_during_the_commit_leaves_no_run_json(tmp_path, monkeypatch):
    root = S.write_site(tmp_path)
    cancel = threading.Event()
    real = rf_pipeline.write_grid

    def cancel_on_last_grid(path, *a, **kw):
        real(path, *a, **kw)
        if Path(path).name.startswith("overlap"):
            cancel.set()

    monkeypatch.setattr(rf_pipeline, "write_grid", cancel_on_last_grid)
    with pytest.raises(Cancelled):
        run_job(RfCoverage(), root, {"runId": "rf-late"}, job_id="j-late", cancel=cancel)
    assert not (root / "rf" / "runs" / "rf-late").exists()


def test_refuses_a_run_id_that_exists(tmp_path):
    root = S.write_site(tmp_path)
    run(root, "rf-dup")
    with pytest.raises(JobError, match="already"):
        run_job(RfCoverage(), root, {"runId": "rf-dup"}, job_id="j-dup-2")


def test_refuses_without_a_crs(tmp_path):
    units = [S.unit(k, az, convergenceDeg=None) for k, az in enumerate(S.AZIMUTHS)]
    root = S.write_site(tmp_path, units=units)
    with pytest.raises(JobError, match="CRS"):
        run(root)


def test_refuses_when_no_unit_is_eligible_and_says_why(tmp_path):
    units = [S.unit(k, az, status="draft") for k, az in enumerate(S.AZIMUTHS)]
    root = S.write_site(tmp_path, units=units)
    with pytest.raises(JobError, match="accepted"):
        run(root)


def test_draft_units_take_part_when_included_and_the_run_says_so(tmp_path):
    units = [S.unit(k, az, status="draft" if k == 0 else "accepted") for k, az in enumerate(S.AZIMUTHS)]
    root = S.write_site(tmp_path, units=units)
    run(root, "rf-draft", includeUnreviewed=True)
    r = read_run(root, "rf-draft")
    assert r["usedUnreviewed"] is True
    assert len(r["inputs"]["antennas"]) == 3


def test_sector_subset_keeps_best_server_indices_into_the_sectors_file(tmp_path):
    root = S.write_site(tmp_path)
    run(root, "rf-two", sectorIds=["sec-s2", "sec-s3"])
    r = read_run(root, "rf-two")
    best = read_grid(root, r, "bestServer")
    valid = best != r["grid"]["nodata"]
    assert set(np.unique(best[valid]).astype(int)) == {1, 2}
    assert [a["id"] for a in r["inputs"]["antennas"]] == ["ant-s2", "ant-s3"]


def test_height_falls_back_to_the_override_and_warns_without_ground(tmp_path):
    ids = [f"ant-s{k + 1}" for k in range(3)]
    antennas = [S.settings(i, heightOverrideM=30.0) if i == "ant-s1" else S.settings(i) for i in ids]
    root = S.write_site(tmp_path, antennas=antennas, ground_z=None)
    run(root, "rf-h")
    r = read_run(root, "rf-h")
    heights = {a["id"]: a.get("heightM") for a in r["inputs"]["antennas"]}
    assert heights == {"ant-s1": 30.0}
    assert any("ant-s2" in w and "height" in w for w in r["warnings"])


def test_low_ue_is_clamped_in_path_loss_only_as_the_preview_does(tmp_path):
    """preview.ts takes the study UE (0.5 m) for the pattern angle; 38.901 clamps it to 1.5 m
    inside the path loss. The scalar reference does the same and must match exactly."""
    root = S.write_site(tmp_path, study={"ueHeightM": 0.5})
    run(root, "rf-ue")
    r = read_run(root, "rf-ue")
    assert any("1.5 m used" in w for w in r["warnings"])
    assert job_classes(root, r) == ref_classes(r)


def test_a_model_out_of_its_band_is_refused_with_the_range(tmp_path):
    root = S.write_site(tmp_path, study={"model": "okumura-hata"})
    with pytest.raises(JobError, match="150 to 1500 MHz"):
        run(root)


def test_carriers_without_power_take_the_radio_maximum_with_a_warning(tmp_path):
    ids = [f"ant-s{k + 1}" for k in range(3)]
    antennas = []
    for i in ids:
        s = S.settings(i)
        s["carriers"] = [{k: v for k, v in s["carriers"][0].items() if k != "powerDbmPerPort"}]
        antennas.append(s)
    root = S.write_site(tmp_path, antennas=antennas)
    run(root, "rf-max")
    r = read_run(root, "rf-max")
    assert any("46" in w and "maximum" in w for w in r["warnings"])
    a = read_grid(root, r, "rsrp")
    root2 = S.write_site(tmp_path / "b")
    run(root2, "rf-max")
    b = read_grid(root2, read_run(root2, "rf-max"), "rsrp")
    valid = a != r["grid"]["nodata"]
    assert np.allclose(a[valid] - b[valid], 3.0, atol=1e-3)  # 46 dBm instead of 43


def test_measured_msi_pattern_is_used_and_recorded(tmp_path):
    h = [min(12 * (min(k, 360 - k) / 65) ** 2, 28) for k in range(360)]
    v = [min(12 * ((k if k <= 180 else k - 360) - 4) ** 2 / 100, 28) for k in range(360)]
    lines = ["NAME Synthetic panel", "FREQUENCY 1842", "GAIN 14.85 dBd", "TILT 4", "HORIZONTAL 360"]
    lines += [f"{k} {h[k]:.3f}" for k in range(360)]
    lines += ["VERTICAL 360"] + [f"{k} {v[k]:.3f}" for k in range(360)]
    ant = json.loads(json.dumps(S.ANTENNA))
    ant["ports"][0]["patterns"] = [{"frequencyMhz": 1842, "etiltDeg": 4, "file": "patterns/synth-4.msi"}]
    root = S.write_site(tmp_path, catalogue=[ant, S.RADIO])
    (root / "rf" / "patterns").mkdir()
    (root / "rf" / "patterns" / "synth-4.msi").write_text("\n".join(lines) + "\n", "utf-8")
    run(root, "rf-msi")
    r = read_run(root, "rf-msi")
    assert {p["source"] for p in r["patterns"]} == {"msi"}
    # the synthetic file is the parametric pattern sampled per degree: nearly the same map
    root2 = S.write_site(tmp_path / "b")
    run(root2, "rf-gen")
    a = read_grid(root, r, "rsrp")
    b = read_grid(root2, read_run(root2, "rf-gen"), "rsrp")
    valid = a != r["grid"]["nodata"]
    assert np.median(np.abs(a[valid] - b[valid])) < 0.2


def test_ten_km_grid_at_thirty_metres_runs_quickly(tmp_path):
    root = S.write_site(tmp_path, study={"radiusM": 5000, "gridResolutionM": 30})
    t0 = time.perf_counter()
    run(root, "rf-big")
    elapsed = time.perf_counter() - t0
    r = read_run(root, "rf-big")
    assert r["grid"]["width"] >= 333
    print(f"10 x 10 km at 30 m, 3 sectors: {elapsed:.2f} s ({r['grid']['width']} x {r['grid']['height']})")
    assert elapsed < 20


def test_a_non_dict_user_field_leaves_the_unit_out_with_a_warning(tmp_path):
    units = [S.unit(k, az) for k, az in enumerate(S.AZIMUTHS)]
    units[1]["user"] = "inactive"
    root = S.write_site(tmp_path, units=units)
    run(root, "rf-user")
    r = read_run(root, "rf-user")
    assert [a["id"] for a in r["inputs"]["antennas"]] == ["ant-s1", "ant-s3"]
    assert any("ant-s2" in w and "user field" in w for w in r["warnings"])


def test_a_short_band_range_leaves_the_port_out_with_a_warning(tmp_path):
    good = json.loads(json.dumps(S.ANTENNA))
    bad = json.loads(json.dumps(S.ANTENNA))
    bad["id"] = "generic-panel-broken"
    bad["ports"][0]["bandRangeMhz"] = [698]
    ids = [f"ant-s{k + 1}" for k in range(3)]
    antennas = [S.settings(i) for i in ids]
    antennas[2]["equipment"] = {"kind": "separate", "antenna": bad["id"], "radio": S.RADIO["id"]}
    root = S.write_site(tmp_path, antennas=antennas, catalogue=[good, bad, S.RADIO])
    run(root, "rf-band")
    r = read_run(root, "rf-band")
    assert [a["id"] for a in r["inputs"]["antennas"]] == ["ant-s1", "ant-s2"]
    assert any("ant-s3" in w and "band range" in w for w in r["warnings"])


def test_a_newer_antenna_file_is_refused_before_it_is_read(tmp_path):
    root = S.write_site(tmp_path, antennas_version=2)
    with pytest.raises(JobError, match="newer version of the antenna detection"):
        run(root)
    assert not (root / "rf" / "runs").exists()


def test_an_unreadable_sector_entry_keeps_best_server_indices_on_the_file_list(tmp_path):
    root = S.write_site(tmp_path)
    path = root / "rf" / "sectors.json"
    doc = json.loads(path.read_text("utf-8"))
    doc["sectors"].insert(0, "not a sector")
    path.write_text(json.dumps(doc), "utf-8")
    run(root, "rf-idx")
    r = read_run(root, "rf-idx")
    best = read_grid(root, r, "bestServer")
    valid = best != r["grid"]["nodata"]
    # indices into run.inputs.sectors.sectors, which keeps the unreadable entry at 0
    assert r["inputs"]["sectors"]["sectors"][0] == "not a sector"
    assert set(np.unique(best[valid]).astype(int)) == {1, 2, 3}
