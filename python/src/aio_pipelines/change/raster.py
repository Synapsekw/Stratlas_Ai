"""change.raster: two orthos of the same area to a change heat map, polygons and region items.

Parameters as ``ChangeRasterParams`` in ``@aio/schema`` (``jobs.ts``). Steps:

1. read     both orthos onto a common grid over the area both cover (the coarser pixel size, or
            coarser still for very large orthos), from the matching pyramid level, band by band;
2. register the co-registration check (``register.py``): refuse beyond ``maxShiftPx`` (default
            2 px), otherwise move the later date back by the measured shift;
3. compare  an illumination-robust change score (below), threshold, morphological clean-up,
            minimum area, polygons; the heat map pyramid, the polygons GeoJSON and the change set
            are staged;
4. commit   ``change/<id>/`` (heat map, polygons), ``change/<id>.json`` (reviews of an earlier run
            kept, ``.bak``), then the manifest: a heat map raster layer and a polygon layer, both
            ``derived`` and on the later date.

The score (0 to 1) ignores what light does: the later ortho is scaled per channel to the earlier
one (a gain over the shared area, so a tint or exposure change is gone); structure is compared on
high-passed log brightness with a local SSIM-like term, which a shade or a cloud shadow (a slow
multiplicative change) does not move; colour is compared as chromaticity, which shade does not
change either. Methods: ``gradient`` (structure and colour, the default), ``ssim`` (scikit-image's
structural similarity on normalised brightness, and colour) and ``rgb`` (plain colour distance,
sensitive to light). Every region is a proposal (verdict ``changed``) a person confirms.
"""

from __future__ import annotations

from typing import Any

import numpy as np

from ..params import known_keys, number, text
from ..runtime import JobError, Step, StepContext, input_fingerprint
from .changeset import change_set, change_set_id
from .imagery import (
    Grid,
    Ortho,
    cell_for,
    check_captures,
    colour_ramp,
    commit_run,
    derived,
    find_layer,
    intersect,
    load_arrays,
    outline,
    polygons,
    read_manifest,
    ring_mask,
    save_arrays,
    union,
    write_pyramid,
)
from .register import estimate_shift, refusal, registration

PRODUCER = "change.raster"
METHODS = ("gradient", "ssim", "rgb")
#: The founder's `conservative` preset (``ChangeThresholds.raster``); the app sends its own values.
DEFAULT_THRESHOLD = 0.5
DEFAULT_MIN_AREA_M2 = 2.0
DEFAULT_MAX_SHIFT_PX = 2.0
#: Heat map: transparent below the floor, then yellow to red.
SCORE_STOPS: list[tuple[float, str, float]] = [
    (0.0, "#ffd34d", 0.0),
    (0.2, "#ffd34d", 0.0),
    (0.35, "#ffd34d", 0.45),
    (0.6, "#ff8a00", 0.7),
    (1.0, "#e8202a", 0.85),
]
LEGEND = {
    "kind": "score",
    "unit": "",
    "label": "Change score",
    "stops": [[v, c] for v, c, a in SCORE_STOPS if a > 0],
}
REGION_STYLE = {
    "line": {"color": "#e8202a", "width": 2},
    "fill": {"color": "#e8202a", "opacity": 0.12},
}
INPUTS_CHANGED = "The orthos changed since this job started. Start the job again."
LUMA = np.array([0.299, 0.587, 0.114], np.float32)
#: The structure term's noise floor, in units of the noise measured between the two dates: noise
#: alone then scores about 1 / (1 + NOISE_FLOOR), 0.17, near half the sensitive preset's 0.3.
NOISE_FLOOR = 5.0
#: A region is light only when it kept its colour (three quarters of it below this colour score,
#: a chromaticity step of 0.03) and its brightness moved one way by at least this (log, 2 %).
LIGHT_COLOUR = 0.25
LIGHT_STEP = 0.02


# ------------------------------------------------------------------------------------------ score


def normalise(a: np.ndarray, b: np.ndarray, valid: np.ndarray) -> np.ndarray:
    """``b`` with each channel scaled to ``a`` over ``valid`` (by the ratio of the medians, so a
    changed area does not tilt the match).

    Exposure and white balance multiply each channel (in linear light, and so in gamma-encoded
    values too), so a gain is the right match: a level-and-spread match would add an offset that
    shifts the colour of everything darker or lighter than the median, such as shadows.
    """
    out = b.copy()
    if valid.sum() < 16:
        return out
    for k in range(3):
        ma, mb = float(np.median(a[..., k][valid])), float(np.median(b[..., k][valid]))
        out[..., k] = b[..., k] * (ma / mb if mb > 1e-6 else 1.0)
    return np.clip(out, 0, 1)


