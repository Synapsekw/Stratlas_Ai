"""Independent component fitting must retain unequal devices and expose hidden surfaces."""

import numpy as np
import pytest

from aio_pipelines.engineer.components import fit_device, register_drawing
from aio_pipelines.engineer.drawings import DrawingDevice, DrawingInventory


def face_cloud(centre, size, azimuth=0, count=5000, seed=4):
    rng = np.random.default_rng(seed)
    a = np.radians(azimuth)
    right = np.array([np.cos(a), 0, np.sin(a)])
    front = np.array([np.sin(a), 0, -np.cos(a)])
    xyz = np.asarray(centre) + rng.uniform(-size[0] / 2, size[0] / 2, (count, 1)) * right
    xyz += rng.uniform(-size[1] / 2, size[1] / 2, (count, 1)) * [0, 1, 0]
    xyz += size[2] / 2 * front + rng.normal(0, 0.002, (count, 1)) * front
    return xyz


def test_close_radios_keep_independent_dimensions_and_face_normal():
    xyz = np.vstack(
        [face_cloud([1, 28, 0], [0.52, 0.7, 0.23], 70), face_cloud([1, 27, 0], [0.32, 0.5, 0.18], 72, seed=9)]
    )
    a = fit_device(
        xyz, "obs-radio-a", "rru", [1, 28, 0], [0.52, 0.7, 0.23], 68, [{"kind": "cloud", "ref": "scan"}]
    )
    b = fit_device(
        xyz, "obs-radio-b", "rru", [1, 27, 0], [0.32, 0.5, 0.18], 70, [{"kind": "cloud", "ref": "scan"}]
    )
    assert a is not None and b is not None
    assert a.size[:2] == pytest.approx((0.52, 0.7), abs=0.025)
    assert b.size[:2] == pytest.approx((0.32, 0.5), abs=0.025)
    assert a.azimuth_deg == pytest.approx(70, abs=1)
    assert a.quality["depth"]["basis"] == "observed"  # drawing prior, hidden back cannot be measured
    assert a.quality["azimuthDeg"]["basis"] == "measured"
    assert "residualM" not in a.quality["depth"]


def test_missing_cloud_support_does_not_claim_a_fitted_device():
    assert (
        fit_device(
            np.zeros((100, 3)),
            "obs-empty",
            "panel",
            [1, 28, 0],
            [0.5, 2.6, 0.2],
            0,
            [{"kind": "cloud", "ref": "scan"}],
        )
        is None
    )


def test_registration_finds_heading_and_vertical_datum_from_asymmetric_equipment():
    devices = [
        DrawingDevice("A01", "panel", (1, 0), (0.5, 2.4, 0.2), 90, 25, None, "a"),
        DrawingDevice("A02", "panel", (-0.7, 1), (0.7, 1.8, 0.2), 325, 27, None, "b"),
        DrawingDevice("R01", "rru", (0.2, -1.2), (0.4, 0.6, 0.2), 170, 26, None, "c"),
    ]
    # Drawing EN -> local X,-Z, then a 30-degree clockwise compass turn; no height scaling.
    truth = [0.98, np.radians(30), 0.2, -0.1, -1.25]
    from aio_pipelines.engineer.components import placed_device

    cloud = np.vstack(
        [face_cloud(*placed_device(d, truth), count=3000, seed=i) for i, d in enumerate(devices)]
    )
    result = register_drawing(cloud, DrawingInventory(devices=devices), [0.2, 0, -0.1])
    assert result is not None
    assert result[0] == pytest.approx(truth[0], abs=0.02)
    assert np.degrees(result[1]) % 360 == pytest.approx(30, abs=2)
    assert result[4] == pytest.approx(-1.25, abs=0.04)


def test_registration_keeps_scale_basins_when_rear_surfaces_attract_a_coarse_start():
    from aio_pipelines.engineer.components import placed_device

    devices = []
    radii = [1.3, 1.8, 1.5, 1.7, 1.2, 1.6]
    widths = [0.45, 0.5, 0.4, 0.55, 0.35, 0.48]
    heights = [1.2, 1.8, 1.4, 0.8, 2.1, 1.6]
    for i, azimuth in enumerate([15, 75, 145, 205, 258, 320]):
        angle = np.radians(azimuth)
        devices.append(
            DrawingDevice(
                f"A{i}",
                "panel",
                (radii[i] * np.sin(angle), radii[i] * np.cos(angle)),
                (widths[i], heights[i], 0.2),
                azimuth,
                25 + i * 0.3,
                None,
                str(i),
            )
        )
    truth = [0.98, np.radians(3), 0.02, 0.09, 0]
    points = []
    for i, device in enumerate(devices):
        centre, size, azimuth = placed_device(device, truth)
        points.append(face_cloud(centre, size, azimuth, count=1000, seed=i))
        front = np.array([np.sin(np.radians(azimuth)), 0, -np.cos(np.radians(azimuth))])
        # Smaller rear surfaces create a plausible compressed alignment. The complete
        # front faces independently support the actual scale and plan translation.
        points.append(
            face_cloud(
                np.asarray(centre) - 0.16 * front,
                [0.8 * size[0], 0.8 * size[1], size[2]],
                azimuth,
                count=700,
                seed=i + 50,
            )
        )

    result = register_drawing(np.vstack(points), DrawingInventory(devices=devices), [0.27, 1.25, -0.26])

    assert result is not None
    assert result[0] == pytest.approx(truth[0], abs=0.01)
    assert np.degrees(result[1]) % 360 == pytest.approx(3, abs=1)
    assert result[2:4] == pytest.approx(truth[2:4], abs=0.02)
    assert result[4] == pytest.approx(truth[4], abs=0.02)
