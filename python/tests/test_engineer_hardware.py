import numpy as np

from aio_pipelines.engineer.finial import fit_auxiliary_rods
from aio_pipelines.engineer.hardware import fit_cap_beacon, fit_climbing_steps, fit_roof_panels


def test_roof_ridge_is_fitted_in_source_frame_and_flat_roof_is_not_invented():
    rng = np.random.default_rng(31)
    uv = rng.uniform([0, 0], [4, 2.6], (15000, 2))
    angle = 0.47
    r = np.array([[np.cos(angle), -np.sin(angle)], [np.sin(angle), np.cos(angle)]])
    plan = uv @ r.T + [18, -7]
    y = 6 + 0.3 * (1.3 - abs(uv[:, 1] - 1.3)) + rng.normal(0, 0.008, len(uv))
    p = np.column_stack([plan[:, 0], y, plan[:, 1]])
    corners = np.array([[0, 0], [4, 0], [4, 2.6], [0, 2.6]]) @ r.T + [18, -7]
    path = [[x, 6.2, z] for x, z in corners]
    fit = fit_roof_panels(p, path)
    assert fit is not None and len(fit["panels"]) == 2
    assert abs(max(v[1] for panel in fit["panels"] for v in panel) - 6.39) < 0.035
    assert abs(min(v[1] for panel in fit["panels"] for v in panel) - 6) < 0.035
    assert fit["residualM"] < 0.02
    p[:, 1] = 6 + 0.04 * uv[:, 0] + rng.normal(0, 0.004, len(uv))
    fit = fit_roof_panels(p, path)
    assert fit is not None and len(fit["panels"]) == 1
    assert fit_roof_panels(p[:20], path) is None


def test_climbing_steps_follow_translated_leaning_shaft_without_inventing_a_ladder():
    rng = np.random.default_rng(14)
    base = np.array([12.0, 3.0, -8.0])
    axis = np.array([0.006, 1.0, -0.009])
    az = np.deg2rad(72)
    out = np.array([np.sin(az), 0, -np.cos(az)])
    side = np.array([np.cos(az), 0, np.sin(az)])
    h = rng.uniform(0, 20, 65000)
    a = rng.uniform(0, 2 * np.pi, len(h))
    rad = 0.5 - 0.008 * h
    shaft = base + h[:, None] * axis + np.column_stack([rad * np.cos(a), np.zeros(len(h)), rad * np.sin(a)])
    shaft += rng.normal(0, 0.003, shaft.shape)
    steps = []
    for dy in np.arange(2.1, 18.8, 0.29):
        c = base + dy * axis + (0.5 - 0.008 * dy + 0.08) * out
        steps.append(c + rng.uniform(-0.18, 0.18, (45, 1)) * side + rng.normal(0, 0.005, (45, 3)))
    profile = [{"y": 3.0, "r": 0.5}, {"y": 23.0, "r": 0.34}]
    refs = [{"kind": "cloud", "ref": "source"}]
    fitted = fit_climbing_steps(np.concatenate([shaft, *steps]), base, axis, profile, 22.0, refs)
    assert len(fitted) == 1
    o = fitted[0]
    assert o["kind"] == "climbing-steps" and len(o["path"]) > 45
    assert abs(o["azimuthDeg"] - 72) < 7
    assert 0.28 < np.median(np.diff(np.array(o["path"])[:, 1])) < 0.30
    assert 0.30 < o["size"][0] < 0.43
    assert o["quality"]["centre"]["basis"] == "measured"
    assert fit_climbing_steps(shaft, base, axis, profile, 22.0, refs) == []


def test_partial_step_returns_do_not_rotate_the_route_onto_radial_mounting_legs():
    rng = np.random.default_rng(27)
    base = np.array([6.0, 2.0, -3.0])
    axis = np.array([0.004, 1.0, -0.006])
    bearing = np.deg2rad(40)
    out = np.array([np.sin(bearing), 0, -np.cos(bearing)])
    side = np.array([np.cos(bearing), 0, np.sin(bearing)])
    points = []
    for i, h in enumerate(np.arange(2.1, 18.8, 0.29)):
        centre = base + h * axis
        if i % 3 == 0:
            # Some steps expose the whole transverse bar.
            p = centre + 0.58 * out + rng.uniform(-0.18, 0.18, (40, 1)) * side
        else:
            # Occlusion leaves a mounting leg at alternating ends of the other steps.
            # Its long direction is radial, although the route still spans the bar width.
            t = rng.uniform(0, 1, (45, 1))
            end = -0.15 if i % 2 else 0.15
            p = centre + (0.525 + 0.19 * t) * out + (end + 0.04 * (t - 0.5)) * side
        points.append(p + rng.normal(0, 0.002, p.shape))

    fitted = fit_climbing_steps(
        np.concatenate(points),
        base,
        axis,
        [{"y": 2.0, "r": 0.5}, {"y": 22.0, "r": 0.5}],
        21.0,
        [{"kind": "cloud", "ref": "scan"}],
    )
    assert len(fitted) == 1
    steps = fitted[0]
    assert len(steps["path"]) > 50
    assert abs(steps["azimuthDeg"] - 40) < 5
    assert 0.28 < steps["size"][0] < 0.4
    assert 0.28 < np.median(np.diff(np.array(steps["path"])[:, 1])) < 0.3
    assert steps["quality"]["centre"]["basis"] == "inferred"
    assert steps["quality"]["height"]["basis"] == "measured"
    assert any("3D" in note for note in steps["notes"])


