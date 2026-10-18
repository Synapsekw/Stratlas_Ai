"""change.lineup: how far two survey dates are apart, the correction the moved date still needs.

Synthetic two-date imagery and surfaces only (``imagery_synth``): a later ortho (or DSM) moved a
known distance is measured coarse to fine; a later ortho warped by a known small turn and scale is
measured as that similarity; a copy turned too far, a flat image and dates that hardly overlap are
refused with their verdict, and a date already lined up answers ``aligned``.
"""

from __future__ import annotations

import functools
import json
import math

import numpy as np
import pytest
from scipy import ndimage as ndi

from aio_pipelines.change.register import MAX_FINE_TILES, fit_similarity, measure_line_up
from aio_pipelines.pipelines import all_pipelines
from aio_pipelines.runtime import JobError
from aio_pipelines.similarity import Similarity
from conftest import run_job
from imagery_synth import EPSG, ORIGIN, ground, manifest, noisy, ortho_project

CELL = 0.1875
#: The keys of a ``LineUpMeasure`` (``packages/schema/src/change.ts``), a strict object.
MEASURE_KEYS = {
    "keep",
    "move",
    "layerKeep",
    "layerMove",
    "source",
    "eastM",
    "northM",
    "totalM",
    "cellM",
    "tolerancePx",
    "spreadPx",
    "tiles",
    "verdict",
}
#: The keys of a ``LineUpFit`` (``lineup-fit.json``, beside ``lineup.json``).
FIT_KEYS = {
    "rotationDeg",
    "scale",
    "pivotE",
    "pivotN",
    "eastM",
    "northM",
    "maxMoveM",
    "residualPx",
    "inliers",
    "verdict",
}


def pipeline():
    return all_pipelines()["change.lineup"]


def moved(img: np.ndarray, east_px: float, north_px: float) -> np.ndarray:
    """``img`` with its content moved ``east_px`` columns east and ``north_px`` rows north."""
    shift = (-north_px, east_px) + ((0,) if img.ndim == 3 else ())
    return ndi.shift(img, shift, order=3, mode="nearest")


@functools.cache
def dates(n: int, east_m: float = 0.0, north_m: float = 0.0, seed: int = 1):
    """The earlier ortho and the later one whose content sits ``east_m`` east and ``north_m`` north
    (made once per test run: the pairs are read only)."""
    pad = math.ceil(max(abs(east_m), abs(north_m)) / CELL) + 16
    big = ground(n + 2 * pad, n + 2 * pad, seed)
    a = noisy(big[pad : pad + n, pad : pad + n], 101)
    # whole pixels by the window read, the fraction by an interpolated move of that window
    ey, ex = -north_m / CELL, east_m / CELL
    iy, ix = math.floor(ey), math.floor(ex)
    m = 8
    win = big[pad - iy - m : pad - iy + n + m, pad - ix - m : pad - ix + n + m]
    later = moved(win, ex - ix, iy - ey)[m : m + n, m : m + n]
    b = noisy(np.clip(later, 0, 1), 102)
    return a, b


def params(**extra):
    return {"keep": "c1", "move": "c2", **extra}


def measure(project) -> dict:
    return json.loads((project / "jobs" / "j1" / "lineup.json").read_text("utf-8"))


def fit_of(project) -> dict:
    return json.loads((project / "jobs" / "j1" / "lineup-fit.json").read_text("utf-8"))