def _local_stats(x: np.ndarray, y: np.ndarray, sigma: float):
    from scipy import ndimage as ndi

    mx, my = ndi.gaussian_filter(x, sigma), ndi.gaussian_filter(y, sigma)
    vx = ndi.gaussian_filter(x * x, sigma) - mx * mx
    vy = ndi.gaussian_filter(y * y, sigma) - my * my
    cxy = ndi.gaussian_filter(x * y, sigma) - mx * my
    return np.clip(vx, 0, None), np.clip(vy, 0, None), cxy


def structure_change(
    la: np.ndarray, lb: np.ndarray, sigma: float = 2.0, valid: np.ndarray | None = None
) -> np.ndarray:
    """0 where two brightness grids have the same local structure, 1 where it differs.

    Works on high-passed log brightness, so shade and exposure (multiplicative and slow) drop out;
    the SSIM-like term ``(2 cov + C) / (var_a + var_b + C)`` also sees texture appear or vanish.

    ``C`` is the noise floor, per cell: texture finer than the noise and compression of the two
    orthos must not count. In log brightness that noise grows as a place gets darker (its variance
    goes as 1 / brightness, as for photon noise and for the compression of real orthos), so ``C``
    is ``NOISE_FLOOR`` times the noise expected of the cell's brightness on both dates, its scale
    measured from the scene: the median difference energy, which changed areas do not move. A
    fraction of the scene's typical texture energy stays as a lower bound. Both are measured over
    ``valid`` (default: everywhere).
    """
    from scipy import ndimage as ndi

    from .register import highpass

    ha, hb = highpass(la, 1.5), highpass(lb, 1.5)
    va, vb, cab = _local_stats(ha, hb, sigma)
    at = np.ones(la.shape, bool) if valid is None or not valid.any() else valid
    # how much noise each cell's brightness brings on the two dates (up to a common scale)
    dark = 1 / np.clip(ndi.gaussian_filter(la, sigma), 0.02, None)
    dark += 1 / np.clip(ndi.gaussian_filter(lb, sigma), 0.02, None)
    scale = float(np.median((ndi.gaussian_filter((ha - hb) ** 2, sigma) / dark)[at]))
    texture = float(np.median((va + vb)[at]))
    c = np.maximum(max(1e-5, 0.25 * texture), NOISE_FLOOR * scale * dark)
    sim = (2 * cab + c) / (va + vb + c)
    return np.clip(1 - sim, 0, 1)


def colour_change(a: np.ndarray, b: np.ndarray, full: float = 0.12) -> np.ndarray:
    """Chromaticity distance (shade changes brightness, not chromaticity), 1 at ``full``."""
    from scipy import ndimage as ndi

    def chroma(x):
        s = x.sum(axis=2, keepdims=True)
        c = x / np.maximum(s, 1e-3)
        return np.stack([ndi.gaussian_filter(c[..., k], 1.0) for k in range(3)], axis=2), s[..., 0]

    ca, sa = chroma(a)
    cb, sb = chroma(b)
    d = np.sqrt(((ca - cb) ** 2).sum(axis=2)) / full
    # very dark pixels have no reliable colour
    d = np.where(np.minimum(sa, sb) < 0.15, 0, d)
    return np.clip(d, 0, 1)


def change_score(
    a: np.ndarray, b: np.ndarray, valid: np.ndarray, method: str = "gradient", stats: np.ndarray | None = None
) -> tuple[np.ndarray, np.ndarray]:
    """The per-cell change score, 0 to 1 (NaN outside ``valid``), and ``b`` normalised to ``a``.

    The colour match is fitted where the structure did not change (``stats``, default ``valid``),
    so a large new object does not shift the colours of everything else.
    """
    from scipy import ndimage as ndi

    stats = valid if stats is None else stats
    la0, lb0 = a @ LUMA, b @ LUMA
    struct = structure_change(la0, lb0, valid=stats)
    stable = stats & (struct < 0.3)
    b = normalise(a, b, stable if stable.sum() >= 0.1 * max(1, stats.sum()) else stats)
    la, lb = a @ LUMA, b @ LUMA
    if method == "rgb":
        s = np.sqrt(((a - b) ** 2).sum(axis=2)) / 0.35
    elif method == "ssim":
        from skimage.metrics import structural_similarity

        _, ssim = structural_similarity(la, lb, data_range=1.0, gaussian_weights=True, sigma=2.0, full=True)
        s = np.maximum(np.clip(1 - ssim, 0, 1), colour_change(a, b))
    else:
        s = np.maximum(struct, colour_change(a, b))
    s = ndi.gaussian_filter(np.clip(s, 0, 1).astype(np.float32), 1.0)
    return np.where(valid, s, np.nan).astype(np.float32), b


