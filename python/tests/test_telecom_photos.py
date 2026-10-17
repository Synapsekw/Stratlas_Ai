"""Best photos of antenna units and their crops (three.js cameras in the local frame)."""

from __future__ import annotations

import json
import math
from pathlib import Path

import numpy as np
import pytest
from PIL import Image
from scipy.spatial.transform import Rotation

from aio_pipelines.telecom.measure import to_project, to_project_dir
from aio_pipelines.telecom.photos import (
    CROP_MARGIN,
    CROP_MAX_PX,
    TOP_PHOTOS,
    best_photos,
    box_corners,
    project_points,
    score_photo,
    write_crop,
)

ORIGIN = (400000.0, 5600000.0, 0.0)
CENTRE = np.array([0.0, 30.0, -2.2])  # local: 2.2 m north of the axis, 30 m up
AXES = np.array([[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, -1.0]])  # across east, up, outward north
EXTENTS = (0.3, 1.4, 0.15)
SIZE = (800, 600)
LENS = {"model": "pinhole", "hfovDeg": 60.0, "aspect": 4 / 3}


def look_at_q(pos, target) -> list[float]:
    """Quaternion [x, y, z, w] of a three.js camera at `pos` looking at `target`, +Y up."""
    back = np.asarray(pos, float) - np.asarray(target, float)
    back /= np.linalg.norm(back)
    right = np.cross([0.0, 1.0, 0.0], back)
    right /= np.linalg.norm(right)
    up = np.cross(back, right)
    m = np.column_stack([right, up, back])
    return [float(v) for v in Rotation.from_matrix(m).as_quat()]  # [x, y, z, w]


def project_unit(uid="ant-a-1", centre=CENTRE, axes=AXES, extents=EXTENTS) -> dict:
    return {
        "id": uid,
        "kind": "panel",
        "box": {
            "centre": to_project(np.asarray(centre), ORIGIN).tolist(),
            "axes": to_project_dir(np.asarray(axes)).tolist(),
            "extents": list(extents),
        },
    }


def write_photo(root: Path, name: str, size=SIZE, paint=None) -> dict:
    """A grey JPEG under photos/, optionally with a white rectangle (x0, y0, x1, y1)."""
    img = Image.new("RGB", size, (128, 128, 128))
    if paint is not None:
        img.paste((255, 255, 255), tuple(round(v) for v in paint))
    path = root / "photos" / f"{name}.jpg"
    path.parent.mkdir(parents=True, exist_ok=True)
    img.save(path, "JPEG", quality=95)
    return {"src": {"path": f"photos/{name}.jpg"}}


def camera(root: Path, name: str, pos, target=CENTRE, size=SIZE, paint=None) -> dict:
    item = write_photo(root, name, size, paint)
    return {"id": name, **item, "pos": [float(v) for v in pos], "q": look_at_q(pos, target), "lens": LENS}


def manifest_with(items: list[dict]) -> dict:
    return {
        "schema": "aio.project/1",
        "origin": list(ORIGIN),
        "layers": [{"kind": "photos", "id": "ph", "name": "Photos", "items": items}],
    }


def around(deg: float, dist: float = 10.0) -> np.ndarray:
    """A camera position `dist` from the unit, `deg` clockwise from its normal (north)."""
    t = math.radians(deg)
    return CENTRE + dist * np.array([math.sin(t), 0.0, -math.cos(t)])


def test_facing_photo_projects_to_centre(tmp_path):
    item = camera(tmp_path, "front", around(0.0))
    px, depth = project_points(item, LENS, SIZE, CENTRE[None, :])
    assert depth[0] == pytest.approx(10.0, abs=1e-6)
    assert px[0, 0] == pytest.approx(SIZE[0] / 2, abs=2) and px[0, 1] == pytest.approx(SIZE[1] / 2, abs=2)
    # a point 1 m up lands above the centre (image y grows downward) by f / 10 px
    f = (SIZE[0] / 2) / math.tan(math.radians(30.0))
    px_up, _ = project_points(item, LENS, SIZE, (CENTRE + np.array([0.0, 1.0, 0.0]))[None, :])
    assert px_up[0, 1] == pytest.approx(SIZE[1] / 2 - f / 10.0, abs=0.5)
    # the camera looks south at the north-facing unit, so 1 m east is on its left
    px_e, _ = project_points(item, LENS, SIZE, (CENTRE + np.array([1.0, 0.0, 0.0]))[None, :])
    assert px_e[0, 0] == pytest.approx(SIZE[0] / 2 - f / 10.0, abs=0.5)


def test_facing_beats_oblique_and_behind(tmp_path):
    facing = camera(tmp_path, "facing", around(0.0))
    oblique = camera(tmp_path, "oblique", around(60.0))
    away = around(0.0)
    behind = camera(tmp_path, "behind", away, target=away + (away - CENTRE))  # the unit is behind it
    items = [behind, oblique, facing]
    unit = project_unit()
    m = manifest_with(items)
    got = best_photos([unit], m, tmp_path)["ant-a-1"]
    assert [p["id"] for p in got] == ["facing", "oblique"]
    assert all(p["layer"] == "ph" and 0 < p["score"] <= 1 for p in got)
    assert got[0]["score"] > got[1]["score"]
    # the behind photo scores 0 on its own terms
    corners = box_corners(unit, ORIGIN)
    px, depth = project_points(behind, LENS, SIZE, corners)
    assert score_photo(px, depth, SIZE, CENTRE - away, AXES[2], 10.0) == 0.0
    # the facing score is the formula's: whole box in frame, square on, 10 m
    px, depth = project_points(facing, LENS, SIZE, corners)
    assert score_photo(px, depth, SIZE, CENTRE - around(0.0), AXES[2], 10.0) == pytest.approx(
        0.4 + 0.4 + 0.2 / 1.5, abs=1e-6
    )


