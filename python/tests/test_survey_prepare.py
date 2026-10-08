"""survey.prepare (M11 G2): DSMs, height grids, clouds, designs and derived surfaces to height tiles.

Synthetic surfaces only: the change pipelines' yard (``imagery_synth``), whose later date adds a
cone pile of 1000 m3 and digs a pit of 300 m3, and a small design pad.
"""

from __future__ import annotations

import json
import threading

import numpy as np
import pytest

from aio_pipelines.pipelines import all_pipelines
from aio_pipelines.runtime import Cancelled, Job, JobError
from aio_pipelines.survey.grid import TileSurface, decode_tile, encode_tile
from aio_pipelines.survey.tin import write_tin
from conftest import Recorder, run_job
from imagery_synth import EPSG, ORIGIN, surface_project


def pipeline():
    return all_pipelines()["survey.prepare"]


def dsm(sid, layer, capture):
    return {
        "id": sid,
        "name": f"DSM {capture}",
        "source": {"kind": "dsm", "layer": layer},
        "capture": capture,
    }


TWO = {"surfaces": [dsm("dsm-c1", "surf-a", "c1"), dsm("dsm-c2", "surf-b", "c2")]}


def meta(project, sid):
    return json.loads((project / "survey" / "surfaces" / sid / "tiles.json").read_text("utf-8"))


def test_two_dsms_become_height_tiles_with_the_raster_heights(tmp_path):
    import rasterio

    surface_project(tmp_path, pile=1000.0, pit=300.0)
    result, rec = run_job(pipeline(), tmp_path, TWO)
    assert result["outputs"]["commit"]["prepared"] == ["dsm-c1", "dsm-c2"]
    m = meta(tmp_path, "dsm-c2")
    assert m["schema"] == "aio.height-tiles/1" and m["tileSize"] == 256
    assert m["capture"] == "c2" and m["crs"] == {"epsg": EPSG} and m["cellM"] == pytest.approx(0.1)
    assert m["source"] == {"kind": "dsm", "layer": "surf-b"}
    assert m["cols"] == 3 and m["rows"] == 3 and m["levels"] == 3
    assert sorted(m["tiles"]) == sorted(f"{c}_{r}" for c in range(3) for r in range(3))
    assert m["fingerprint"].startswith("sha256:") and len(m["sourceSha256"]) == 64
    assert m["bounds"][0] == pytest.approx(ORIGIN[0] - 30) and m["bounds"][4] == pytest.approx(ORIGIN[1] + 30)
    s = TileSurface(tmp_path / "survey" / "surfaces" / "dsm-c2", m)
    with rasterio.open(tmp_path / "rasters" / "surf-b.tif") as ds:
        want = ds.read(1).astype(np.float64)[::-1]
    got = s.read(0, 0, 600, 600)
    assert np.allclose(got, want, atol=2e-6, rtol=0)
    # the display pyramid: level 1 holds the mean of 2 by 2 cells
    lv1 = decode_tile((tmp_path / "survey" / "surfaces" / "dsm-c2" / "1" / "0_0.bin").read_bytes())
    assert lv1[0, 0] == pytest.approx(want[:2, :2].mean(), abs=1e-5)
    assert (tmp_path / "survey" / "surfaces" / "dsm-c2" / "2" / "0_0.bin").is_file()
    # G1's site tables are not built here yet: skipped quietly
    assert result["outputs"]["geodesy"] == {"written": False}
    assert any(p["path"] == "survey/surfaces/dsm-c2/tiles.json" for p in rec.of("artifact"))


def test_heights_keep_a_tenth_of_a_millimetre_at_a_thousand_metres():
    rng = np.random.default_rng(3)
    h = 1000.0 + rng.uniform(-40, 40, (256, 256))
    h[5, 7] = np.nan
    back = decode_tile(encode_tile(h))
    ok = np.isfinite(h)
    assert np.array_equal(np.isfinite(back), ok)
    assert float(np.abs(back[ok] - h[ok]).max()) < 6e-5
    far = np.full((256, 256), 1000.0)
    far[0, 0] = 2000.0
    back = decode_tile(encode_tile(far))
    assert float(np.abs(back - far).max()) < 6e-5


