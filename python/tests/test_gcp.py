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


# Four control points along two edges of a small block, three of them close to one line: what the
# marks of the synthetic mini flight put them at through its GNSS-only alignment by the real
# engine (no RTK: 22 m low, tilted by 3 degrees, 1.4 % small, heights bent by 0.2 m), against
# their survey. East, north, up in metres; every mark is on its target.
L_SURVEYED = {
    "GCP1": [-89.961, -69.756, -0.246],
    "GCP2": [52.116, -63.182, 0.305],
    "GCP3": [50.538, 76.878, -0.070],
    "GCP5": [-13.614, 35.055, -0.194],
}
L_MEASURED = {
    "GCP1": [-87.752, -69.398, -25.740],
    "GCP2": [52.099, -62.599, -17.690],
    "GCP3": [50.370, 75.498, -19.993],
    "GCP5": [-12.757, 34.113, -22.591],
}


def _before_control(rng, surveyed: np.ndarray, bend_m: float = 0.2) -> np.ndarray:
    """Accurately marked points as a model shows them before ground control: heights bent by a
    bowl (the lens is only self-calibrated) and noisy (few marks), then tilted, scaled and tens
    of metres low (GNSS without RTK)."""
    xy = surveyed[:, :2]
    ext = np.abs(xy).max()
    c = rng.normal(0, 0.3 * ext, 2)
    bowl = rng.normal(0, bend_m) * (((xy - c) ** 2).sum(axis=1) / ext**2 - 0.5)
    m = surveyed + np.column_stack([rng.normal(0, 0.02, (len(xy), 2)), bowl + rng.normal(0, 0.08, len(xy))])
    a, b = np.radians(rng.normal(0, 3.0, 2))
    rx = np.array([[1, 0, 0], [0, np.cos(a), -np.sin(a)], [0, np.sin(a), np.cos(a)]])
    ry = np.array([[np.cos(b), 0, np.sin(b)], [0, 1, 0], [-np.sin(b), 0, np.cos(b)]])
    return 0.986 * m @ (rx @ ry).T + np.array([1.5, -0.8, -25.0])


def _points(rng, xy, blunder=None, bend_m=0.2):
    xy = np.array(xy, dtype=np.float64)
    truth = np.column_stack([xy, 0.004 * xy[:, 0] - 0.0025 * xy[:, 1] + rng.normal(0, 0.5, len(xy))])
    ids = [f"G{k + 1}" for k in range(len(xy))]
    measured = dict(zip(ids, _before_control(rng, truth, bend_m), strict=True))
    stated = truth.copy()
    if blunder is not None:
        stated[0] += blunder  # the survey of G1 is wrong
    return measured, dict(zip(ids, stated, strict=True)), {i: (0.02, 0.03) for i in ids}


def test_an_accurate_point_far_from_the_others_is_kept():
    surveyed = {k: np.array(v) for k, v in L_SURVEYED.items()}
    measured = {k: np.array(v) for k, v in L_MEASURED.items()}
    sigma = {k: (0.02, 0.03) for k in surveyed}
    # the other three would put GCP2 2.3 m too high, but only because they are close to one line:
    # their heights say little about the ground 77 m beside them
    assert G.control_outliers(measured, surveyed, sigma) == []


@pytest.mark.parametrize(
    "xy",
    [
        [(-72, -75), (70, -68), (68, 72), (4, 30)],  # two edges of a block
        [(-70, -70), (70, -70), (70, 70), (-70, 70)],
        [(-70, -70), (70, -70), (70, 70), (-70, 70), (4, 30)],
        [(-200, -10), (-100, 12), (0, -8), (100, 10), (200, -12)],  # a corridor
        [(-70, -70), (70, -70), (70, 70), (-70, 70), (4, 30), (-50, 46), (40, -20), (-20, -45)],
    ],
)
def test_accurate_control_is_not_left_out_before_the_adjustment(xy):
    rng = np.random.default_rng(5)
    dropped = sum(bool(G.control_outliers(*_points(rng, xy))) for _ in range(200))
    assert dropped <= 2, f"{dropped} of 200 sets of accurate points lost one"


@pytest.mark.parametrize(
    "xy",
    [
        [(-50, 46), (-70, -70), (70, -70), (70, 70), (-70, 70)],
        [(-50, 46), (-70, -70), (70, -70), (70, 70), (-70, 70), (4, 30)],
        [(-180, 5), (-200, -10), (-100, 12), (0, -8), (100, 10), (200, -12)],
    ],
)
def test_a_point_surveyed_one_metre_off_is_named_whatever_the_model_bends(xy):
    rng = np.random.default_rng(6)
    found = wrong = 0
    for _ in range(100):
        out = [o.id for o in G.control_outliers(*_points(rng, xy, blunder=np.array([0.6, 0.8, 0.0])))]
        found += "G1" in out
        wrong += any(i != "G1" for i in out)
    assert found >= 97 and wrong <= 2, (found, wrong)