def brightness_ratio(a: np.ndarray, b: np.ndarray, valid: np.ndarray) -> tuple[np.ndarray, float]:
    """Log of ``b`` over ``a`` in brightness (lightly smoothed) and its noise (a robust spread)."""
    from scipy import ndimage as ndi

    la, lb = np.clip(a @ LUMA, 1e-3, None), np.clip(b @ LUMA, 1e-3, None)
    q = ndi.gaussian_filter(np.log(lb) - np.log(la), 1.0)
    if not valid.any():
        return q, 0.0
    v = q[valid]
    return q, float(1.4826 * np.median(np.abs(v - np.median(v))))


def lighting_only(q: np.ndarray, noise: float, colour: np.ndarray, reg: np.ndarray) -> bool:
    """Whether a region is a change of light only: it got darker (or lighter) and kept its colour.

    A shadow that comes or goes (a cloud, the sun lower or turned) darkens or lightens what it
    falls on and keeps its colour; where it falls on ground next to a lit object it can even hide
    the edge between them. Something new, gone or moved changes the colour, or the brightness both
    ways (a stockpile's lit and shaded sides), so it is kept.
    """
    qq = q[reg]
    step = max(3 * noise, LIGHT_STEP)
    darker, lighter = float((qq < -step).mean()), float((qq > step).mean())
    if max(darker, lighter) < 0.5 or min(darker, lighter) > 0.1 * max(darker, lighter):
        return False
    return float(np.percentile(colour[reg], 75)) < LIGHT_COLOUR


def change_mask(
    a: np.ndarray,
    b: np.ndarray,
    score: np.ndarray,
    threshold: float,
    min_cells: int,
    lighting: bool = True,
) -> np.ndarray:
    """The changed cells: threshold, clean-up, then each region's edge refined on the colour step.

    The score is smooth (it compares neighbourhoods), so its regions are a little too large; each
    region's edge is moved to where the plain colour difference falls to half its value inside
    the region, which puts a painted square's edge back on its pixels. With ``lighting``, a region
    that is a change of light only (``lighting_only``) is left out.
    """
    from scipy import ndimage as ndi

    disk = ndi.generate_binary_structure(2, 1)
    m = np.nan_to_num(score, nan=0) >= threshold
    m = ndi.binary_opening(m, structure=disk, iterations=2)
    m = ndi.binary_closing(m, structure=disk, iterations=2)
    m = ndi.binary_fill_holes(m)
    labels, n = ndi.label(m)
    if n == 0:
        return m
    if lighting:
        q, noise = brightness_ratio(a, b, np.isfinite(score))
        colour = colour_change(a, b)
    diff = ndi.gaussian_filter(np.sqrt(((a - b) ** 2).sum(axis=2)), 0.7)
    out = np.zeros_like(m)
    rows, cols = m.shape
    pad = 8  # the refinement grows a region by 3 cells and closes by 2: room enough around it
    for i, box in enumerate(ndi.find_objects(labels), start=1):
        if box is None:
            continue
        # each region in its own window, so a scene of many regions stays fast
        win = (
            slice(max(0, box[0].start - pad), min(rows, box[0].stop + pad)),
            slice(max(0, box[1].start - pad), min(cols, box[1].stop + pad)),
        )
        reg = labels[win] == i
        if reg.sum() < min_cells:
            continue
        if lighting and lighting_only(q[win], noise, colour[win], reg):
            continue
        d = diff[win]
        core = ndi.binary_erosion(reg, structure=disk, iterations=3)
        if core.sum() < 16:
            core = reg
        level = 0.5 * float(np.median(d[core]))
        grown = ndi.binary_dilation(reg, structure=disk, iterations=3)
        fine = grown & (d > level)
        fine = ndi.binary_opening(fine, structure=disk, iterations=1)
        fine = ndi.binary_fill_holes(ndi.binary_closing(fine, structure=disk, iterations=2))
        lab, k = ndi.label(fine)
        if k == 0:
            continue
        # the part that overlaps the region most
        over = ndi.sum(reg, lab, index=np.arange(1, k + 1))
        keep = lab == (int(np.argmax(over)) + 1)
        if keep.sum() >= min_cells:
            out[win] |= keep
    return out


