"""Light of ``pano.stitch`` on synthetic spheres: frames shot up to two stops apart through a lens
that darkens its corners, both rendered in linear light (``pano_synth.expose``)."""

from __future__ import annotations

import math

import cv2
import numpy as np
import pytest

import pano_synth as ps
from aio_pipelines.pano import align, compose, photometry
from aio_pipelines.pano.frames import read_frame_info, read_image

#: Log falloff at the corner of the synthetic lens: 30 percent less light there.
VIGNETTE = -0.35
#: Stops per frame, -1.5 to +0.5.
STOPS = [round(s - 0.5, 3) for s in ps.exposure_offsets(25, 4, 1.0)]


@pytest.fixture(scope="module")
def sphere(tmp_path_factory):
    """A rows sphere at its true rotations, its frame infos and small copies for the fit."""
    frames = ps.make_sphere(
        tmp_path_factory.mktemp("lit"), "rows", frame_w=640, seed=3, exposure=STOPS, vignette=VIGNETTE
    )
    infos = [read_frame_info(f.path) for f in frames]
    s = min(1.0, photometry.FIT_WIDTH / infos[0].width)
    copies = [photometry.fit_copy(read_image(f.path, s), infos[0].focal * s) for f in frames]
    return frames, infos, copies


def _pairs(frames, info):
    hfov = 2 * math.degrees(math.atan(info.width / 2 / info.focal))
    return align.overlap_pairs([f.truth for f in frames], hfov)


@pytest.fixture(scope="module")
def light(sphere):
    frames, infos, copies = sphere
    return photometry.fit(copies, [f.truth for f in frames], [i.ev for i in infos], _pairs(frames, infos[0]))


def test_the_fit_recovers_the_gains_and_the_lens_falloff_without_exif(sphere):
    frames, infos, copies = sphere
    lit = photometry.fit(copies, [f.truth for f in frames], [None] * len(frames), _pairs(frames, infos[0]))
    assert lit.pairs > 60 and lit.samples > 10_000
    g = np.array(lit.log_gains)
    truth = np.array(STOPS) * math.log(2)
    assert np.abs((g.mean(axis=1) - g.mean()) - (truth - truth.mean())).max() < 0.1
    assert np.ptp(g, axis=1).max() < 0.05  # one white balance
    assert math.exp(sum(lit.falloff)) == pytest.approx(math.exp(VIGNETTE), rel=0.03)
    assert photometry.Light.from_json(lit.to_json()) == lit


def test_the_exif_exposure_anchors_the_gains(light):
    # the median frame keeps its EXIF exposure: the gains are the stops off the median frame's
    truth = np.array(STOPS) * math.log(2)
    g = np.array(light.log_gains).mean(axis=1)
    assert np.abs(g - (truth - np.median(truth))).max() < 0.1


def test_evened_frames_agree_where_they_overlap(sphere, light):
    frames, infos, _ = sphere
    w, h = 1024, 512

    def spread(lit: bool) -> float:
        # per canvas pixel, the standard deviation of log grey over the frames that see it
        acc, acc2, cnt = np.zeros((h, w)), np.zeros((h, w)), np.zeros((h, w))
        for k, f in enumerate(frames):
            s = compose.frame_scale(infos[k].focal, w)
            img = read_image(f.path, s)
            if lit:
                img = photometry.apply(img, light, k, f.truth, infos[k].focal * s)
            for p in compose.warp(img, f.truth, infos[k].focal * s, w, h):
                x, y = p.corner
                x1 = min(w, x + p.mask.shape[1])
                m = p.mask[:, : x1 - x] > 0
                grey = cv2.cvtColor(p.image[:, : x1 - x], cv2.COLOR_BGR2GRAY).astype(float)
                v = np.log(np.maximum(grey, 1.0))
                sl = (slice(y, y + p.mask.shape[0]), slice(x, x1))
                acc[sl] += v * m
                acc2[sl] += v * v * m
                cnt[sl] += m
        ov = cnt >= 2
        mean = acc[ov] / cnt[ov]
        return float(np.sqrt(np.maximum(acc2[ov] / cnt[ov] - mean**2, 0)).mean())

    raw, lit = spread(False), spread(True)
    assert raw > 0.1  # a stop or two apart, darker corners
    assert lit < 0.03 and lit < raw / 5


def test_a_frame_that_overlaps_nothing_keeps_its_exif_exposure(sphere):
    frames, infos, copies = sphere
    sub = [0, 1, 2, 4]  # yaws -180, -135, -90 and 0: the last sees none of the others
    rots = [frames[k].truth for k in sub]
    evs = [infos[k].ev for k in sub]
    lit = photometry.fit([copies[k] for k in sub], rots, evs, [(0, 1), (1, 2), (0, 3)])
    assert lit.pairs == 2
    prior = photometry.exposure_log_gains(evs)
    assert lit.log_gains[3] == pytest.approx([prior[3]] * 3, abs=0.01)
    alone = photometry.fit([copies[4]], [frames[4].truth], [infos[4].ev], [])
    assert alone.pairs == 0 and alone.falloff == [0.0, 0.0, 0.0] and alone.log_gains == [[0.0] * 3]


def test_exif_exposure_values_give_log_gains():
    # one stop more light per EV less; the median frame is 0; frames without EXIF are 0
    g = photometry.exposure_log_gains([13.0, 14.0, None, 15.0])
    assert g == pytest.approx([math.log(2), 0.0, 0.0, -math.log(2)])
    assert photometry.exposure_log_gains([None, None]) == pytest.approx([0.0, 0.0])


def test_the_tone_curve_is_identity_below_the_knee_and_brings_white_to_one():
    x = np.linspace(0.0, 1.5, 1501, dtype=np.float32)
    y = photometry.tone(x.copy(), 1.5)
    below = x <= photometry.KNEE
    assert np.array_equal(y[below], x[below])
    assert (np.diff(y) >= 0).all() and y[-1] == pytest.approx(1.0, abs=1e-6)
    # slope 1 out of the knee: no kink
    k = int(np.searchsorted(x, photometry.KNEE))
    assert (y[k + 2] - y[k + 1]) / (x[k + 2] - x[k + 1]) == pytest.approx(1.0, abs=0.02)
    # a sphere whose brightest radiance fits keeps its values
    assert np.array_equal(photometry.tone(x[:900].copy(), 1.0), x[:900])


def test_srgb_round_trips_through_linear_light():
    v = np.arange(256, dtype=np.uint8)
    assert np.array_equal(photometry.to_srgb(photometry.to_linear(v)), v)
