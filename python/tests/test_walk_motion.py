"""Orientation, standing and steps from a walk's motion data (aio_pipelines.walk.motion).

Synthetic motion only: the true orientation is an analytic function of time, the gyro is its body
rate (plus a bias and noise where a test says so) and the accelerometer reads the reaction to
gravity (+1 g "up", in the camera frame) plus walking accelerations."""

from __future__ import annotations

import math
import time

import numpy as np

from aio_pipelines.walk import motion

RATE = 1000
# A level camera (yaw 0): x right -> world x, y down -> world -z, z forward -> world y.
R_BASE = np.array([[1.0, 0.0, 0.0], [0.0, 0.0, 1.0], [0.0, -1.0, 0.0]])


def rx(a):
    c, s = math.cos(a), math.sin(a)
    return np.array([[1.0, 0.0, 0.0], [0.0, c, -s], [0.0, s, c]])


def ry(a):
    c, s = math.cos(a), math.sin(a)
    return np.array([[c, 0.0, s], [0.0, 1.0, 0.0], [-s, 0.0, c]])


def rz(a):
    c, s = math.cos(a), math.sin(a)
    return np.array([[c, -s, 0.0], [s, c, 0.0], [0.0, 0.0, 1.0]])


def quat_to_mat(q):
    q = np.asarray(q, dtype=np.float64)
    w, x, y, z = q[..., 0], q[..., 1], q[..., 2], q[..., 3]
    m = np.empty((*q.shape[:-1], 3, 3))
    m[..., 0, 0] = 1 - 2 * (y * y + z * z)
    m[..., 0, 1] = 2 * (x * y - w * z)
    m[..., 0, 2] = 2 * (x * z + w * y)
    m[..., 1, 0] = 2 * (x * y + w * z)
    m[..., 1, 1] = 1 - 2 * (x * x + z * z)
    m[..., 1, 2] = 2 * (y * z - w * x)
    m[..., 2, 0] = 2 * (x * z - w * y)
    m[..., 2, 1] = 2 * (y * z + w * x)
    m[..., 2, 2] = 1 - 2 * (x * x + y * y)
    return m


def angle_deg(ra, rb):
    """Angle of the rotation between two stacks of matrices, degrees."""
    rel = np.einsum("...ji,...jk->...ik", ra, rb)
    c = (np.trace(rel, axis1=-2, axis2=-1) - 1) / 2
    return np.degrees(np.arccos(np.clip(c, -1, 1)))


def synth(seconds, truth, bias=(0.0, 0.0, 0.0), lin_acc=None, gyro_noise=0.0, acc_noise=0.0, seed=1):
    """t, acc (g, camera frame), gyro (rad/s, camera frame), true camera-to-world matrices.

    ``truth(t)`` gives the camera-to-world matrix; ``lin_acc(t)`` the walking acceleration in the
    world frame (g)."""
    rng = np.random.default_rng(seed)
    t = np.arange(int(seconds * RATE)) / RATE
    rs = np.array([truth(x) for x in t])
    h = 1e-4
    gyro = np.empty((len(t), 3))
    for i, x in enumerate(t):
        d = rs[i].T @ (truth(x + h) - truth(x - h)) / (2 * h)
        gyro[i] = (d[2, 1] - d[1, 2]) / 2, (d[0, 2] - d[2, 0]) / 2, (d[1, 0] - d[0, 1]) / 2
    world = np.tile([0.0, 0.0, 1.0], (len(t), 1))
    if lin_acc is not None:
        world = world + np.array([lin_acc(x) for x in t])
    acc = np.einsum("nji,nj->ni", rs, world)
    acc += rng.normal(0, acc_noise, acc.shape) if acc_noise else 0
    gyro = gyro + np.asarray(bias) + (rng.normal(0, gyro_noise, gyro.shape) if gyro_noise else 0)
    return t, acc, gyro, rs


def walking(t):
    """World-frame walking acceleration: vertical bounce and forward surge at 1.8 Hz, sway at 0.9."""
    w = 2 * math.pi * 1.8
    return np.array([0.08 * math.sin(w / 2 * t), 0.12 * math.sin(w * t), 0.2 * math.cos(w * t)])


def wobble(t):
    """A hand-held camera: small pitch and roll sway and a slow yaw drift."""
    return rz(0.3 * math.sin(0.4 * t)) @ rx(0.05 * math.sin(2.1 * t)) @ ry(0.04 * math.sin(1.3 * t)) @ R_BASE


# --- sign convention ------------------------------------------------------------------------


def test_level_camera_at_rest_is_the_base_rotation():
    t, acc, gyro, _ = synth(2.0, lambda x: R_BASE)
    assert np.allclose(acc[0], [0, -1, 0])  # the accelerometer reads +1 g "up"; up is -y
    q = motion.orientation(t, acc, gyro, np.array([0.0, 1.0, 1.9]))
    assert q.shape == (3, 4)
    np.testing.assert_allclose(np.linalg.norm(q, axis=1), 1, atol=1e-9)
    assert np.all(angle_deg(quat_to_mat(q), R_BASE) < 0.01)