@functools.cache
def warped(n: int, rotation_deg: float, scale: float, east_m: float, north_m: float, seed: int = 1):
    """The earlier ortho, a later one whose content needs the correction ``true`` to land on the
    earlier one, and ``true``: it turns the later content ``rotation_deg`` counter-clockwise (east
    towards north) and scales it by ``scale`` about the image centre, then moves it ``east_m`` and
    ``north_m``.

    Built in pixels with ``affine_transform``: ``b[o] = big[C(o)]``, so the content ``b`` shows at
    ``o`` sits at ``C(o)`` in ``a``. ``C`` in (row, column), rows south: a counter-clockwise turn
    in the CRS is ``[[A, -B], [B, A]]`` with ``A = s cos``, ``B = s sin``.
    """
    pad = 96
    big = ground(n + 2 * pad, n + 2 * pad, seed)
    a = noisy(big[pad : pad + n, pad : pad + n], 101)
    r = math.radians(rotation_deg)
    A, B = scale * math.cos(r), scale * math.sin(r)
    M = np.array([[A, -B], [B, A]])
    c = np.array([(n + 2 * pad - 1) / 2] * 2)
    t = np.array([-north_m / CELL, east_m / CELL])
    offset = c + t - M @ c
    later = np.stack(
        [ndi.affine_transform(big[..., k], M, offset, order=3, mode="nearest") for k in range(3)], axis=2
    )
    b = noisy(np.clip(later[pad : pad + n, pad : pad + n], 0, 1), 102)
    # ortho_project centres the image on the local origin: the pivot is the CRS origin
    true = Similarity(east_m, north_m, rotation_deg, scale, ORIGIN[0], ORIGIN[1])
    return a, b, true


def corners_en(n: int) -> list[tuple[float, float]]:
    h = n * CELL / 2
    return [(ORIGIN[0] + sx * h, ORIGIN[1] + sy * h) for sx in (-1, 1) for sy in (-1, 1)]


def similarity_of(fit: dict) -> Similarity:
    return Similarity(
        fit["eastM"], fit["northM"], fit["rotationDeg"], fit["scale"], fit["pivotE"], fit["pivotN"]
    )


def run(project, **extra) -> dict:
    before = (project / "manifest.json").read_bytes()
    result, _ = run_job(pipeline(), project, params(**extra))
    assert result["status"] == "done", result
    # the job never writes the manifest
    assert (project / "manifest.json").read_bytes() == before
    m = measure(project)
    assert set(m) == MEASURE_KEYS
    assert (m["keep"], m["move"]) == ("c1", "c2")
    assert set(fit_of(project)) == FIT_KEYS
    return m


# ------------------------------------------------------------------------------------- measured


def test_measures_a_two_metre_shift(tmp_path):
    a, b = dates(1024, east_m=2.0)
    ortho_project(tmp_path, a, b, CELL)
    m = run(tmp_path)
    assert m["verdict"] == "ok"
    assert m["source"] == "ortho"
    assert (m["layerKeep"], m["layerMove"]) == ("ortho-a", "ortho-b")
    # the later date's content sits 2 m east: it still needs 2 m west
    assert abs(m["eastM"] + 2.0) < 0.05
    assert abs(m["northM"]) < 0.05
    assert m["totalM"] == pytest.approx(math.hypot(m["eastM"], m["northM"]), abs=0.002)
    assert m["cellM"] == pytest.approx(CELL)
    assert m["tolerancePx"] == 2
    assert m["tiles"] >= 6 and m["spreadPx"] <= 1.0
    # a plain shift carries no noise turn
    f = fit_of(tmp_path)
    assert (f["rotationDeg"], f["scale"]) == (0, 1)
    assert m["totalM"] == f["maxMoveM"]


def test_a_pure_shift_with_sub_pixel_noise_fits_no_turn():
    rng = np.random.default_rng(5)
    g = np.linspace(64, 960, 6)
    centres = np.array([[r, c] for r in g for c in g])
    true = np.array([0.0, 2.0 / CELL])  # 2 m east, in pixels
    shifts = true + rng.normal(0, 0.15, centres.shape)
    f = fit_similarity(centres, shifts, shape=(1024, 1024))
    assert f["turned"] is False and (f["a"], f["b"]) == (1.0, 0.0)
    assert abs(f["ty"] - true[0]) * CELL < 0.01
    assert abs(f["tx"] - true[1]) * CELL < 0.01
    # a turn that moves a corner by several pixels stays a turn
    th = math.radians(0.1)
    c0 = np.array([512.0, 512.0])
    turned = np.array([[th * (c[1] - c0[1]), -th * (c[0] - c0[0])] for c in centres]) + true
    t = fit_similarity(centres, turned, shape=(1024, 1024))
    assert t["turned"] is True and abs(t["b"]) > 1e-3


