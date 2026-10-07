"""photo/gcp.py: GCP files, ODM gcp_list.txt, gcp.json checks, predictions and outliers."""

import json

import numpy as np
import pytest

from aio_pipelines.photo import gcp as G
from aio_pipelines.photo.model import Camera, Image, SparseModel
from aio_pipelines.runtime import JobError


def test_a_csv_with_header_roles_and_accuracies():
    text = (
        "id,easting,northing,height,role,acc_h,acc_v\n"
        "G1,545100.10,2778900.20,12.30,control,0.01,0.02\n"
        "C1,545150.00,2778950.00,13.00,check,0.015,0.025\n"
    )
    f = G.parse_gcp_text(text, "points.csv", epsg=32639)
    assert f["schema"] == "aio.gcp/1" and f["crs"] == {"epsg": 32639} and f["importedFrom"] == "points.csv"
    g1, c1 = f["points"]
    assert g1["xyz"] == [545100.10, 2778900.20, 12.30] and g1["role"] == "control"
    assert g1["accuracy"] == {"horizontalM": 0.01, "verticalM": 0.02}
    assert c1["role"] == "check" and c1["accuracy"]["verticalM"] == 0.025


def test_a_headerless_txt_and_geographic_order():
    f = G.parse_gcp_text("A 25.1 51.4 10\nB 25.2 51.5 11 check\n", "gcp.txt", epsg=4326)
    a, b = f["points"]
    assert a["xyz"] == [51.4, 25.1, 10.0]  # longitude first inside Stratlas
    assert b["role"] == "check" and a["accuracy"] == G.DEFAULT_ACCURACY


def test_odm_gcp_list_with_marks():
    text = (
        "WGS84 UTM 39N\n"
        "545100.1 2778900.2 12.3 1012.5 744.0 DJI_0001.JPG G1\n"
        "545100.1 2778900.2 12.3 400.0 300.5 DJI_0002.JPG G1\n"
        "545150.0 2778950.0 13.0 10.0 20.0 DJI_0002.JPG G2\n"
    )
    f = G.parse_gcp_text(text, "gcp_list.txt")
    assert f["crs"] == {"epsg": 32639}
    g1 = f["points"][0]
    assert g1["id"] == "G1" and len(g1["marks"]) == 2
    assert g1["marks"][0]["px"] == [1012.5, 744.0] and g1["marks"][0]["state"] == "confirmed"
    assert g1["marks"][0]["by"] == "import"


@pytest.mark.parametrize(
    ("text", "kw", "match"),
    [
        ("", {"epsg": 32639}, "no points"),
        ("G1,1,2,3\n", {}, "coordinate system"),
        ("G1,1,x,3\n", {"epsg": 32639}, "not a number"),
        ("G1,1,2,3\nG1,4,5,6\n", {"epsg": 32639}, "twice"),
        ("G1,1,2\n", {"epsg": 32639}, "three coordinates"),
        ("EPSG:32639\n1 2 3 4 5 a.jpg G1\n9 9 9 4 5 b.jpg G1\n", {}, "two different positions"),
    ],
)
def test_bad_gcp_files_are_refused_with_the_line(text, kw, match):
    with pytest.raises(JobError, match=match):
        G.parse_gcp_text(text, "f.csv", **kw)


def test_gcp_json_is_checked(tmp_path):
    good = {
        "schema": "aio.gcp/1",
        "crs": {"epsg": 32639},
        "points": [
            {
                "id": "G1",
                "role": "control",
                "xyz": [1, 2, 3],
                "accuracy": {"horizontalM": 0.01, "verticalM": 0.02},
                "marks": [
                    {
                        "photo": "a.jpg",
                        "px": [1, 2],
                        "by": "person",
                        "at": "2026-10-07T00:00:00Z",
                        "state": "draft",
                    }
                ],
                "futureKey": True,
            }
        ],
    }
    p = tmp_path / "gcp.json"
    p.write_text(json.dumps(good))
    assert G.read_gcp_file(p)["points"][0]["futureKey"] is True
    assert G.usable_marks(good["points"][0]) == []  # a draft is not a measurement
    for bad in (
        {**good, "schema": "x"},
        {**good, "points": [{**good["points"][0], "role": "maybe"}]},
        {**good, "points": [{**good["points"][0], "accuracy": {"horizontalM": 0, "verticalM": 1}}]},
        {**good, "points": [good["points"][0], good["points"][0]]},
    ):
        p.write_text(json.dumps(bad))
        with pytest.raises(JobError):
            G.read_gcp_file(p)


def test_predictions_fall_inside_the_photos_that_see_the_point():
    m = SparseModel()
    m.cameras[1] = Camera(1, "SIMPLE_PINHOLE", 800, 600, [700, 400, 300])
    down = np.array([[1.0, 0, 0], [0, -1.0, 0], [0, 0, -1.0]])
    m.images[1] = Image(1, "a.jpg", 1, down, -down @ np.array([0, 0, 50.0]))
    m.images[2] = Image(2, "b.jpg", 1, down, -down @ np.array([500, 0, 50.0]))
    pred = G.predict_marks(m, {"G1": np.array([0.0, 0.0, 0.0])}, sigma_m=0.5)
    assert [p["photo"] for p in pred["G1"]] == ["a.jpg"]
    assert pred["G1"][0]["px"] == [400.0, 300.0]
    assert pred["G1"][0]["radiusPx"] == pytest.approx(700 * 0.5 / 50 * 3 + 8, abs=0.1)


def test_the_one_control_point_that_disagrees_is_named():
    rng = np.random.default_rng(3)
    surveyed = {f"G{i}": rng.uniform(-100, 100, 3) * [1, 1, 0.05] for i in range(1, 7)}
    measured = {k: v + rng.normal(0, 0.01, 3) for k, v in surveyed.items()}
    measured["G6"] = measured["G6"] + [0.6, -0.8, 0.0]
    sigma = {k: (0.01, 0.02) for k in surveyed}
    out = G.control_outliers(measured, surveyed, sigma)
    assert [o.id for o in out] == ["G6"] and out[0].distance_m == pytest.approx(1.0, abs=0.1)
    clean = {k: v for k, v in measured.items() if k != "G6"}
    assert G.control_outliers(clean, surveyed, sigma) == []
