"""photo.products (G3): the true orthomosaic on the DSM, its COG and its kit pyramid."""

from __future__ import annotations

import json

import numpy as np
import pytest
import rasterio
from PIL import Image

import products_synth as ps
from aio_pipelines.photo import ortho as O
from aio_pipelines.photo import surface as S
from aio_pipelines.photo.scene import View


def _truth_dsm(tmp_path, res=0.2):
    o = np.array(ps.ORIGIN)
    spec = S.GridSpec.around((o[0] - 30, o[1] - 25), (o[0] + 30, o[1] + 25), res)
    gx, gy = spec.centres(0, 0, spec.width, spec.height)
    z = ps.dsm(gx - o[0], gy - o[1]) + o[2]
    path = tmp_path / "dsm.tif"
    with S.write_tif(path, spec, ps.EPSG, 1, "float32", S.NODATA) as ds:
        ds.write(z.astype(np.float32), 1)
    return path, spec


def _views(tmp_path, darken: int | None = None) -> list[View]:
    s = ps.scene()
    out = []
    for i, (v, img) in enumerate(zip(s.views, s.images, strict=True)):
        p = tmp_path / v.name
        if i == darken:
            img = (img.astype(float) * 0.7).astype(np.uint8)
        Image.fromarray(img).save(p, "PNG")
        out.append(View(v.id, v.name, v.camera, v.r, v.t, p))
    return out


def test_a_footprint_holds_the_photo_centre():
    v = ps.scene().views[5]
    x0, y0, x1, y1 = O.footprint(v, ps.ORIGIN[2])
    c = v.centre
    assert x0 < c[0] < x1 and y0 < c[1] < y1
    assert 30 < x1 - x0 < 60 and 20 < y1 - y0 < 45  # about 43 x 32 m at 34 m


def test_gains_even_out_a_darker_photo(tmp_path):
    dsm, spec = _truth_dsm(tmp_path)
    views = _views(tmp_path, darken=5)
    m = O.Mosaic(views, dsm, spec, O.OrthoSettings(), 512 * 1024**2)
    gains = m.compensate(spec, lambda: None)
    g = np.array([np.mean(gains[v.id]) for v in views])
    rel = g[5] / np.median(np.delete(g, 5))
    assert 1.25 < rel < 1.6  # about 1 / 0.7


def test_a_window_is_true_ortho(tmp_path):
    dsm, dspec = _truth_dsm(tmp_path)
    views = _views(tmp_path)
    m = O.Mosaic(views, dsm, dspec, O.OrthoSettings(), 512 * 1024**2)
    o = np.array(ps.ORIGIN)
    # a window over the building's roof and the ground around it
    spec = S.GridSpec.around((o[0] + 2, o[1] + 1), (o[0] + 18, o[1] + 15), 0.1)
    rgba = m.render(spec, 0, 0, spec.width, spec.height)
    assert (rgba[..., 3] == 255).mean() > 0.99
    gx, gy = spec.centres(0, 0, spec.width, spec.height)
    roof = ps.in_box(gx - o[0], gy - o[1])
    inner = ps.in_box(gx - o[0] - 0.5, gy - o[1] - 0.5) & ps.in_box(gx - o[0] + 0.5, gy - o[1] + 0.5)
    # the roof is lighter grey than the ground (see products_synth): it is drawn where it stands
    lum = rgba[..., :3].astype(float).mean(-1)
    assert lum[inner].mean() > lum[~roof].mean() + 10


@pytest.fixture(scope="module")
def processed():
    return ps.processed()


def _checker_centre(grey: np.ndarray, r: float, c: float, res: float) -> tuple[float, float]:
    """Where four alternating quadrants meet near (r, c): pixel-edge coordinates."""
    win, hs = 20, int(ps.TARGET_SIZE / 2 / res)
    r0, c0 = round(r) - win, round(c) - win
    patch = grey[r0 : r0 + 2 * win + 1, c0 : c0 + 2 * win + 1]
    best, pos = -1.0, (0, 0)
    for dy in range(hs, 2 * win + 1 - hs):
        for dx in range(hs, 2 * win + 1 - hs):
            q = (
                patch[dy - hs : dy, dx : dx + hs].mean()
                + patch[dy : dy + hs, dx - hs : dx].mean()
                - patch[dy - hs : dy, dx - hs : dx].mean()
                - patch[dy : dy + hs, dx : dx + hs].mean()
            )
            if abs(q) > best:
                best, pos = abs(q), (dy, dx)
    return r0 + pos[0] - 0.5, c0 + pos[1] - 0.5


def test_targets_sit_where_they_were_surveyed(processed):
    root, _, _ = processed
    with rasterio.open(root / "photogrammetry" / ps.RUN / "ortho.tif") as ds:
        assert ds.tags(ns="IMAGE_STRUCTURE").get("LAYOUT") == "COG"
        assert ds.count == 4 and ds.crs.to_epsg() == ps.EPSG and ds.overviews(1)
        grey = ds.read([1, 2, 3]).astype(float).mean(0)
        t = ds.transform
    o = np.array(ps.ORIGIN)
    for tx, ty in ps.TARGETS:
        c = (tx + o[0] - t.c) / t.a - 0.5
        r = (t.f - (ty + o[1])) / t.a - 0.5
        rr, cc = _checker_centre(grey, r, c, t.a)
        assert np.hypot(rr - r, cc - c) * t.a < 2 * ps.GSD, (tx, ty)


def test_the_ortho_pyramid_is_placed_in_the_project_frame(processed):
    root, _, _ = processed
    lid = f"{ps.RUN}-ortho"
    idx = json.loads((root / "rasters" / lid / "tiles.json").read_text("utf-8"))
    assert idx["schema"] == "aio.tiles/1" and idx["crs"] == {"epsg": ps.EPSG}
    left, top = idx["topLeft"]
    tl = idx["corners"]["tl"]
    assert tl[0] == pytest.approx(left - ps.ORIGIN[0], abs=1e-6)
    assert tl[2] == pytest.approx(-(top - ps.ORIGIN[1]), abs=1e-6)
    assert -2 < tl[1] < 2  # drawn at the ground's height in the local frame
    for lv in idx["levels"]:
        assert lv["pattern"] == f"rasters/{lid}/{lv['z']}/{{x}}_{{y}}.webp"
        for x in range(lv["cols"]):
            for y in range(lv["rows"]):
                assert (root / lv["pattern"].format(x=x, y=y)).is_file()