def test_measures_forty_metres_coarse_to_fine():
    a, b = dates(2048, north_m=40.0)
    lum = lambda im: im.mean(axis=2)  # noqa: E731
    s = measure_line_up(lum(a), lum(b), np.ones(a.shape[:2], bool), CELL)
    assert s["coarse"] > 1
    # content 40 m north: the later grid moves south (rows down) by 40 m
    assert abs(s["dy"] * CELL - 40.0) < 0.1
    assert abs(s["dx"] * CELL) < 0.1
    assert s["tiles"] >= 6 and s["spread"] <= 1.0


def test_measures_forty_metres_through_the_job(tmp_path):
    a, b = dates(2048, north_m=40.0)
    ortho_project(tmp_path, a, b, CELL)
    m = run(tmp_path)
    assert m["verdict"] == "ok"
    assert abs(m["northM"] + 40.0) < 0.1
    assert abs(m["eastM"]) < 0.1


def test_reads_a_bounded_number_of_fine_tiles():
    rng = np.random.default_rng(7)
    n = 4096
    big = ndi.gaussian_filter(rng.normal(0, 1, (n + 64, n + 64)), 1.2)
    big = 0.5 + 0.08 * big / big.std()
    a, b = big[32 : 32 + n, 32 : 32 + n], big[32 : 32 + n, 27 : 27 + n]
    s = measure_line_up(a, b, np.ones((n, n), bool), CELL)
    assert 6 <= s["tiles"] <= MAX_FINE_TILES
    # the later grid shows the ground 5 px further east: it moves back by 5 px
    assert s["dx"] == pytest.approx(-5, abs=0.2) and s["dy"] == pytest.approx(0, abs=0.2)


# ------------------------------------------------------------------------------- turn and scale


def test_measures_a_turn_and_a_scale(tmp_path):
    n = 1024
    a, b, true = warped(n, 0.1, 1.003, 2.0, 0.0)
    ortho_project(tmp_path, a, b, CELL)
    m = run(tmp_path)
    f = fit_of(tmp_path)
    assert f["verdict"] == "ok" and m["verdict"] == "ok"
    # the correction that brings the later date back, not its inverse
    assert f["rotationDeg"] == pytest.approx(0.1, abs=0.01)
    assert f["scale"] == pytest.approx(1.003, abs=0.0003)
    assert f["residualPx"] < 0.5 and m["spreadPx"] == f["residualPx"]
    assert f["inliers"] >= 6 and m["tiles"] == f["inliers"]
    # the pivot is mid-site; the reported correction moves every corner where the true one does
    assert abs(f["pivotE"] - ORIGIN[0]) < n * CELL / 6 and abs(f["pivotN"] - ORIGIN[1]) < n * CELL / 6
    got = similarity_of(f)
    for e, nn in corners_en(n):
        ge, gn = got.apply_en(e, nn)
        te, tn = true.apply_en(e, nn)
        assert math.hypot(ge - te, gn - tn) < 0.06
    # lineup.json: the move at the pivot, and the largest move over the overlap
    assert (m["eastM"], m["northM"]) == (f["eastM"], f["northM"])
    assert m["totalM"] == f["maxMoveM"]
    assert f["maxMoveM"] >= math.hypot(f["eastM"], f["northM"])


