"""True orthomosaic: every output pixel is a ground point on the DSM, coloured from the best photo
that sees it. Our own code on GDAL (rasterio), window by window, in bounded memory.

Per output window (``BLOCK`` pixels square at the ortho cell size):

1. **Ground.** The pixel centres get their height from the DSM (bilinear), so roofs and piles
   are placed where they stand, not where they lean in a photo (true ortho).
2. **Candidates.** Photos whose ground footprint touches the window.
3. **Visibility.** Each photo has an occlusion buffer: the DSM drawn into it (z-buffer, a quarter
   of the photo's size). A ground point hidden behind a wall in a photo is not taken from it.
4. **Selection.** Per pixel the photo seen most from above (the angle of the ray from the
   vertical) and nearest its image centre wins; the choice is made on a coarse grid and smoothed
   (majority over a neighbourhood), so seams run in few, long lines and a target stays in one
   photo.
5. **Blending.** Across a seam, the photos are feathered over ``feather`` pixels; colours are
   balanced by a gain per photo and channel (least squares over the overlaps, as OpenCV's
   ``GainCompensator`` does), which also evens the white balance.

The result is an RGBA GeoTIFF in the project CRS, then a COG (``ortho.tif``) and the viewers'
``kit-pyramid`` (``road/ortho.py`` builds it from the COG, as the road pipeline does).
"""

from __future__ import annotations

import math
from collections import OrderedDict
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np

from .scene import Camera, View, load_image
from .surface import GridSpec, read_grid, read_window, write_tif

BLOCK = 1024
OCC_SCALE = 0.25


@dataclass(frozen=True)
class OrthoSettings:
    feather: int = 12
    #: the selection grid is this many output pixels per cell
    label_cell: int = 8
    #: occlusion tolerance, fraction of the depth
    occlusion: float = 0.01


class _Lru(OrderedDict):
    def __init__(self, capacity: int):
        super().__init__()
        self.capacity = max(1, capacity)

    def get_or(self, key, make: Callable[[], Any]):
        if key in self:
            self.move_to_end(key)
            return self[key]
        v = make()
        self[key] = v
        while len(self) > self.capacity:
            self.popitem(last=False)
        return v


def footprint(view: View, ground_h: float) -> tuple[float, float, float, float]:
    """Ground box (x0, y0, x1, y1) the photo sees at height ``ground_h`` (rays to that plane)."""
    cam = view.camera
    xs = np.array([0, cam.width / 2, cam.width, cam.width, cam.width, cam.width / 2, 0, 0], float)
    ys = np.array([0, 0, 0, cam.height / 2, cam.height, cam.height, cam.height, cam.height / 2], float)
    d = cam.rays(xs, ys) @ view.r  # world directions
    c = view.centre
    with np.errstate(divide="ignore", invalid="ignore"):
        t = (ground_h - c[2]) / d[:, 2]
    t = np.where(t > 0, t, np.nan)
    if not np.isfinite(t).any():
        return (np.inf, np.inf, -np.inf, -np.inf)
    t = np.where(np.isfinite(t), t, np.nanmax(t) * 4)
    p = c + d * t[:, None]
    return float(p[:, 0].min()), float(p[:, 1].min()), float(p[:, 0].max()), float(p[:, 1].max())


def sample_dsm(dsm_path: Path, dsm_spec: GridSpec, gx: np.ndarray, gy: np.ndarray) -> np.ndarray:
    """DSM heights (bilinear, NaN outside or empty) at ground points."""
    from scipy import ndimage

    cx = (gx - dsm_spec.x0) / dsm_spec.res - 0.5
    cy = (dsm_spec.y1 - gy) / dsm_spec.res - 0.5
    c0, r0 = math.floor(cx.min()) - 1, math.floor(cy.min()) - 1
    c1, r1 = math.ceil(cx.max()) + 2, math.ceil(cy.max()) + 2
    block = read_window(dsm_path, c0, r0, c1 - c0, r1 - r0)
    ok = np.isfinite(block)
    filled = np.where(ok, block, 0.0)
    v = ndimage.map_coordinates(filled, [cy - r0, cx - c0], order=1, mode="nearest")
    w = ndimage.map_coordinates(ok.astype(np.float64), [cy - r0, cx - c0], order=1, mode="nearest")
    with np.errstate(invalid="ignore", divide="ignore"):
        out = np.where(w > 0.99, v / np.maximum(w, 1e-9), np.nan)
    return out


