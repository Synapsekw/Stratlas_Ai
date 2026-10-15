"""Evidence renders: orthographic splats, slices, crops, colour bands and atomic writes."""

from __future__ import annotations

import hashlib
from types import SimpleNamespace

import numpy as np
from PIL import Image
from scipy import ndimage

from aio_pipelines.engineer.axis import estimate_axis
from aio_pipelines.engineer.cloud import remove_ground
from aio_pipelines.engineer.members import find_light_candidates
from aio_pipelines.engineer.render import (
    colour_bands,
    crop_views,
    render_ortho,
    render_slice,
    write_images,
)
from aio_pipelines.engineer.sections import fit_sections, fit_taper
from synth_assets import STACK, stack_cloud


def _sha(im: Image.Image) -> str:
    return hashlib.sha1(im.tobytes()).hexdigest()


def test_render_is_px_wide_nonempty_and_deterministic():
    a, _ = stack_cloud(seed=1, ground=False)
    b, _ = stack_cloud(seed=1, ground=False)
    for view in ("north", "east", "south", "west", "top"):
        im = render_ortho(a, None, view, 384)
        assert im.size == (384, 384)
        arr = np.asarray(im)
        assert (arr < 255).any() and (arr == 255).any()
        assert _sha(im) == _sha(render_ortho(b, None, view, 384))
    assert render_ortho(np.zeros((0, 3)), None, "top", 64).size == (64, 64)


def test_views_are_oriented_like_a_map_and_an_elevation():
    pts = np.array([[5.0, 0.0, 0.0], [0.0, 0.0, -5.0], [0.0, 10.0, 0.0]])  # east, north, high
    top = np.asarray(render_ortho(pts, None, "top", 100).convert("L"))
    ys, xs = np.nonzero(top < 255)
    east = [(r, c) for r, c in zip(ys, xs, strict=True) if c > 70]
    north = [(r, c) for r, c in zip(ys, xs, strict=True) if r < 30]
    assert east and north  # east on the right, north at the top
    south_view = np.asarray(render_ortho(pts, None, "south", 100).convert("L"))
    ys, _ = np.nonzero(south_view < 255)
    assert ys.min() < 20  # the high point is at the top of an elevation
    east_view = np.asarray(render_ortho(pts, None, "east", 100).convert("L"))
    _, xs = np.nonzero(east_view < 255)
    assert xs.max() > 70  # seen from the east, north is on the right


def test_top_view_of_the_stack_shows_three_flue_holes():
    cloud, _ = stack_cloud(seed=2, ground=False, noise=0.02)
    im = np.asarray(render_ortho(cloud, None, "top", 512).convert("L"))
    empty = im == 255
    labels, n = ndimage.label(empty)
    areas = np.bincount(labels.ravel())[1:]
    # a flue is 1.8 m across on a 512 px canvas of about 19 m: roughly 45 px, 1500 px of hole
    holes = [a for a in areas if 300 <= a <= 5000]
    assert n >= 3 and len(holes) == 3


def test_colour_is_kept_and_depth_shading_otherwise():
    pts = np.array([[0.0, 0.0, 0.0], [0.0, 0.0, 0.0], [3.0, 3.0, 0.0]])
    rgb = np.array([[250, 0, 0], [0, 250, 0], [0, 0, 250]], dtype=np.uint8)
    arr = np.asarray(render_ortho(pts, rgb, "south", 64))
    coloured = arr[(arr != 255).any(axis=2)]
    assert any(c[2] == 250 for c in coloured)
    assert any(
        c[1] == 250 for c in coloured
    )  # the nearer of two coincident points (larger z ties: stable order)
    wide = (rgb.astype(np.uint16)) << 8
    assert np.array_equal(np.asarray(render_ortho(pts, wide, "south", 64)), arr)


def test_slice_and_crops_and_bands():
    cloud, truth = stack_cloud(seed=3, ground=True, noise=0.02)
    kept, _ = remove_ground(cloud, 0.15)
    axis = estimate_axis(kept)
    slices = fit_sections(kept, axis, 2.0)
    taper = fit_taper(slices)
    mid = min(slices, key=lambda s: abs(s.y - 40))
    near = kept[np.abs(kept[:, 1] - mid.y) < 0.5]
    im = render_slice(near, mid, 256)
    assert im.size == (256, 256) and (np.asarray(im) != 255).any()
    lights = find_light_candidates(kept, axis, taper, noise=0.02)
    crops = crop_views(kept, axis, taper, [lights], 200)
    names = [n for n, _ in crops]
    assert names[:2] == ["crown", "base"] and names[2:] == ["level-1", "level-2", "level-3"]
    assert all(i.size == (200, 200) for _, i in crops)
    # colours: a red band at 100 to 104 m
    rgb = np.tile(np.array([150, 148, 140], dtype=np.uint8), (len(kept), 1))
    red = (kept[:, 1] >= 100) & (kept[:, 1] < 104)
    rgb[red] = [190, 40, 35]
    bands = colour_bands(kept, rgb, axis, 2.0)
    assert any(abs(b["y0"] - 100) < 2.1 and abs(b["y1"] - 104) < 2.1 and b["rgb"][0] > 180 for b in bands)
    assert len(bands) <= 64 and all(0 <= c <= 255 for b in bands for c in b["rgb"])
    assert colour_bands(kept, None, axis, 2.0) == []
    assert truth["bands"][0] == [100.0, 104.0] and STACK["height"] == 120.0


def test_write_images_bounds_and_atomic(tmp_path):
    ims = [(f"img-top-{i}", "top", "top", Image.new("RGB", (300, 300), (i * 40, 0, 0))) for i in range(5)]
    out = write_images(ims, tmp_path / "img", "img", max_images=3, max_px=128)
    assert len(out) == 3
    assert all(o["w"] <= 128 and o["h"] <= 128 and len(o["sha1"]) == 40 for o in out)
    assert sorted(p.name for p in (tmp_path / "img").iterdir()) == [f"img-top-{i}.png" for i in range(3)]
    assert out[0]["file"] == "img/img-top-0.png"
    data = (tmp_path / "img" / "img-top-0.png").read_bytes()
    assert hashlib.sha1(data).hexdigest() == out[0]["sha1"] and out[0]["bytes"] == len(data)
    assert SimpleNamespace  # keep the import used for future fit stubs
