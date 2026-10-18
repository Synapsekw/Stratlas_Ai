"""Source-only crown supports, with no drawing or expected inventory inputs."""

from copy import deepcopy

import numpy as np
import pytest

from aio_pipelines.engineer.axis import Axis
from aio_pipelines.engineer.supports import fit_crown_supports

AXIS = Axis((0, 0, 0), (0, 1, 0), 0)
PROFILE = [(0, 0.45), (20, 0.3)]
SOURCES = [{"kind": "cloud", "ref": "synthetic-supports"}]


def tube(a, b, radius=0.045, seed=1, arc=2 * np.pi):
    a, b = np.array(a), np.array(b)
    direction = (b - a) / np.linalg.norm(b - a)
    right = np.cross(direction, [1, 0, 0] if abs(direction[1]) > 0.9 else [0, 1, 0])
    right /= np.linalg.norm(right)
    out = np.cross(direction, right)
    rng = np.random.default_rng(seed)
    n = int(np.linalg.norm(b - a) * radius * arc * 6000)
    t, angle = rng.uniform(0, 1, n), rng.uniform(0, arc, n)
    return (
        a
        + t[:, None] * (b - a)
        + radius * (np.cos(angle)[:, None] * right + np.sin(angle)[:, None] * out)
        + rng.normal(0, 0.0008, (n, 3))
    )


def platform(y=14.8, partial=False):
    rng = np.random.default_rng(3)
    xz = rng.uniform(-1.8, 1.8, (22000, 2))
    xz = xz[np.linalg.norm(xz, axis=1) > 0.42]
    if partial:
        xz = xz[xz[:, 0] > 0.6]
    return np.column_stack([xz[:, 0], y + rng.normal(0, 0.001, len(xz)), xz[:, 1]])


def device(kind="equipment-box"):
    return {
        "id": "source-device",
        "kind": kind,
        "centre": [0, 17, -2.0],
        "size": [0.5, 1.8, 0.18],
        "azimuthDeg": 0,
        "tiltDeg": 0,
    }


def scene():
    return np.concatenate(
        [
            tube([0, 15, -1.7], [0.04, 19, -1.7]),
            platform(),
            tube([0.02, 16.5, -1.7], [0, 16.5, -1.91], 0.022),
            tube([0.02, 17.5, -1.7], [0, 17.5, -1.91], 0.022),
        ]
    )


def fit(xyz, devices=None, axis=AXIS, check=None):
    return fit_crown_supports(xyz, axis, PROFILE, [device()] if devices is None else devices, SOURCES, check)


def test_cloud_supports_keep_measured_pipes_platform_and_unknown_device_parent():
    original = device()
    before = deepcopy(original)
    found, parents, warnings = fit(scene(), [original])
    pipes = [o for o in found if o["kind"] == "mounting-pipe"]
    decks = [o for o in found if o["kind"] == "platform"]
    assert len(pipes) == len(decks) == 1
    assert original == before
    assert parents == {original["id"]: pipes[0]["id"]}
    assert pipes[0]["size"][0] == pytest.approx(0.09, abs=0.012)
    assert pipes[0]["path"][0] == pytest.approx([0, 15, -1.7], abs=0.08)
    assert pipes[0]["path"][-1] == pytest.approx([0.04, 19, -1.7], abs=0.08)
    assert decks[0]["centre"][1] == pytest.approx(14.8, abs=0.01)
    assert decks[0]["size"][0] == pytest.approx(3.6, abs=0.08)
    assert decks[0]["quality"]["height"]["basis"] == "inferred"
    assert all(o["sources"] == SOURCES for o in found)
    assert warnings  # unresolved construction remains disclosed


def test_order_and_duplicates_do_not_change_supports_or_associations():
    xyz = scene()
    expected = fit(xyz)
    shuffled = np.concatenate([xyz, xyz])
    np.random.default_rng(8).shuffle(shuffled)
    assert fit(shuffled) == expected


