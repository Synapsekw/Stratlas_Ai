"""Hand corrections (Edit position, pins) reach ODM: photo.align reads orientation.json."""

import json
from types import SimpleNamespace

import numpy as np
import pytest
from pyproj import Transformer

from aio_pipelines.photo import align as A
from aio_pipelines.photo.corrections import corrected_pos, placed_by_hand, read_offsets
from aio_pipelines.photo.exif import read_photo
from photo_g2_synth import SITE_LAT, SITE_LON, synthetic_jpeg

ORIGIN = [245884.9, 3179597.1, 12.5]
EPSG = 32639
EXIF_ALT = 90.0
YAW = 37.0


def _orientation(project, photos, schema="aio.orientation/1"):
    (project / "orientation.json").write_text(
        json.dumps({"schema": schema, "clips": {}, "photos": photos}), "utf-8"
    )


def _imported_pos(lat, lon, h):
    """The photo record's imported ``pos`` for a GPS place (local frame: x east, y up, z south)."""
    e, n = Transformer.from_crs(4326, EPSG, always_xy=True).transform(lon, lat)
    return [e - ORIGIN[0], h - ORIGIN[2], ORIGIN[1] - n]


def _project(project, items_extra=None):
    """Three GPS photos at EXIF height 90 m in a photos layer (no vertical datum, so the project
    height of a GPS photo is its absolute altitude as logged, the same rule photo.align uses)."""
    items = []
    for k in range(3):
        lat = SITE_LAT + k * 1e-4
        synthetic_jpeg(project / "photos" / f"e{k}.jpg", lat=lat, lon=SITE_LON, alt=EXIF_ALT, yaw=YAW)
        item = {
            "id": f"e{k}",
            "src": {"path": f"photos/e{k}.jpg"},
            "pos": _imported_pos(lat, SITE_LON, EXIF_ALT),
        }
        item.update((items_extra or {}).get(f"e{k}", {}))
        items.append(item)
    manifest = {
        "schema": "aio.project/1",
        "crs": {"epsg": EPSG},
        "origin": ORIGIN,
        "layers": [{"kind": "photos", "id": "photos", "name": "Flight", "visible": True, "items": items}],
    }
    (project / "manifest.json").write_text(json.dumps(manifest), "utf-8")
    return manifest


def _inspect(project, manifest):
    """The inspect step's position pieces: metas, heights, whether geo.txt is written, its rows."""
    logs: list[tuple[str, str]] = []
    ctx = SimpleNamespace(project=project, log=lambda msg, level="info": logs.append((msg, level)))
    params = {"photos": {"layer": "photos"}}
    listed, extra = A.photo_list(ctx, params)
    metas = []
    for key, path in listed:
        m = read_photo(key, path)
        A.layer_meta(m, extra[key], manifest)
        metas.append(m)
    H, _, _ = A.heights_rule(metas, manifest, "auto")
    geo = A.needs_geo(metas, H, params)
    rows = {r.link: r for r in A.geo_rows(metas, H, {m.key: m.key for m in metas}, "auto")}
    return {m.key: m for m in metas}, H, geo, rows, logs


# ------------------------------------------------------------------------------- read_offsets


def test_no_orientation_file_is_no_offsets(project):
    assert read_offsets(project) == {}


def test_offsets_by_layer_and_photo_zero_and_bad_ones_left_out(project):
    _orientation(
        project,
        {
            "photos": {
                "a": {"yawDeg": 0, "pitchDeg": 0, "rollDeg": 0, "offsetM": [1, -100, 2.5]},
                "b": {"yawDeg": 10, "pitchDeg": 0, "rollDeg": 0},  # a direction only
                "c": {"yawDeg": 0, "pitchDeg": 0, "rollDeg": 0, "offsetM": [0.0001, 0, -0.0002]},
                "d": {"yawDeg": 0, "pitchDeg": 0, "rollDeg": 0, "offsetM": [1, "x", 2]},
            }
        },
    )
    assert read_offsets(project) == {("photos", "a"): (1.0, -100.0, 2.5)}


def test_an_unreadable_or_foreign_file_gives_no_offsets_and_a_warning(project):
    warned: list[str] = []
    _orientation(project, {"photos": {"a": {"offsetM": [0, 5, 0]}}}, schema="aio.orientation/2")
    assert read_offsets(project, warned.append) == {}
    assert len(warned) == 1 and "aio.orientation/2" in warned[0]
    (project / "orientation.json").write_text("{not json", "utf-8")
    assert read_offsets(project, warned.append) == {}
    assert len(warned) == 2