# --- integration ----------------------------------------------------------------------------


def test_constant_rate_integrates_to_the_right_angle():
    rate = 0.5  # rad/s about the camera's vertical (y) axis: turning on the spot
    t, acc, gyro, rs = synth(10.0, lambda x: rz(rate * x) @ R_BASE)
    q = motion.orientation(t, acc, gyro, t[::100])
    err = angle_deg(quat_to_mat(q), rs[::100])
    assert err.max() < 0.2


def test_bias_removed_with_a_standing_stretch():
    def truth(x):
        return R_BASE if x < 2.5 else wobble(x - 2.5)

    def lin(x):
        return np.zeros(3) if x < 2.5 else walking(x)

    t, acc, gyro, rs = synth(12.5, truth, bias=(0.01, -0.01, 0.01), lin_acc=lin, gyro_noise=0.002)
    standing = motion.standing_stretches(t, acc)
    assert standing and standing[0][0] < 0.3
    b = motion.gyro_bias(t, gyro, standing)
    np.testing.assert_allclose(b, [0.01, -0.01, 0.01], atol=5e-4)
    q = motion.orientation(t, acc, gyro - b, t[::50])
    assert angle_deg(quat_to_mat(q), rs[::50]).max() < 1.0


def sway(t):
    """Hand-held sway in whole cycles over 10 s and no net turn: what the median fallback assumes."""
    return (
        rz(0.15 * math.sin(math.pi * t))
        @ rx(0.05 * math.sin(2 * math.pi * t))
        @ ry(0.04 * math.sin(math.pi * t))
        @ R_BASE
    )


def test_no_standing_stretch_falls_back_to_the_median_rate():
    """Review Focus 1: a walk that starts and ends in motion."""
    t, acc, gyro, rs = synth(10.0, sway, bias=(0.01, 0.01, -0.01), lin_acc=walking, gyro_noise=0.002)
    standing = motion.standing_stretches(t, acc)
    assert standing == []
    b = motion.gyro_bias(t, gyro, standing)
    np.testing.assert_allclose(b, np.median(gyro, axis=0))
    q = motion.orientation(t, acc, gyro - b, t[::50])
    assert angle_deg(quat_to_mat(q), rs[::50]).max() < 3.0
    # Without any correction the same bias drifts well past that.
    q_raw = motion.orientation(t, acc, gyro, t[::50])
    assert angle_deg(quat_to_mat(q_raw), rs[::50]).max() > 3.0


def test_tilt_recovered_from_gravity_under_walking_noise():
    def truth(x):
        return rx(math.radians(10)) @ ry(math.radians(-6)) @ wobble(x)

    t, acc, gyro, rs = synth(30.0, truth, lin_acc=walking, gyro_noise=0.003, acc_noise=0.02)
    # A residual bias the standing stretch did not catch, which only gravity can pull back.
    gyro = gyro + np.array([0.002, 0.0, -0.002])
    q = motion.orientation(t, acc, gyro, t[::50])
    up_est = np.einsum("nji,j->ni", quat_to_mat(q), [0, 0, 1])
    up_true = np.einsum("nji,j->ni", rs[::50], [0, 0, 1])
    tilt = np.degrees(np.arccos(np.clip(np.sum(up_est * up_true, axis=1), -1, 1)))
    assert tilt[t[::50] > 10].max() < 0.5


def test_a_large_tilt_error_is_still_corrected():
    """A gyro glitch on a still camera leaves the estimate 8 degrees off: gravity must win back."""
    t, acc, gyro, _ = synth(40.0, lambda x: R_BASE)
    burst = (t >= 1.0) & (t < 1.2)
    gyro = gyro.copy()
    gyro[burst, 0] += math.radians(8.0) / 0.2  # 8 degrees about camera x that never happened
    q = motion.orientation(t, acc, gyro, np.array([1.3, 39.9]))
    err = angle_deg(quat_to_mat(q), np.stack([R_BASE, R_BASE]))
    assert err[0] > 5.0  # the glitch got in
    assert err[1] < 1.0  # and was corrected away


def test_output_times_interpolate_and_clamp():
    t, acc, gyro, rs = synth(4.0, lambda x: rz(0.3 * x) @ R_BASE)
    out_t = np.array([-1.0, 0.0105, 2.0, 99.0])
    q = motion.orientation(t, acc, gyro, out_t)
    exp = np.array([R_BASE, rz(0.3 * 0.0105) @ R_BASE, rz(0.6) @ R_BASE, rs[-1]])
    assert angle_deg(quat_to_mat(q), exp).max() < 0.05


