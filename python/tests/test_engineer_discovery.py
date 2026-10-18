"""Drawing-free equipment discovery from synthetic source surfaces only."""

import numpy as np
import pytest

from aio_pipelines.engineer.axis import Axis
from aio_pipelines.engineer.discovery import discover_components

AXIS = Axis((0, 0, 0), (0, 1, 0), 0)
PROFILE = [(0, 0.45), (20, 0.3)]
SOURCES = [{"kind": "cloud", "ref": "synthetic-scan"}]


def box(centre, size, azimuth, seed=1, density=5000, back=True):
    rng = np.random.default_rng(seed)
    az = np.radians(azimuth)
    axes = np.array([[np.cos(az), 0, np.sin(az)], [0, 1, 0], [np.sin(az), 0, -np.cos(az)]])
    parts = []
    for k in range(3):
        a, b = [i for i in range(3) if i != k]
        count = max(1, int(size[a] * size[b] * density))
        for sign in [-1, 1]:
            if not back and k == 2 and sign == -1:
                continue
            q = np.zeros((count, 3))
            q[:, a] = rng.uniform(-0.5, 0.5, count) * size[a]
            q[:, b] = rng.uniform(-0.5, 0.5, count) * size[b]
            q[:, k] = sign * size[k] / 2
            parts.append(q @ axes + centre + rng.normal(0, 0.001, q.shape))
    return np.concatenate(parts)


def inventory():
    return np.concatenate(
        [
            box([0, 17, -2.5], [0.42, 1.8, 0.18], 0),
            box([2.2, 16, 0], [0.42, 0.65, 0.2], 90, seed=2),
            box([2.2, 16, 0.65], [0.38, 0.5, 0.16], 90, seed=3),
        ]
    )


def test_separate_equipment_is_found_without_drawing_or_expected_count():
    found, warnings = discover_components(inventory(), AXIS, PROFILE, SOURCES)
    assert len(found) == 3
    assert sorted(o["kind"] for o in found) == ["equipment-box", "equipment-box", "panel"]
    assert len({o["id"] for o in found}) == 3
    panel = next(o for o in found if o["kind"] == "panel")
    assert panel["centre"] == pytest.approx([0, 17, -2.5], abs=0.025)
    assert panel["size"] == pytest.approx([0.42, 1.8, 0.18], abs=0.025)
    assert panel["quality"]["depth"]["basis"] == "measured"
    assert all(o["sources"] == SOURCES for o in found)
    assert any("partial" in w.lower() or "miss" in w.lower() for w in warnings)


def test_input_order_and_duplicate_returns_do_not_change_identity_or_count():
    xyz = inventory()
    expected, _ = discover_components(xyz, AXIS, PROFILE, SOURCES)
    shuffled = np.concatenate([xyz, xyz])
    np.random.default_rng(4).shuffle(shuffled)
    actual, _ = discover_components(shuffled, AXIS, PROFILE, SOURCES)
    assert actual == expected


def test_translated_rotated_sources_keep_their_frame_and_separate_devices():
    xyz = inventory()
    turn = np.radians(37)
    rotation = np.array([[np.cos(turn), 0, -np.sin(turn)], [0, 1, 0], [np.sin(turn), 0, np.cos(turn)]])
    offset = np.array([42, 7, -19])
    found, _ = discover_components(
        xyz @ rotation.T + offset, Axis(tuple(offset), (0, 1, 0), 0), PROFILE, SOURCES
    )
    assert len(found) == 3
    panel = next(o for o in found if o["kind"] == "panel")
    assert panel["centre"] == pytest.approx(np.array([0, 17, -2.5]) @ rotation.T + offset, abs=0.03)
    assert panel["size"] == pytest.approx([0.42, 1.8, 0.18], abs=0.03)
    assert panel["azimuthDeg"] == pytest.approx(37, abs=1)


def test_missing_back_keeps_depth_and_centre_inferred():
    xyz = box([0, 17, -2.5], [0.42, 1.8, 0.18], 0, back=False)
    found, _ = discover_components(xyz, AXIS, PROFILE, SOURCES)
    assert len(found) == 1
    for name in ["depth", "centre"]:
        assert found[0]["quality"][name]["basis"] == "inferred"
        assert "residualM" not in found[0]["quality"][name]


def test_unsupported_sideways_lean_is_disclosed_without_moving_source_centre():
    centre = np.array([0, 17, -2.5])
    xyz = box(centre, [0.42, 1.8, 0.18], 0)
    angle = np.radians(5)
    rotation = np.array([[np.cos(angle), -np.sin(angle), 0], [np.sin(angle), np.cos(angle), 0], [0, 0, 1]])
    found, warnings = discover_components((xyz - centre) @ rotation.T + centre, AXIS, PROFILE, SOURCES)
    assert len(found) == 1
    assert found[0]["centre"] == pytest.approx(centre, abs=0.025)
    assert any("Sideways lean" in note for note in found[0]["notes"])
    assert any("sideways lean" in warning.lower() for warning in warnings)


def test_sparse_partial_returns_do_not_invent_unseen_devices():
    xyz = box([0, 17, -2.5], [0.42, 1.8, 0.18], 0, density=1200)
    found, warnings = discover_components(xyz, AXIS, PROFILE, SOURCES)
    assert len(found) == 1
    assert warnings
    tiny = xyz[:12]
    assert discover_components(tiny, AXIS, PROFILE, SOURCES)[0] == []