def test_an_unchanged_source_is_not_prepared_again(tmp_path):
    surface_project(tmp_path)
    run_job(pipeline(), tmp_path, TWO)
    before = meta(tmp_path, "dsm-c1")
    result, _ = run_job(pipeline(), tmp_path, TWO, job_id="j2")
    assert result["outputs"]["surface-1"]["skipped"] is True
    assert result["outputs"]["commit"]["prepared"] == []
    assert meta(tmp_path, "dsm-c1") == before
    # another cell is another fingerprint
    result, _ = run_job(pipeline(), tmp_path, {**TWO, "cellM": 0.2}, job_id="j3")
    assert result["outputs"]["commit"]["prepared"] == ["dsm-c1", "dsm-c2"]
    assert meta(tmp_path, "dsm-c1")["cellM"] == pytest.approx(0.2)
    assert meta(tmp_path, "dsm-c1")["fingerprint"] != before["fingerprint"]


def test_a_cancelled_run_resumes_where_it_stopped(tmp_path):
    surface_project(tmp_path)
    cancel = threading.Event()
    rec = Recorder()

    def emit(method, params):
        rec(method, params)
        if method == "progress" and params.get("step") == "surface-2" and params.get("state") == "start":
            cancel.set()

    job = Job("j1", pipeline(), tmp_path, TWO, emit, cancel)
    with pytest.raises(Cancelled):
        job.run()
    assert not (tmp_path / "survey" / "surfaces").exists()
    result, rec2 = run_job(pipeline(), tmp_path, TWO)
    skipped = [p["step"] for p in rec2.of("progress") if p.get("state") == "skipped"]
    assert skipped == ["surface-1"]
    assert result["outputs"]["commit"]["prepared"] == ["dsm-c1", "dsm-c2"]


@pytest.mark.parametrize("kind", ["grid", "cloud"])
def test_height_grids_and_clouds_are_prepared(tmp_path, kind):
    surface_project(tmp_path, kinds=(kind, kind))
    src = "dsm" if kind == "grid" else "cloud"
    params = {"surfaces": [{"id": "s2", "name": "Later", "source": {"kind": src, "layer": "surf-b"}}]}
    run_job(pipeline(), tmp_path, params)
    m = meta(tmp_path, "s2")
    assert m["source"]["kind"] == src
    s = TileSurface(tmp_path / "survey" / "surfaces" / "s2", m)
    h = s.read(0, 0, s.nx, s.ny)
    # the pile's top (6 m above a yard about 1 m above the origin) is in the tiles
    assert 6.0 < float(np.nanmax(h)) < 9.5
    assert np.isfinite(h).sum() * m["cellM"] ** 2 > 0.9 * 60 * 60


def write_design(project, offset=0.0):
    e0, n0 = ORIGIN[0], ORIGIN[1]
    v = []
    for s, z in ((3.0, 4.0), (6.0, 2.0)):
        v += [[e0 - s, n0 - s, z], [e0 + s, n0 - s, z], [e0 + s, n0 + s, z], [e0 - s, n0 + s, z]]
    t = [[0, 1, 2], [0, 2, 3]]
    for k in range(4):
        a, b = k, (k + 1) % 4
        t += [[4 + a, 4 + b, b], [4 + a, b, a]]
    folder = project / "survey" / "designs" / "pad"
    folder.mkdir(parents=True, exist_ok=True)
    write_tin(folder / "top.tin", np.array(v), np.array(t), {"epsg": EPSG})
    (project / "survey" / "designs.json").write_text(
        json.dumps(
            {
                "schema": "aio.designs/1",
                "designs": [
                    {
                        "id": "pad",
                        "name": "Pad",
                        "src": "pad.xml",
                        "sha256": "0" * 64,
                        "bytes": 1,
                        "format": "landxml",
                        "units": "m",
                        "calibrated": False,
                        "importedAt": "2026-10-09T00:00:00Z",
                        "layers": [
                            {
                                "id": "top",
                                "name": "Top",
                                "kind": "surface",
                                "file": "top.tin",
                                "counts": {"triangles": len(t)},
                                "visible": True,
                                "archived": False,
                                "verticalOffsetM": offset,
                            }
                        ],
                    }
                ],
            }
        ),
        "utf-8",
    )