def test_fit_ignores_changed_patch(tmp_path):
    n = 1024
    a, b, _ = warped(n, 0.1, 1.003, 2.0, 0.0)
    b = b.copy()
    # a quarter of the later date is new ground (a spoil heap, a slab): other texture altogether
    b[: n // 2, : n // 2] = ground(n // 2, n // 2, 77)
    ortho_project(tmp_path, a, b, CELL)
    run(tmp_path)
    f = fit_of(tmp_path)
    assert f["verdict"] == "ok"
    assert f["rotationDeg"] == pytest.approx(0.1, abs=0.01)
    assert f["scale"] == pytest.approx(1.003, abs=0.0003)
    assert f["residualPx"] < 0.5


def test_clustered_tiles_fit_shift_only():
    # a turn field measured on tiles in one corner: too little lever to trust a turn
    rng = np.random.default_rng(3)
    centres = rng.uniform(0, 300, (12, 2))
    th = math.radians(0.5)
    shifts = np.array([[th * c[1], -th * c[0]] for c in centres]) + np.array([1.0, -2.0])
    f = fit_similarity(centres, shifts, shape=(1024, 1024))
    assert f["turned"] is False and (f["a"], f["b"]) == (1.0, 0.0)
    assert f["inliers"] == 12
    # the same through the measurement: only a corner of the grid is valid
    n = 1024
    a, b, _ = warped(n, 0.1, 1.003, 2.0, 0.0)
    valid = np.zeros((n, n), bool)
    valid[:400, :400] = True
    lum = lambda im: im.mean(axis=2)  # noqa: E731
    s = measure_line_up(lum(a), lum(b), valid, CELL)
    assert s["fit"]["turned"] is False and s["fit"]["inliers"] >= 6
    assert len(s["centres"]) == s["tiles"]


def test_aligned_uses_the_largest_move(tmp_path):
    # no shift at the centre, but the turn and scale move the corners more than the tolerance
    n = 1024
    a, b, _ = warped(n, 0.15, 1.003, 0.0, 0.0)
    ortho_project(tmp_path, a, b, CELL)
    m = run(tmp_path)
    f = fit_of(tmp_path)
    assert math.hypot(f["eastM"], f["northM"]) < 2 * CELL
    assert f["maxMoveM"] > 2 * CELL
    assert f["verdict"] == "ok" and m["verdict"] == "ok"


def test_lineup_json_keys_unchanged(tmp_path):
    a, b, _ = warped(1024, 0.1, 1.003, 2.0, 0.0)
    ortho_project(tmp_path, a, b, CELL)
    run_job(pipeline(), tmp_path, params())
    m = measure(tmp_path)
    # an older app parses lineup.json strictly: the turn lives in the sibling file only
    assert set(m) == MEASURE_KEYS
    assert "fit" not in m
    assert set(fit_of(tmp_path)) == FIT_KEYS


# ------------------------------------------------------------------------------------- refused


def test_rotated_copy_is_out_of_range(tmp_path):
    n, pad = 1024, 256
    big = ground(n + 2 * pad, n + 2 * pad, 1)
    a = noisy(big[pad : pad + n, pad : pad + n], 101)
    turned = ndi.rotate(big, 3.0, reshape=False, order=1, mode="nearest")
    b = noisy(turned[pad : pad + n, pad : pad + n], 102)
    ortho_project(tmp_path, a, b, CELL)
    m = run(tmp_path)
    f = fit_of(tmp_path)
    assert f["verdict"] == "range"
    assert abs(f["rotationDeg"]) == pytest.approx(3.0, abs=0.2)
    # an older app knows no range: lineup.json says disagree
    assert m["verdict"] == "disagree"


def test_refuses_a_flat_image(tmp_path):
    flat = np.full((512, 512, 3), 0.5)
    ortho_project(tmp_path, flat, flat.copy(), CELL)
    m = run(tmp_path)
    assert m["verdict"] == "texture"
    assert m["tiles"] < 6


def test_refuses_dates_that_hardly_overlap(tmp_path):
    a, b = dates(512)
    ortho_project(tmp_path, a, b, CELL)
    # the later ortho placed 90 % of its width east: a tenth of it is shared
    path = tmp_path / "rasters" / "ortho-b" / "tiles.json"
    idx = json.loads(path.read_text("utf-8"))
    w = idx["corners"]["tr"][0] - idx["corners"]["tl"][0]
    for k in ("tl", "tr", "bl"):
        idx["corners"][k][0] += 0.9 * w
    path.write_text(json.dumps(idx), "utf-8")
    m = run(tmp_path)
    assert m["verdict"] == "overlap"


def test_answers_aligned_for_dates_already_lined_up(tmp_path):
    a, b = dates(1024, east_m=2.0)
    ortho_project(tmp_path, a, b, CELL)
    mp = tmp_path / "manifest.json"
    man = json.loads(mp.read_text("utf-8"))
    man["captures"][1]["lineUp"] = {"eastM": -2.0, "northM": 0.0, "with": "c1", "at": "2026-10-16T09:00:00Z"}
    mp.write_text(json.dumps(man), "utf-8")
    m = run(tmp_path)
    assert m["verdict"] == "aligned"
    # both dates read where they are lined up: nothing more is needed
    assert abs(m["eastM"]) < 0.05 and abs(m["northM"]) < 0.05


# ----------------------------------------------------------------------------------------- DSMs


def write_dsm(path, heights: np.ndarray, cell: float):
    """Heights as a DSM GeoTIFF in the project CRS, north-west corner at the local origin."""
    import rasterio
    from rasterio.transform import from_origin

    path.parent.mkdir(parents=True, exist_ok=True)
    h, w = heights.shape
    with rasterio.open(
        path,
        "w",
        driver="GTiff",
        height=h,
        width=w,
        count=1,
        dtype="float32",
        crs=f"EPSG:{EPSG}",
        transform=from_origin(ORIGIN[0], ORIGIN[1], cell, cell),
        nodata=-10000,
    ) as d:
        d.write(heights.astype(np.float32), 1)


def test_uses_dsm_slope_without_an_ortho(tmp_path):
    n, pad = 1024, 32
    rng = np.random.default_rng(5)
    bumps = ndi.gaussian_filter(rng.normal(0, 1, (n + 2 * pad, n + 2 * pad)), 3.0)
    terrain = 20.0 + 0.5 * bumps / bumps.std()
    later = moved(terrain, 2.0 / CELL, 0.0)
    a = terrain[pad : pad + n, pad : pad + n] + rng.uniform(-0.005, 0.005, (n, n))
    b = later[pad : pad + n, pad : pad + n] + rng.uniform(-0.005, 0.005, (n, n))
    layers = []
    for lid, cap, hh in (("dsm-a", "c1", a), ("dsm-b", "c2", b)):
        write_dsm(tmp_path / "rasters" / f"{lid}.tif", hh, CELL)
        layers.append(
            {
                "kind": "raster",
                "id": lid,
                "name": f"DSM {cap}",
                "visible": True,
                "capture": cap,
                "role": "dsm",
                "format": "cog",
                "src": {"path": f"rasters/{lid}.tif"},
            }
        )
    (tmp_path / "manifest.json").write_text(json.dumps(manifest(layers)), "utf-8")
    m = run(tmp_path)
    assert m["source"] == "dsm"
    assert (m["layerKeep"], m["layerMove"]) == ("dsm-a", "dsm-b")
    assert m["verdict"] == "ok"
    assert abs(m["eastM"] + 2.0) < 0.05
    assert abs(m["northM"]) < 0.05


# ---------------------------------------------------------------------------------------- params


def test_checks_its_params():
    p = pipeline()
    assert p.validate(params(layerKeep="ortho-a"))["layerKeep"] == "ortho-a"
    with pytest.raises(JobError):
        p.validate({"keep": "c1", "move": "c1"})
    with pytest.raises(JobError):
        p.validate({"keep": "c1"})
    with pytest.raises(JobError):
        p.validate(params(maxShiftPx=2))


def test_says_when_a_date_has_nothing_to_measure(tmp_path):
    a, b = dates(256)
    ortho_project(tmp_path, a, b, CELL)
    mp = tmp_path / "manifest.json"
    man = json.loads(mp.read_text("utf-8"))
    man["layers"] = [x for x in man["layers"] if x["id"] != "ortho-b"]
    mp.write_text(json.dumps(man), "utf-8")
    with pytest.raises(JobError, match="no ortho or DSM"):
        run_job(pipeline(), tmp_path, params())