def test_sources_keep_translation_yaw_and_device_pose():
    angle = np.radians(37)
    rotation = np.array([[np.cos(angle), 0, -np.sin(angle)], [0, 1, 0], [np.sin(angle), 0, np.cos(angle)]])
    shift = np.array([42, 7, -19])
    d = device()
    d["centre"] = (np.array(d["centre"]) @ rotation.T + shift).tolist()
    d["azimuthDeg"] = 37
    before = deepcopy(d)
    found, parents, _ = fit(scene() @ rotation.T + shift, [d], Axis(tuple(shift), (0, 1, 0), 0))
    pipe = next(o for o in found if o["kind"] == "mounting-pipe")
    assert pipe["path"][0] == pytest.approx(np.array([0, 15, -1.7]) @ rotation.T + shift, abs=0.08)
    assert d == before and parents[d["id"]] == pipe["id"]


def test_absent_or_incomplete_support_is_not_invented():
    found, parents, warnings = fit(platform(partial=True))
    assert not found and not parents
    assert any("unsupported" in w.lower() or "missing" in w.lower() for w in warnings)
    found, _, _ = fit(tube([0, 15, -1.7], [0, 19, -1.7], arc=np.pi / 3), [])
    assert not any(o["kind"] == "mounting-pipe" for o in found)


def test_no_parent_without_observed_bridge_between_device_and_pipe():
    found, parents, _ = fit(tube([0, 15, -1.7], [0, 19, -1.7]))
    assert any(o["kind"] == "mounting-pipe" for o in found)
    assert parents == {}


def test_unsupported_lean_is_rejected_without_aborting_discovery():
    found, _, _ = fit(tube([0, 15, -1.7], [1, 19, -1.7]), [])
    assert not any(o["kind"] == "mounting-pipe" for o in found)


def test_short_round_patch_does_not_validate_a_mostly_partial_cylinder():
    xyz = np.concatenate(
        [tube([0, 15, -1.7], [0, 15.7, -1.7]), tube([0, 15.7, -1.7], [0, 19, -1.7], arc=np.pi / 2)]
    )
    found, _, _ = fit(xyz, [])
    assert not any(o["kind"] == "mounting-pipe" and o["size"][1] > 1 for o in found)


def test_disconnected_horizontal_cap_does_not_expand_the_platform_envelope():
    rng = np.random.default_rng(7)
    cap = rng.uniform(-0.15, 0.15, (600, 3)) + np.array([3.0, 14.8, 0])
    cap[:, 1] = 14.8 + rng.normal(0, 0.001, len(cap))
    found, _, _ = fit(np.concatenate([platform(), cap]), [])
    decks = [o for o in found if o["kind"] == "platform"]
    assert len(decks) == 1
    assert decks[0]["size"][0] == pytest.approx(3.6, abs=0.08)


def test_supported_outer_notch_is_not_filled_by_a_convex_envelope():
    from shapely.geometry import Point, Polygon

    xyz = platform()
    xyz = xyz[~((xyz[:, 0] > 1) & (abs(xyz[:, 2]) < 0.5))]
    found, _, _ = fit(xyz, [])
    deck = next(o for o in found if o["kind"] == "platform")
    outline = Polygon([(p[0], p[2]) for p in deck["path"]])
    assert not outline.contains(Point(1.5, 0))


def test_platform_access_slot_may_connect_the_shaft_opening_to_the_edge():
    from shapely.geometry import Point, Polygon

    xyz = platform()
    xyz = xyz[~((xyz[:, 0] > 0) & (abs(xyz[:, 2]) < 0.16))]
    found, _, _ = fit(xyz, [])
    deck = next(o for o in found if o["kind"] == "platform")
    outline = Polygon([(p[0], p[2]) for p in deck["path"]])
    assert not outline.contains(Point(1.2, 0))


def test_slightly_sloping_platform_keeps_its_measured_plane():
    xyz = platform()
    xyz[:, 1] += 0.035 * xyz[:, 0] - 0.02 * xyz[:, 2]
    found, _, _ = fit(xyz, [])
    deck = next(o for o in found if o["kind"] == "platform")
    path = np.asarray(deck["path"])
    assert deck["size"][0] == pytest.approx(3.6, abs=0.1)
    assert np.max(abs(path[:, 1] - (14.8 + 0.035 * path[:, 0] - 0.02 * path[:, 2]))) < 0.012


def test_cancel_stops_before_source_processing():
    def cancel():
        raise RuntimeError("cancel supports")

    with pytest.raises(RuntimeError, match="cancel supports"):
        fit(scene(), check=cancel)