class Mosaic:
    def __init__(
        self,
        views: list[View],
        dsm_path: Path,
        dsm_spec: GridSpec,
        settings: OrthoSettings,
        budget: int,
        image_scale: float = 1.0,
    ):
        self.views = views
        self.dsm_path = dsm_path
        self.dsm_spec = dsm_spec
        self.s = settings
        self.scale = image_scale
        lo, _ = _robust_range(read_grid(dsm_path, _small(dsm_spec)))
        self.ground_h = lo
        self.boxes = {v.id: footprint(v, lo) for v in views}
        px = max(v.camera.width * v.camera.height for v in views) * image_scale**2
        per_image = px * 3 + px * OCC_SCALE**2 * 4
        self.cache = _Lru(int(max(2, min(64, budget * 0.5 // max(1, per_image)))))
        self.gains: dict[int, np.ndarray] = {v.id: np.ones(3) for v in views}

    # photos, occlusion buffers ------------------------------------------------------------------
    def image(self, v: View) -> np.ndarray:
        return self.cache.get_or(("img", v.id), lambda: load_image(v.path, self.scale))

    def cam(self, v: View) -> Camera:
        return v.camera.scaled(self.scale) if self.scale != 1 else v.camera

    def occlusion(self, v: View) -> tuple[Camera, np.ndarray]:
        def make():
            cam = v.camera.scaled(OCC_SCALE * self.scale)
            x0, y0, x1, y1 = self.boxes[v.id]
            pad = 0.1 * max(x1 - x0, y1 - y0)
            fp = max(0.01, (v.centre[2] - self.ground_h) / max(cam.fx, 1.0))
            step = max(self.dsm_spec.res, fp / 2)
            gx, gy = np.meshgrid(np.arange(x0 - pad, x1 + pad, step), np.arange(y0 - pad, y1 + pad, step))
            gz = sample_dsm(self.dsm_path, self.dsm_spec, gx.ravel(), gy.ravel())
            ok = np.isfinite(gz)
            pts = np.column_stack([gx.ravel()[ok], gy.ravel()[ok], gz[ok]])
            depth = np.full(cam.width * cam.height, np.inf)
            if len(pts):
                x, y, z = v.project(pts, cam)
                inside = (z > 0) & (x >= 0) & (y >= 0) & (x < cam.width) & (y < cam.height)
                idx = np.floor(y[inside]).astype(np.int64) * cam.width + np.floor(x[inside]).astype(np.int64)
                np.minimum.at(depth, idx, z[inside])
            from scipy import ndimage

            d = depth.reshape(cam.height, cam.width)
            # close pinholes between splatted samples with the nearest surface around them
            hole = np.isinf(d)
            d = np.where(hole, ndimage.minimum_filter(d, size=3), d)
            return cam, d

        return self.cache.get_or(("occ", v.id), make)

    # gains --------------------------------------------------------------------------------------
    def compensate(
        self, spec: GridSpec, check: Callable[[], None], samples: int = 120
    ) -> dict[int, list[float]]:
        """Gain per photo and channel from colours of shared ground points (least squares)."""
        x0, y0, x1, y1 = spec.bounds
        step = max(spec.res, max(x1 - x0, y1 - y0) / samples)
        gx, gy = np.meshgrid(np.arange(x0 + step / 2, x1, step), np.arange(y0 + step / 2, y1, step))
        gx, gy = gx.ravel(), gy.ravel()
        gz = sample_dsm(self.dsm_path, self.dsm_spec, gx, gy)
        ok = np.isfinite(gz)
        pts = np.column_stack([gx[ok], gy[ok], gz[ok]])
        n = len(self.views)
        cols = np.full((n, len(pts), 3), np.nan)
        for i, v in enumerate(self.views):
            check()
            vis, x, y = self._visible(v, pts)
            if vis.any():
                img = load_image(v.path, min(1.0, 0.25 * self.scale))
                f = img.shape[1] / v.camera.width
                xi = np.clip((x[vis] * f).astype(int), 0, img.shape[1] - 1)
                yi = np.clip((y[vis] * f).astype(int), 0, img.shape[0] - 1)
                cols[i, vis] = img[yi, xi]
        gains = {}
        sn, sg = 10.0, 0.1  # OpenCV's GainCompensator defaults: error and gain sigmas
        for ch in range(3):
            a = np.zeros((n, n))
            b = np.zeros(n)
            for i in range(n):
                for j in range(n):
                    if i == j:
                        continue
                    both = np.isfinite(cols[i, :, ch]) & np.isfinite(cols[j, :, ch])
                    nij = int(both.sum())
                    if nij < 10:
                        continue
                    ii, ij = cols[i, both, ch].mean(), cols[j, both, ch].mean()
                    a[i, i] += nij * (2 * ii * ii / sn**2 + 1 / sg**2)
                    a[i, j] -= nij * 2 * ii * ij / sn**2
                    b[i] += nij / sg**2
            for i in range(n):
                if a[i, i] == 0:
                    a[i, i], b[i] = 1.0, 1.0
            g = np.linalg.solve(a, b)
            for i, v in enumerate(self.views):
                gains.setdefault(v.id, np.ones(3))[ch] = float(np.clip(g[i], 0.5, 2.0))
        self.gains = {k: np.asarray(v) for k, v in gains.items()}
        return {k: [round(float(x), 4) for x in v] for k, v in self.gains.items()}

    # one window ---------------------------------------------------------------------------------
    def _visible(self, v: View, pts: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        """Which ground points photo ``v`` sees, and their pixel positions (photo's full size)."""
        cam = v.camera
        x, y, z = v.project(pts, cam)
        inside = (z > 0) & (x >= 0.5) & (y >= 0.5) & (x < cam.width - 0.5) & (y < cam.height - 0.5)
        ocam, occ = self.occlusion(v)
        f = ocam.width / cam.width
        oi = np.clip(np.floor(x * f).astype(np.int64), 0, ocam.width - 1)
        oj = np.clip(np.floor(y * f).astype(np.int64), 0, ocam.height - 1)
        with np.errstate(invalid="ignore"):
            front = z <= occ[oj, oi] * (1 + self.s.occlusion) + 0.05
        return inside & front, x, y

    def render(self, spec: GridSpec, c0: int, r0: int, w: int, h: int) -> np.ndarray:
        from scipy import ndimage

        gx, gy = spec.centres(c0, r0, w, h)
        gz = sample_dsm(self.dsm_path, self.dsm_spec, gx.ravel(), gy.ravel()).reshape(h, w)
        out = np.zeros((h, w, 4), np.uint8)
        have = np.isfinite(gz)
        if not have.any():
            return out
        bx0, by0, bx1, by1 = gx.min(), gy.min(), gx.max(), gy.max()
        cands = [
            v
            for v in self.views
            if not (
                self.boxes[v.id][2] < bx0
                or self.boxes[v.id][0] > bx1
                or self.boxes[v.id][3] < by0
                or self.boxes[v.id][1] > by1
            )
        ]
        if not cands:
            return out
        pts = np.column_stack([gx.ravel(), gy.ravel(), np.where(have, gz, 0).ravel()])
        scores = np.full((len(cands), h * w), -np.inf, np.float32)
        pix: list[tuple[np.ndarray, np.ndarray, np.ndarray]] = []
        for k, v in enumerate(cands):
            vis, x, y = self._visible(v, pts)
            vis &= have.ravel()
            ray = v.centre - pts
            cos_t = ray[:, 2] / np.maximum(np.linalg.norm(ray, axis=1), 1e-9)
            cam = v.camera
            rr = np.hypot((x - cam.width / 2) / cam.width, (y - cam.height / 2) / cam.height) / 0.7071
            scores[k] = np.where(vis, cos_t - 0.25 * rr, -np.inf)
            pix.append((vis, x, y))
        # selection on a coarse grid, smoothed by a majority filter, then checked per pixel
        cell = self.s.label_cell
        hc, wc = math.ceil(h / cell), math.ceil(w / cell)
        pad = np.full((len(cands), hc * cell, wc * cell), -np.inf, np.float32)
        pad[:, :h, :w] = scores.reshape(len(cands), h, w)
        coarse = pad.reshape(len(cands), hc, cell, wc, cell).max(axis=(2, 4))
        lab = np.argmax(coarse, axis=0)
        none = ~np.isfinite(coarse.max(axis=0))
        if len(cands) > 1:
            votes = np.stack(
                [ndimage.uniform_filter((lab == k).astype(np.float32), size=3) for k in range(len(cands))]
            )
            votes[:, none] = 0
            votes = np.where(np.isfinite(coarse), votes, -1)
            lab = np.argmax(votes, axis=0)
        full = np.repeat(np.repeat(lab, cell, 0), cell, 1)[:h, :w].ravel()
        best = np.argmax(scores, axis=0)
        ok_full = np.isfinite(scores[full, np.arange(h * w)])
        label = np.where(ok_full, full, best)
        anyvis = np.isfinite(scores.max(axis=0))
        # feathered blend over the seams
        acc = np.zeros((h * w, 3))
        wsum = np.zeros(h * w)
        used = np.unique(label[anyvis])
        for k in used:
            vis, x, y = pix[k]
            wk = (label == k).astype(np.float32).reshape(h, w)
            if self.s.feather > 0 and len(used) > 1:
                wk = ndimage.uniform_filter(wk, size=2 * self.s.feather + 1)
            wk = wk.ravel() * vis
            sel = wk > 1e-4
            if not sel.any():
                continue
            v = cands[k]
            img = self.image(v)
            f = img.shape[1] / v.camera.width
            xs, ys = x[sel] * f - 0.5, y[sel] * f - 0.5
            col = np.stack(
                [ndimage.map_coordinates(img[..., ch], [ys, xs], order=1, mode="nearest") for ch in range(3)],
                1,
            ) * self.gains.get(v.id, np.ones(3))
            acc[sel] += col * wk[sel, None]
            wsum[sel] += wk[sel]
        okp = (wsum > 0) & anyvis
        rgb = np.zeros((h * w, 3))
        rgb[okp] = acc[okp] / wsum[okp, None]
        out[..., :3] = np.clip(np.round(rgb), 0, 255).reshape(h, w, 3)
        out[..., 3] = np.where(okp, 255, 0).reshape(h, w)
        return out


def _small(spec: GridSpec, side: int = 512) -> tuple[int, int] | None:
    f = max(spec.width, spec.height) / side
    if f <= 1:
        return None
    return max(1, round(spec.height / f)), max(1, round(spec.width / f))


def _robust_range(z: np.ndarray) -> tuple[float, float]:
    ok = z[np.isfinite(z)]
    if not ok.size:
        return 0.0, 1.0
    lo, hi = np.percentile(ok, [2, 98])
    return float(lo), float(hi)


def orthomosaic(
    mosaic: Mosaic,
    spec: GridSpec,
    out: Path,
    epsg: int | None,
    check: Callable[[], None],
    progress: Callable[[float, str | None], None],
    block: int = BLOCK,
) -> dict[str, Any]:
    """Write the RGBA orthomosaic GeoTIFF window by window; return coverage and the photos used."""
    from rasterio.enums import ColorInterp
    from rasterio.windows import Window

    wins = list(spec.windows(block))
    covered = 0
    with write_tif(out, spec, epsg, 4, "uint8") as ds:
        ds.colorinterp = [ColorInterp.red, ColorInterp.green, ColorInterp.blue, ColorInterp.alpha]
        for i, (c0, r0, w, h) in enumerate(wins):
            check()
            rgba = mosaic.render(spec, c0, r0, w, h)
            covered += int((rgba[..., 3] > 0).sum())
            ds.write(np.moveaxis(rgba, -1, 0), window=Window(c0, r0, w, h))
            progress((i + 1) / len(wins), f"Ortho window {i + 1} of {len(wins)}")
    return {"coverage": round(covered / max(1, spec.width * spec.height), 4), "windows": len(wins)}