def test_camera_behind_the_unit_is_never_in_its_photos(tmp_path):
    front = camera(tmp_path, "front", around(0.0))
    back = camera(tmp_path, "back", around(180.0))  # behind the unit, looking at its back
    side = camera(tmp_path, "side", around(95.0))  # just past edge-on, behind the face plane
    unit = project_unit()
    got = best_photos([unit], manifest_with([back, side, front]), tmp_path)["ant-a-1"]
    assert [p["id"] for p in got] == ["front"]
    corners = box_corners(unit, ORIGIN)
    px, depth = project_points(back, LENS, SIZE, corners)
    assert np.all(depth > 0) and np.all((px >= 0) & (px <= SIZE))  # it sees the whole box...
    assert score_photo(px, depth, SIZE, CENTRE - around(180.0), AXES[2], 10.0) == 0.0  # ...from behind
    # only a back view: no photos, so no crop either
    alone = best_photos([unit], manifest_with([back]), tmp_path)["ant-a-1"]
    assert alone == []


def test_box_mostly_out_of_frame_scores_zero():
    corners = np.array([[790.0, 100.0], [1000.0, 100.0], [790.0, 300.0], [1000.0, 300.0]])
    assert score_photo(corners, np.ones(4), SIZE, [0, 0, -1], [0, 0, 1], 5.0) == 0.0  # 5 % in frame
    corners[:, 0] -= 150  # now 160 of 210 px in frame
    assert score_photo(corners, np.ones(4), SIZE, [0, 0, -1], [0, 0, 1], 5.0) > 0.0


def test_keeps_the_top_three(tmp_path):
    items = [camera(tmp_path, f"c{k}", around(deg)) for k, deg in enumerate((0.0, 10.0, 20.0, 30.0, 40.0))]
    got = best_photos([project_unit()], manifest_with(items), tmp_path)["ant-a-1"]
    assert len(got) == TOP_PHOTOS and [p["id"] for p in got] == ["c0", "c1", "c2"]


def test_crop_is_bounded(tmp_path):
    size = (4000, 3000)
    unit = project_unit()
    pos = around(0.0)
    probe = {"pos": pos.tolist(), "q": look_at_q(pos, CENTRE)}
    px, _ = project_points(probe, LENS, size, box_corners(unit, ORIGIN))
    (x0, y0), (x1, y1) = px.min(axis=0), px.max(axis=0)
    item = camera(tmp_path, "big", pos, size=size, paint=(x0, y0, x1, y1))
    m = manifest_with([item])
    out = tmp_path / "out" / "ant-a-1.jpg"
    got = write_crop(tmp_path, unit, {"layer": "ph", "id": "big"}, m, out)
    assert got == out and out.is_file()
    with Image.open(out) as im:
        assert im.format == "JPEG" and max(im.size) <= CROP_MAX_PX == 512
        assert not im.getexif()  # no metadata of the photo
        a = np.asarray(im.convert("L"), dtype=float)
    w_box, h_box = x1 - x0, y1 - y0
    # the whole box plus the margin: the crop's aspect is the padded box's, the border is grey
    assert a.shape[1] / a.shape[0] == pytest.approx(w_box / h_box, rel=0.03)
    assert max(a.shape) == CROP_MAX_PX  # 1.3 x a ~490 px tall box is more than 512: scaled down
    for edge in (a[0], a[-1], a[:, 0], a[:, -1]):
        assert float(np.mean(np.abs(edge - 128))) < 12
    h, w = a.shape
    assert float(a[h // 2, w // 2]) > 240
    white = float((a > 192).mean())
    assert white == pytest.approx(1 / (1 + 2 * CROP_MARGIN) ** 2, abs=0.04)


def test_crop_none_when_photo_missing_or_blind(tmp_path):
    unit = project_unit()
    away = around(0.0)
    item = camera(tmp_path, "behind", away, target=away + (away - CENTRE))
    m = manifest_with([item])
    assert write_crop(tmp_path, unit, {"layer": "ph", "id": "behind"}, m, tmp_path / "x.jpg") is None
    assert write_crop(tmp_path, unit, {"layer": "ph", "id": "nope"}, m, tmp_path / "y.jpg") is None
    assert not (tmp_path / "x.jpg").exists() and not (tmp_path / "y.jpg").exists()


def test_no_photos_gives_empty_lists(tmp_path):
    units = [project_unit("ant-a-1"), project_unit("ant-a-2", centre=CENTRE + np.array([0.0, 0.0, 4.4]))]
    assert best_photos(
        units, {"schema": "aio.project/1", "origin": list(ORIGIN), "layers": []}, tmp_path
    ) == {
        "ant-a-1": [],
        "ant-a-2": [],
    }
    # photos without a pose or without a file count as no photos
    unposed = {"id": "u1", **write_photo(tmp_path, "u1")}
    gone = {"id": "g1", "src": {"path": "photos/gone.jpg"}, "pos": around(0.0).tolist(), "q": [0, 0, 0, 1]}
    m = manifest_with([unposed, gone])
    assert best_photos(units, m, tmp_path) == {"ant-a-1": [], "ant-a-2": []}
    json.dumps(m)  # the manifest stays plain JSON