def test_yaw_is_relative_to_the_first_sample():
    yaw0 = 1.2  # the camera starts facing elsewhere; the output starts at yaw 0 anyway
    t, acc, gyro, _ = synth(3.0, lambda x: rz(yaw0 + 0.2 * x) @ rx(0.1) @ R_BASE)
    q = motion.orientation(t, acc, gyro, np.array([0.0, 2.0]))
    m = quat_to_mat(q)
    exp = np.array([rx(0.1) @ R_BASE, rz(0.4) @ rx(0.1) @ R_BASE])
    assert angle_deg(m, exp).max() < 0.1


# --- levelling ------------------------------------------------------------------------------


def test_level_rotation_levels_the_horizon_and_keeps_yaw():
    yaw = 0.7
    r_level = rz(yaw) @ R_BASE
    r_tilt = rx(math.radians(10)) @ r_level  # tilted 10 degrees about a horizontal axis
    q = motion.quat_from_matrix(np.array([r_tilt, r_level]))
    lv = motion.level_rotation(q)
    assert lv.shape == (2, 3, 3)
    np.testing.assert_allclose(lv[1], np.eye(3), atol=1e-9)  # already level: nothing to do
    # Directions in the tilted camera frame, taken to the levelled frame: the levelled camera
    # (r_tilt @ lv.T) has its down axis on world -z and its forward axis at the same yaw.
    levelled = r_tilt @ lv[0].T
    np.testing.assert_allclose(levelled @ [0, 1, 0], [0, 0, -1], atol=1e-9)
    fwd = levelled @ [0, 0, 1]
    assert abs(fwd[2]) < 1e-9
    np.testing.assert_allclose(math.atan2(-fwd[0], fwd[1]), yaw, atol=1e-6)
    # A world point on the horizon stays on the levelled picture's horizon row (y = 0).
    horizon = np.array([math.cos(0.3), math.sin(0.3), 0.0])
    d_cam = r_tilt.T @ horizon
    assert abs((lv[0] @ d_cam)[1]) < 1e-9
    np.testing.assert_allclose(np.linalg.det(lv), 1, atol=1e-9)


# --- standing and steps ---------------------------------------------------------------------


def test_standing_detection_finds_a_3_s_stop():
    def lin(x):
        return np.zeros(3) if 6.0 <= x < 9.0 else walking(x)

    t, acc, _, _ = synth(15.0, lambda x: R_BASE, lin_acc=lin, acc_noise=0.005)
    st = motion.standing_stretches(t, acc)
    assert len(st) == 1
    a, b = st[0]
    assert abs(a - 6.0) < 0.3 and abs(b - 9.0) < 0.3


def test_standing_needs_the_minimum_duration():
    def lin(x):
        return np.zeros(3) if 6.0 <= x < 7.0 else walking(x)

    t, acc, _, _ = synth(12.0, lambda x: R_BASE, lin_acc=lin, acc_noise=0.005)
    assert motion.standing_stretches(t, acc) == []


def test_step_cadence_counted():
    def lin(x):
        return np.zeros(3) if x < 3.0 else walking(x)

    seconds = 33.0
    t, acc, _, _ = synth(seconds, wobble, lin_acc=lin, acc_noise=0.02)
    steps = motion.step_times(t, acc)
    walking_s = seconds - 3.0
    expected = 1.8 * walking_s
    assert abs(len(steps) - expected) <= 0.02 * expected
    assert steps.min() > 2.5
    cadence = 1 / np.median(np.diff(steps))
    assert abs(cadence - 1.8) < 0.02 * 1.8


# --- rows -----------------------------------------------------------------------------------


def test_decimate_to_200_hz_float32_rows(tmp_path):
    t, acc, gyro, _ = synth(3.0, wobble, lin_acc=walking)
    rows = motion.decimate(t, acc, gyro)
    assert rows.dtype == np.float32 and rows.shape[1] == 7
    np.testing.assert_allclose(np.diff(rows[:, 0]), 1 / 200, atol=1e-5)
    assert abs(len(rows) - 3.0 * 200) <= 1
    np.testing.assert_allclose(rows[100, 1:4], acc[500], atol=0.01)
    np.testing.assert_allclose(rows[100, 4:7], gyro[500], atol=0.01)
    p = tmp_path / "imu.bin"
    motion.write_rows(p, rows)
    back = np.fromfile(p, dtype="<f4").reshape(-1, 7)
    np.testing.assert_array_equal(back, rows)
    assert p.stat().st_size == rows.size * 4


def test_fifteen_minutes_at_1_khz_is_fast():
    n = 900_000
    t = np.arange(n) / RATE
    rng = np.random.default_rng(3)
    acc = np.tile([0.0, -1.0, 0.0], (n, 1)) + rng.normal(0, 0.05, (n, 3))
    gyro = rng.normal(0, 0.05, (n, 3))
    start = time.perf_counter()
    q = motion.orientation(t, acc, gyro, np.arange(0, 900, 1 / 30))
    took = time.perf_counter() - start
    assert q.shape == (27000, 4)
    assert took < 20, f"orientation over 900k samples took {took:.1f} s"