def test_a_design_tin_is_rasterised_with_its_offset(tmp_path):
    surface_project(tmp_path)
    write_design(tmp_path, offset=-0.25)
    params = {
        "surfaces": [
            {
                "id": "pad-top",
                "name": "Pad top",
                "source": {"kind": "design", "design": "pad", "layer": "top"},
            }
        ],
        "cellM": 0.5,
    }
    run_job(pipeline(), tmp_path, params)
    m = meta(tmp_path, "pad-top")
    s = TileSurface(tmp_path / "survey" / "surfaces" / "pad-top", m)
    h = s.read(0, 0, 24, 24)
    assert m["originE"] == pytest.approx(ORIGIN[0] - 6) and m["originN"] == pytest.approx(ORIGIN[1] - 6)
    assert h[12, 12] == pytest.approx(3.75)  # the top, offset applied
    assert h[0, 0] == pytest.approx(2.0 - 0.25 + 2.0 * (0.25 / 3), abs=1e-6)  # on the batter (float32 tiles)
    assert m["bounds"][2] == pytest.approx(1.75 + 2 * 0.25 / 3, abs=1e-6) and m["bounds"][5] == pytest.approx(
        3.75
    )


def test_a_derived_surface_applies_its_crop_and_cleanup(tmp_path):
    surface_project(tmp_path, pit=0)
    run_job(pipeline(), tmp_path, {"surfaces": [dsm("dsm-c2", "surf-b", "c2")]})
    e0, n0 = ORIGIN[0], ORIGIN[1]
    pile = [
        [e0 - 10 + 14 * np.cos(a), n0 + 8 + 14 * np.sin(a)]
        for a in np.linspace(0, 2 * np.pi, 24, endpoint=False)
    ]
    crop = [[e0 - 28, n0 - 28], [e0 + 28, n0 - 28], [e0 + 28, n0 + 28], [e0 - 28, n0 + 28]]
    (tmp_path / "survey" / "cleanups.json").write_text(
        json.dumps(
            {
                "schema": "aio.terrain-edits/1",
                "edits": [
                    {
                        "id": "e1",
                        "kind": "cleanup",
                        "surface": "dsm-c2",
                        "ring": pile,
                        "method": "tin",
                        "enabled": True,
                        "createdAt": "2026-10-09T00:00:00Z",
                    },
                    {
                        "id": "e2",
                        "kind": "crop",
                        "surface": "dsm-c2",
                        "ring": crop,
                        "enabled": True,
                        "createdAt": "2026-10-09T00:00:00Z",
                    },
                ],
            }
        ),
        "utf-8",
    )
    params = {
        "surfaces": [
            {
                "id": "c2-clean",
                "name": "Clean",
                "source": {"kind": "derived", "of": "dsm-c2", "edits": ["e1", "e2"]},
                "capture": "c2",
            }
        ]
    }
    run_job(pipeline(), tmp_path, params, job_id="j2")
    m = meta(tmp_path, "c2-clean")
    s = TileSurface(tmp_path / "survey" / "surfaces" / "c2-clean", m)
    h = s.read(0, 0, 600, 600)
    # the pile is gone (the yard is about a metre above the origin there) and the edge is cropped
    assert float(np.nanmax(h[300 - 8 * 10 - 50 : 300 - 8 * 10 + 50 + 160, 100 - 50 : 100 + 50])) < 2.0
    assert np.isnan(h[5, 5]) and np.isfinite(h[300, 300])
    assert m["bounds"][0] == pytest.approx(e0 - 28, abs=0.11)


@pytest.mark.parametrize(
    "params, message",
    [
        ({"surfaces": []}, "1 to 50 surfaces"),
        (
            {"surfaces": [{"id": "a b", "name": "x", "source": {"kind": "dsm", "layer": "l"}}]},
            "letters, digits",
        ),
        (
            {"surfaces": [{"id": "a", "name": "x", "source": {"kind": "mesh", "layer": "l"}}]},
            "kind must be one of",
        ),
        (
            {"surfaces": [{"id": "a", "name": "x", "source": {"kind": "design", "design": "d"}}]},
            "layer is required",
        ),
        ({**TWO, "cellM": 0}, "cellM must be between"),
        ({"surfaces": [dsm("a", "l", "c"), dsm("a", "l", "c")]}, "listed twice"),
    ],
)
def test_bad_parameters_are_refused(params, message):
    with pytest.raises(JobError, match=message):
        pipeline().validate(params)


def test_a_layer_that_is_not_a_dsm_is_refused(tmp_path):
    surface_project(tmp_path, kinds=("cloud", "cloud"))
    with pytest.raises(JobError, match="not a DSM or DTM raster"):
        run_job(pipeline(), tmp_path, {"surfaces": [dsm("x", "surf-a", "c1")]})