# --------------------------------------------------------------------------------------- pipeline


class ChangeRaster:
    name = PRODUCER
    title = "Imagery change"
    description = "Two orthos: co-registration check, illumination-robust difference, heat map and polygons."
    keys = frozenset(
        {
            "from",
            "to",
            "layerFrom",
            "layerTo",
            "method",
            "threshold",
            "minAreaM2",
            "maxShiftPx",
            "mask",
            "ignore",
            "out",
        }
    )

    def validate(self, params: dict[str, Any]) -> dict[str, Any]:
        known_keys(params, set(self.keys), self.name)
        p = dict(params)
        for k in ("from", "to", "layerFrom", "layerTo"):
            text(p, k, required=True)
        if p["from"] == p["to"]:
            raise JobError("A change compares two different dates.")
        if p.get("method") not in METHODS:
            raise JobError(f"method must be one of {', '.join(METHODS)}.")
        number(p, "threshold", lo=0, hi=1)
        number(p, "minAreaM2", lo=0, hi=1e6)
        number(p, "maxShiftPx", lo=0, hi=100)
        for k in ("mask",):
            if k in p and not _ring(p[k]):
                raise JobError(f"{k} must be a polygon of at least three [lon, lat] points.")
        if "ignore" in p and (not isinstance(p["ignore"], list) or not all(_ring(r) for r in p["ignore"])):
            raise JobError("ignore must be a list of polygons of [lon, lat] points.")
        text(p, "out")
        return p

    def plan(self, params: dict[str, Any]) -> list[Step]:
        set_id = change_set_id(params["from"], params["to"], PRODUCER)
        out_dir = params.get("out") or f"change/{set_id}"

        def orthos(ctx: StepContext):
            m = read_manifest(ctx.project)
            check_captures(m, params["from"], params["to"])
            pair = []
            for key in ("layerFrom", "layerTo"):
                layer = find_layer(m, params[key])
                if layer.get("kind") != "raster" or layer.get("role") != "ortho":
                    raise JobError(f'The layer "{layer.get("name") or layer.get("id")}" is not an ortho.')
                pair.append(Ortho(ctx.project, m, layer))
            return m, pair

        def check_inputs(ctx: StepContext, pair) -> None:
            want = ctx.outputs("read").get("inputs")
            now = input_fingerprint(ctx.project, [f for o in pair for f in o.files])
            if want and want.get("hash") != now["hash"]:
                raise JobError(INPUTS_CHANGED)

        def read(ctx: StepContext) -> dict[str, Any]:
            m, (oa, ob) = orthos(ctx)
            inputs = input_fingerprint(ctx.project, [f for o in (oa, ob) for f in o.files])
            box = intersect(oa.box, ob.box)
            if box is None:
                raise JobError("The two orthos do not overlap.")
            # where both dates have data, on a coarse grid over both
            whole = union(oa.box, ob.box)
            coarse = Grid.over(
                whole, max(oa.gsd, ob.gsd, max(whole[2] - whole[0], whole[3] - whole[1]) / 256)
            )
            _, va = oa.sample(coarse, ctx.check)
            _, vb = ob.sample(coarse, ctx.check)
            both, either = va & vb, va | vb
            if not both.any():
                raise JobError("The two orthos do not overlap where they have imagery.")
            coverage = float(both.sum()) / float(max(1, either.sum()))
            rr, cc = np.nonzero(both)
            tight = (
                coarse.x0 + (cc.min() - 1) * coarse.cell,
                coarse.z0 + (rr.min() - 1) * coarse.cell,
                coarse.x0 + (cc.max() + 2) * coarse.cell,
                coarse.z0 + (rr.max() + 2) * coarse.cell,
            )
            box = intersect(box, tight) or box
            cell = cell_for(box, max(oa.gsd, ob.gsd))
            grid = Grid.over(box, cell)
            ctx.log(
                f"Comparing {grid.cols} x {grid.rows} cells of {cell * 100:.1f} cm "
                f"({oa.gsd * 100:.1f} cm and {ob.gsd * 100:.1f} cm orthos); both dates cover {coverage:.0%}."
            )
            a, va = oa.sample(grid, ctx.check, lambda f: ctx.progress(0.5 * f, "Earlier ortho"))
            b, vb = ob.sample(grid, ctx.check, lambda f: ctx.progress(0.5 + 0.5 * f, "Later ortho"))
            valid = va & vb
            both = valid.copy()
            if "mask" in params:
                valid &= ring_mask(m, [params["mask"]], grid)
            if params.get("ignore"):
                valid &= ~ring_mask(m, params["ignore"], grid)
            save_arrays(
                ctx.stage("work/grid.npz"),
                a=(a * 255).round().astype(np.uint8),
                b=(b * 255).round().astype(np.uint8),
                valid=valid,
                both=both,
            )
            return {
                "grid": grid.to_dict(),
                "coverage": round(coverage, 4),
                "y": round(max(oa.y, ob.y), 3),
                "inputs": inputs,
            }

        def register(ctx: StepContext) -> dict[str, Any]:
            _, pair = orthos(ctx)
            check_inputs(ctx, pair)
            r = ctx.outputs("read")
            grid = Grid.of(r["grid"])
            arr = load_arrays(ctx.stage("work/grid.npz"))
            a = arr["a"].astype(np.float32) / 255
            b = arr["b"].astype(np.float32) / 255
            # the whole shared area, mask and ignore polygons aside: more ground to line up
            shift = estimate_shift(a @ LUMA, b @ LUMA, arr["both"])
            max_px = float(params.get("maxShiftPx", DEFAULT_MAX_SHIFT_PX))
            reg = registration(shift, grid.cell, max_px)
            ctx.log(reg["message"], "info" if reg["ok"] else "warn")
            if not reg["ok"]:
                raise JobError(refusal(shift["px"], grid.cell, max_px))
            return {"shift": shift, "registration": reg}

        def compare(ctx: StepContext) -> dict[str, Any]:
            from scipy import ndimage as ndi

            m, pair = orthos(ctx)
            check_inputs(ctx, pair)
            r = ctx.outputs("read")
            grid = Grid.of(r["grid"])
            shift = ctx.outputs("register")["shift"]
            arr = load_arrays(ctx.stage("work/grid.npz"))
            a = arr["a"].astype(np.float32) / 255
            b = arr["b"].astype(np.float32) / 255
            valid, both = arr["valid"], arr["both"]
            if shift["px"] > 0.05:
                b = np.stack(
                    [
                        ndi.shift(b[..., k], (shift["dy"], shift["dx"]), order=1, mode="nearest")
                        for k in range(3)
                    ],
                    axis=2,
                )
                moved = ndi.shift(both.astype(np.float32), (shift["dy"], shift["dx"]), order=0, cval=0) > 0.5
                valid, both = valid & moved, both & moved
            # a band at the edge of the shared area has half a neighbourhood: left out
            valid = ndi.binary_erosion(valid, iterations=3)
            both = ndi.binary_erosion(both, iterations=3)
            ctx.progress(0.1, "Change score")
            score, b = change_score(a, b, valid, params["method"], stats=both)
            ctx.check()
            threshold = float(params.get("threshold", DEFAULT_THRESHOLD))
            min_area = float(params.get("minAreaM2", DEFAULT_MIN_AREA_M2))
            min_cells = max(4, int(np.ceil(min_area / grid.cell**2)))
            ctx.progress(0.4, "Regions")
            # the rgb method is plain colour distance, light and all
            lighting = params["method"] != "rgb"
            mask = change_mask(a, b, score, threshold, min_cells, lighting) & valid
            polys = [p for p in polygons(mask, grid, simplify=grid.cell * 0.5) if p.area >= min_area]
            # stable ids: north to south, then west to east
            polys.sort(key=lambda p: (round(p.centroid.y / grid.cell), p.centroid.x))
            from rasterio import features

            items, feats = [], []
            set_id_ = set_id
            regions_layer = f"{set_id_}-regions"
            y = float(r["y"])
            for i, poly in enumerate(polys, start=1):
                iid = f"region:{i:04d}"
                cells = features.rasterize(
                    [(poly, 1)],
                    out_shape=(grid.rows, grid.cols),
                    transform=grid.affine(),
                    fill=0,
                    dtype="uint8",
                ).astype(bool)
                sc = float(np.nanmean(np.where(cells, score, np.nan))) if cells.any() else threshold
                ring, local = outline(m, poly, y)
                x0, z0, x1, z1 = poly.bounds
                area = round(float(poly.area), 2)
                item: dict[str, Any] = {
                    "kind": "region",
                    "id": iid,
                    "verdict": "changed",
                    "label": f"Changed area of {area:,.1f} m²",
                    "score": round(min(1.0, max(0.0, sc)), 3),
                    "at": [round(poly.centroid.x, 3), round(y, 3), round(poly.centroid.y, 3)],
                    "bounds": {
                        "min": [round(x0, 3), round(y, 3), round(z0, 3)],
                        "max": [round(x1, 3), round(y, 3), round(z1, 3)],
                    },
                    "method": params["method"],
                    "outlineLocal": local,
                    "areaM2": area,
                    "layer": regions_layer,
                    "feature": iid,
                }
                if ring:
                    item["outline"] = ring
                    feats.append(
                        {
                            "type": "Feature",
                            "id": iid,
                            "properties": {
                                "id": iid,
                                "verdict": "changed",
                                "areaM2": area,
                                "score": item["score"],
                            },
                            "geometry": {"type": "Polygon", "coordinates": [ring]},
                        }
                    )
                items.append(item)
            ctx.progress(0.7, "Heat map")
            heat = colour_ramp(np.where(valid, score, np.nan), SCORE_STOPS)
            tiles = write_pyramid(heat, grid, ctx.stage("out/heat"), f"{out_dir}/heat", y, LEGEND, ctx.check)
            from ..runtime import atomic_write_json

            atomic_write_json(ctx.stage("out/heat/tiles.json"), tiles)
            atomic_write_json(
                ctx.stage("out/regions.geojson"),
                {"type": "FeatureCollection", "features": feats},
                indent=None,
            )
            reg = ctx.outputs("register")["registration"]
            stats = {
                "items": len(items),
                "areaM2": round(sum(it["areaM2"] for it in items), 2),
                "shiftPx": reg["shiftPx"],
                "cellM": grid.cell,
                "threshold": threshold,
            }
            cs = change_set(
                set_id_,
                params["from"],
                params["to"],
                PRODUCER,
                items,
                layers=[f"{set_id_}-heat", regions_layer],
                stats=stats,
                run={"jobId": ctx.job.job_id, "params": dict(params)},
                registration=reg,
                coverage=r["coverage"],
            )
            atomic_write_json(ctx.stage("work/change-set.json"), cs)
            return {"items": len(items)}

        def commit(ctx: StepContext) -> dict[str, Any]:
            import json

            m = read_manifest(ctx.project)
            cs = json.loads(ctx.stage("work/change-set.json").read_text("utf-8"))
            a, b = params["from"], params["to"]
            src = [params["layerFrom"], params["layerTo"]]
            when = f"{_label(m, a)} to {_label(m, b)}"
            prov = derived(a, b, set_id, ctx.job.job_id, src)
            layers = [
                {
                    "kind": "raster",
                    "id": f"{set_id}-heat",
                    "name": f"Imagery change heat map, {when}",
                    "visible": True,
                    "capture": b,
                    "derived": prov,
                    "src": {"path": f"{out_dir}/heat/tiles.json"},
                    "role": "plan",
                    "format": "kit-pyramid",
                },
                {
                    "kind": "vector",
                    "id": f"{set_id}-regions",
                    "name": f"Imagery change areas, {when}",
                    "visible": True,
                    "capture": b,
                    "derived": dict(prov),
                    "src": {"path": f"{out_dir}/regions.geojson"},
                    "format": "geojson",
                    "style": REGION_STYLE,
                },
            ]
            return commit_run(ctx, set_id, "out", out_dir, cs, layers)

        return [
            Step("read", "Read both orthos", read, 3.0),
            Step("register", "Check the alignment", register, 1.0),
            Step("compare", "Find the changes", compare, 3.0),
            Step("commit", "Add the change layers", commit, 1.0),
        ]


def _label(manifest: dict[str, Any], cid: str) -> str:
    from .imagery import capture_label

    return capture_label(manifest, cid)


def _ring(v: Any) -> bool:
    return (
        isinstance(v, list)
        and len(v) >= 3
        and all(
            isinstance(p, list | tuple)
            and len(p) == 2
            and all(isinstance(x, int | float) and not isinstance(x, bool) for x in p)
            for p in v
        )
    )