def test_corrected_pos_adds_the_offset_except_on_a_pin():
    assert corrected_pos({"pos": [1, 2, 3]}, None) == [1.0, 2.0, 3.0]
    assert corrected_pos({"pos": [1, 2, 3]}, (0.5, -100, 1)) == [1.5, -98.0, 4.0]
    pinned = {"pos": [7, 1.6, 9], "pin": {"ground": [7, 0, 9], "eyeM": 1.6}}
    assert corrected_pos(pinned, (0, -100, 0)) == [7.0, 1.6, 9.0]
    assert corrected_pos({}, (0, 1, 0)) is None
    assert placed_by_hand({"pos": [0, 0, 0]}, None) is False
    assert placed_by_hand({"pos": [0, 0, 0]}, (0, 1, 0)) is True
    assert placed_by_hand(pinned, None) is True
    assert placed_by_hand({"pin": {"ground": [0, 0, 0]}}, None) is False  # nowhere to put it


# ------------------------------------------------------------------------------- into geo.txt


def test_without_orientation_json_nothing_changes(project):
    manifest = _project(project)
    metas, H, geo, _, _ = _inspect(project, manifest)
    assert geo is False  # ODM reads the photos' own GPS
    assert all(not m.from_layer for m in metas.values())
    assert np.allclose(H, EXIF_ALT)


def test_a_photo_moved_down_goes_to_odm_100_m_lower_at_the_same_place(project):
    manifest = _project(project)
    _orientation(
        project, {"photos": {"e1": {"yawDeg": 0, "pitchDeg": 0, "rollDeg": 0, "offsetM": [0, -100, 0]}}}
    )
    metas, H, geo, rows, _ = _inspect(project, manifest)
    assert geo is True
    r = rows["e1"]
    assert r.lat == pytest.approx(SITE_LAT + 1e-4, abs=1e-7)
    assert r.lon == pytest.approx(SITE_LON, abs=1e-7)
    assert r.h == pytest.approx(EXIF_ALT - 100, abs=1e-3)
    assert metas["e1"].from_layer is True
    # the other photos keep their own GPS and height
    assert rows["e0"].h == pytest.approx(EXIF_ALT) and rows["e2"].h == pytest.approx(EXIF_ALT)
    assert rows["e0"].lat == pytest.approx(SITE_LAT, abs=1e-7)


def test_a_shift_north_moves_the_latitude(project):
    manifest = _project(project)
    # 50 m north is local z -50
    _orientation(
        project, {"photos": {"e0": {"yawDeg": 0, "pitchDeg": 0, "rollDeg": 0, "offsetM": [0, 0, -50]}}}
    )
    _, _, _, rows, _ = _inspect(project, manifest)
    dlat_m = (rows["e0"].lat - SITE_LAT) * 111_000
    assert dlat_m == pytest.approx(50, abs=1.0)
    # grid north (the project CRS) is a fraction of a degree off true north here: under 1 m east
    assert rows["e0"].lon == pytest.approx(SITE_LON, abs=1e-5)
    assert rows["e0"].h == pytest.approx(EXIF_ALT, abs=1e-3)


def test_a_pinned_gps_photo_goes_at_its_pin_and_ignores_an_offset(project):
    pin_pos = [30.0, 1.6, -40.0]
    manifest = _project(project, {"e2": {"pos": pin_pos, "pin": {"ground": [30.0, 0.0, -40.0], "eyeM": 1.6}}})
    _orientation(
        project, {"photos": {"e2": {"yawDeg": 0, "pitchDeg": 0, "rollDeg": 0, "offsetM": [0, -100, 0]}}}
    )
    _, _, geo, rows, _ = _inspect(project, manifest)
    assert geo is True
    lon, lat = Transformer.from_crs(EPSG, 4326, always_xy=True).transform(
        ORIGIN[0] + pin_pos[0], ORIGIN[1] - pin_pos[2]
    )
    assert rows["e2"].lon == pytest.approx(lon, abs=1e-7) and rows["e2"].lat == pytest.approx(lat, abs=1e-7)
    assert rows["e2"].h == pytest.approx(ORIGIN[2] + pin_pos[1], abs=1e-3)


def test_rotations_in_the_file_leave_the_photos_gimbal_angles(project):
    manifest = _project(project)
    _orientation(
        project, {"photos": {"e0": {"yawDeg": 30, "pitchDeg": 10, "rollDeg": 5, "offsetM": [0, -10, 0]}}}
    )
    metas, _, _, rows, _ = _inspect(project, manifest)
    assert rows["e0"].yaw == pytest.approx(YAW)
    assert rows["e0"].pitch == pytest.approx(metas["e1"].pitch)


def test_a_foreign_orientation_file_is_warned_about_and_ignored(project):
    manifest = _project(project)
    _orientation(project, {"photos": {"e0": {"offsetM": [0, -10, 0]}}}, schema="aio.orientation/9")
    _, H, geo, _, logs = _inspect(project, manifest)
    assert geo is False and np.allclose(H, EXIF_ALT)
    assert any(level == "warn" and "orientation.json" in msg for msg, level in logs)