def test_cap_beacon_requires_supported_red_points_near_measured_shaft_top():
    rng = np.random.default_rng(43)
    p = rng.uniform([3.1, 20.02, -2.08], [3.2, 20.12, -1.98], (80, 3))
    rgb = np.tile([155, 70, 60], (len(p), 1))
    o = fit_cap_beacon(p, rgb, [3, 20, -2], 0.3, [{"kind": "cloud", "ref": "scan"}])
    assert len(o) == 1 and o[0]["kind"] == "light"
    assert abs(o[0]["centre"][1] - 20.07) < 0.02
    assert fit_cap_beacon(p, np.full_like(rgb, 160), [3, 20, -2], 0.3, []) == []
    assert fit_cap_beacon(p - [0, 10, 0], rgb, [3, 20, -2], 0.3, []) == []


def test_roof_does_not_extrapolate_a_small_patch_across_a_large_outline():
    rng = np.random.default_rng(6)
    p = rng.uniform([0, 4, 0], [0.8, 4.01, 0.8], (10000, 3))
    assert fit_roof_panels(p, [[0, 4, 0], [10, 4, 0], [10, 4, 10], [0, 4, 10]]) is None


def test_climbing_rejects_unsupported_standoff_and_overlong_inventory():
    rng = np.random.default_rng(3)
    for height, stand in [(20, 0.215), (82, 0.08)]:
        p = []
        for y in np.arange(1, height - 1, 0.29):
            p.append(
                np.column_stack([rng.uniform(-0.18, 0.18, 45), np.full(45, y), np.full(45, -0.5 - stand)])
                + rng.normal(0, 0.001, (45, 3))
            )
        assert (
            fit_climbing_steps(
                np.concatenate(p),
                [0, 0, 0],
                [0, 1, 0],
                [{"y": 0, "r": 0.5}, {"y": height, "r": 0.5}],
                height,
                [{"kind": "cloud", "ref": "scan"}],
            )
            == []
        )


def test_auxiliary_rods_are_supported_segments_and_do_not_duplicate_known_pipes():
    rng = np.random.default_rng(82)
    points = []
    for x, z in [(-1, 0.7), (0.8, -1), (2, 0)]:
        h = rng.uniform(19.8, 21.4, 2000)
        a = rng.uniform(0, 2 * np.pi, len(h))
        points.append(np.column_stack([x + 0.03 * np.cos(a), h, z + 0.03 * np.sin(a)]))
    points.append(rng.uniform([-0.2, 20.8, -0.2], [0.2, 21.3, 0.2], (1000, 3)))
    p = np.concatenate(points)
    observations = [
        {"kind": "panel", "centre": [0, 20, 0], "size": [0.5, 1, 0.2]},
        {
            "kind": "mounting-pipe",
            "centre": [2, 20.5, 0],
            "size": [0.06, 2, 0.06],
            "path": [[2, 19, 0], [2, 22, 0]],
        },
    ]
    rods = fit_auxiliary_rods(p, observations, [{"kind": "cloud", "ref": "scan"}])
    assert len(rods) == 2
    assert all(1.4 < o["size"][1] < 1.65 and 0.04 < o["size"][0] < 0.07 for o in rods)
    assert all(o["quality"]["centre"]["basis"] == "measured" for o in rods)
    assert sorted(round(o["centre"][0], 1) for o in rods) == [-1, 0.8]
    assert fit_auxiliary_rods(p, [], []) == []


def test_auxiliary_rods_exclude_the_middle_of_a_known_leaning_pipe():
    rng = np.random.default_rng(71)
    h = rng.uniform(20.8, 21.4, 2000)
    a = rng.uniform(0, 2 * np.pi, len(h))
    p = np.column_stack([0.1 * (h - 19) + 0.025 * np.cos(a), h, 0.025 * np.sin(a)])
    observations = [
        {"kind": "panel", "centre": [0, 20, 0], "size": [0.5, 1, 0.2]},
        {
            "kind": "mounting-pipe",
            "centre": [0.25, 21.5, 0],
            "size": [0.05, 5, 0.05],
            "path": [[0, 19, 0], [0.5, 24, 0]],
        },
    ]
    assert fit_auxiliary_rods(p, observations, []) == []
