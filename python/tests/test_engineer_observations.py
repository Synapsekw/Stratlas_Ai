"""The local measurement contract and its explicit source frame."""

import json
import re
from pathlib import Path

import pytest

from aio_pipelines.engineer.observations import ALGORITHM, Observation, measurement_frame
from aio_pipelines.engineer.pipeline import ModelEvidence


def test_app_cache_and_processing_use_the_same_measurement_algorithm():
    source = Path(__file__).parents[2] / "packages/schema/src/modelEvidence.ts"
    match = re.search(r"ENGINEER_MEASUREMENT_ALGORITHM\s*=\s*'([^']+)'", source.read_text("utf-8"))
    assert match is not None
    assert match[1] == ALGORITHM


def test_independent_dimensions_and_hidden_depth_roundtrip():
    measured = {"basis": "measured", "support": 450, "residualM": 0.012, "coverage": 0.8}
    q = {k: measured for k in ("centre", "width", "height", "azimuthDeg", "tiltDeg")}
    q["depth"] = {"basis": "inferred", "note": "Rear face hidden"}
    o = Observation(
        "obs-panel-a",
        "panel",
        (1.2, 28.3, -0.4),
        (0.51, 2.62, 0.19),
        132,
        2,
        q,
        [{"kind": "drawing", "ref": "drawing-1:ABCD"}],
    )
    d = json.loads(json.dumps(o.to_dict(), allow_nan=False))
    assert d["size"] == [0.51, 2.62, 0.19]
    assert d["azimuthDeg"] == 132
    assert d["quality"]["depth"]["basis"] == "inferred"


def test_frame_invalidation_and_offsets_are_recorded_without_changing_origin(tmp_path):
    m = {
        "origin": [265092, 2680453, 10],
        "crs": {"epsg": 32640},
        "layers": [
            {"id": "cloud", "kind": "pointcloud", "src": {"path": "scan.laz"}, "heightOffsetM": -32.542}
        ],
    }
    (tmp_path / "scan.laz").write_bytes(b"scan")
    params = {"clouds": [{"layer": "cloud"}], "meshes": [], "photos": []}
    a = measurement_frame(tmp_path, m, params)
    assert a["origin"] == [265092, 2680453, 10]
    assert a["sources"][0]["heightOffsetM"] == -32.542
    assert len(a["signature"]) == 64
    assert measurement_frame(tmp_path, m, params) == a
    m["layers"][0]["heightOffsetM"] = -30
    assert measurement_frame(tmp_path, m, params)["signature"] != a["signature"]
    m["layers"][0]["heightOffsetM"] = -32.542
    m["origin"][0] += 100
    assert measurement_frame(tmp_path, m, params)["signature"] != a["signature"]


def test_intake_keeps_full_inventory_and_invalidates_on_drawing_or_pose_changes(tmp_path):
    params = {
        "run": "run-test",
        "clouds": [{"layer": "cloud"}],
        "meshes": [],
        "photos": [{"path": f"photos/{i}.jpg"} for i in range(560)],
        "detail": "detailed",
        "drawings": [{"path": "site.dxf"}],
        "cameraPoses": {"path": "cameras.xml"},
    }
    job = ModelEvidence()
    p = job.validate(params)
    assert len(p["photos"]) == 560
    assert "site.dxf" in job.inputs(p, tmp_path)
    assert "cameras.xml" in job.inputs(p, tmp_path)
    with pytest.raises(Exception, match="drawings"):
        job.validate({**params, "drawings": [{"path": ""}]})