def test_cancel_before_discovery_does_no_detector_work():
    def cancel():
        raise RuntimeError("cancel requested")

    with pytest.raises(RuntimeError, match="cancel requested"):
        discover_components(inventory(), AXIS, PROFILE, SOURCES, cancel)


def test_dense_crowns_are_bounded_before_normals_and_outliers_are_excluded(monkeypatch):
    from aio_pipelines.engineer import discovery

    seen = []
    monkeypatch.setattr(discovery, "MAX_POINTS", 600)
    monkeypatch.setattr(discovery, "planar_faces", lambda pts, *args: seen.append(pts) or [])
    xyz = np.concatenate([inventory(), [[1e9, 18, -1e9], [0, 1e9, 0], [0, 1, -2], [np.nan, 17, 2]]])
    found, warnings = discover_components(xyz, AXIS, PROFILE, SOURCES)
    assert found == [] and len(seen) == 1
    assert 60 <= len(seen[0]) <= 600
    assert np.isfinite(seen[0]).all()
    assert np.linalg.norm(seen[0][:, [0, 2]], axis=1).max() <= 8
    assert seen[0][:, 1].min() >= 10 and seen[0][:, 1].max() <= 24
    assert any("thinned" in w for w in warnings)
    np.random.default_rng(7).shuffle(xyz)
    discover_components(xyz, AXIS, PROFILE, SOURCES)
    assert np.array_equal(seen[0], seen[1])


def test_cancellation_after_faces_stops_before_box_pairing(monkeypatch):
    from aio_pipelines.engineer import discovery

    faces_finished = False

    def faces(*args):
        nonlocal faces_finished
        faces_finished = True
        return [object()]

    def check():
        if faces_finished:
            raise RuntimeError("cancel after faces")

    monkeypatch.setattr(discovery, "planar_faces", faces)
    monkeypatch.setattr(discovery, "pair_faces", lambda *args: pytest.fail("pairing must not start"))
    with pytest.raises(RuntimeError, match="cancel after faces"):
        discover_components(inventory(), AXIS, PROFILE, SOURCES, check)


@pytest.mark.parametrize("drawing", [False, True])
def test_only_no_drawing_members_stage_calls_discovery_and_keeps_its_warnings(tmp_path, monkeypatch, drawing):
    from aio_pipelines.engineer import compound, discovery, drawings, finial, hardware, pipeline, supports
    from aio_pipelines.engineer.members import FamilyHints, MemberGroup

    xyz = inventory()
    (tmp_path / "work").mkdir()
    np.save(tmp_path / "work/asset.npy", xyz)
    np.save(tmp_path / "work/points.npy", xyz)
    for name in [
        "find_flues",
        "find_legs",
        "find_light_candidates",
        "find_antenna_candidates",
        "find_platforms",
    ]:
        monkeypatch.setattr(pipeline, name, lambda *args, **kwargs: MemberGroup("antenna-candidate"))
    monkeypatch.setattr(pipeline, "family_hints", lambda *args: FamilyHints(1, 30, 1, "telecom-monopole"))
    monkeypatch.setattr(pipeline, "_shaft_height", lambda *args: 20)
    for module, names in [
        (compound, ["fit_compound"]),
        (finial, ["fit_finial", "fit_auxiliary_rods"]),
        (hardware, ["fit_climbing_steps", "fit_cap_beacon"]),
    ]:
        for name in names:
            monkeypatch.setattr(module, name, lambda *args: [])
    calls = []
    support_calls = []
    item = {
        "id": "obs-cloud-device-test",
        "kind": "equipment-box",
        "centre": [2, 16, 0],
        "size": [0.4, 0.5, 0.2],
    }

    def detect(points, axis, profile, sources, check):
        calls.append((points, axis, profile, sources, check))
        return [item], ["Partial source discovery."]

    monkeypatch.setattr(discovery, "discover_components", detect)
    support = {
        "id": "obs-cloud-support-test",
        "kind": "mounting-pipe",
        "centre": [2, 16, 0.3],
        "size": [0.1, 3, 0.1],
    }

    def detect_supports(points, axis, profile, observations, sources, check):
        support_calls.append(observations)
        return [support], {item["id"]: support["id"]}, ["Partial source supports."]

    monkeypatch.setattr(supports, "fit_crown_supports", detect_supports)
    monkeypatch.setattr(drawings, "read_drawing", lambda *args: drawings.DrawingInventory())

    class Context:
        def stage(self, rel):
            return tmp_path / rel

        def input(self, rel):
            return tmp_path / rel

        def outputs(self, key):
            return {
                "axis": {"axis": pipeline._axis_dict(AXIS)},
                "sections": {"slices": [], "taper": {"profile": PROFILE, "residual": 0}, "step": 0.4},
            }[key]

        def progress(self, *args):
            pass

        def check(self):
            pass

    job = pipeline.ModelEvidence()
    raw = {"run": "run-synthetic", "clouds": [{"layer": "synthetic-scan"}], "detail": "fast"}
    if drawing:
        raw["drawings"] = [{"path": "synthetic.dxf"}]
    params = job.validate(raw)
    step = next(s for s in job.plan(params) if s.name == "members")
    result = step.run(Context())
    if drawing:
        assert not calls
        assert not support_calls
        assert item not in result.get("observations", [])
        return
    assert len(calls) == 1
    assert np.array_equal(calls[0][0], xyz)
    assert calls[0][2] == PROFILE and calls[0][3] == SOURCES
    assert support_calls == [[item]]
    assert result["observations"] == [{**item, "parent": support["id"]}, support]
    assert result["warnings"] == ["Partial source discovery.", "Partial source supports."]
