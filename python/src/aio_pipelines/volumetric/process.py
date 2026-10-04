"""Volumetric survey processing: ground, pile detection, bases, volumes, matching, change.

Ported from Volumetric Survey Kit ``process.py`` with the maths unchanged (the review checks
recomputed volumes against the kit's to 0.5 %). The script became a function, takes one or two
survey dates (two give cut and fill between dates), and reports progress and honours cancel.

Input: DSMs on the common grid (``grid.dsm_res`` cells, NaN = no data), keyed by epoch id.
Output: the piles.json document (everything a viewer needs except rasters).
"""

from __future__ import annotations

import warnings
from collections.abc import Callable

import numpy as np
from scipy import ndimage as ndi
from scipy.sparse import csr_matrix, lil_matrix
from scipy.sparse.linalg import spsolve
from skimage import filters, measure, morphology, segmentation
from skimage.draw import polygon as draw_polygon

F = 5  # segmentation at F x dsm_res (0.5 m for a 0.1 m DSM)
EPOCH_META = (
    "id",
    "label",
    "date",
    "gsd_cm",
    "cp_rmse_z_m",
    "gcps",
    "checkpoints",
    "images",
    "camera",
    "processing",
)


def agg(z10, fn):
    H, W = z10.shape
    H5, W5 = H // F, W // F
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)
        return fn(z10[: H5 * F, : W5 * F].reshape(H5, F, W5, F), axis=(1, 3))


def ground_model(z10):
    zmin = agg(z10, np.nanmin)
    m = np.isnan(zmin)
    g = np.where(m, np.nanmax(zmin), zmin)
    for rad, dh in ((3, 0.3), (8, 0.6), (16, 1.0), (30, 1.5), (50, 2.0)):  # progressive morphological filter
        op = ndi.grey_opening(g, footprint=morphology.disk(rad))
        g = np.where(g - op > dh, op, g)
    return ndi.uniform_filter(g, 9), zmin, m


def segment(nd):
    mask = filters.apply_hysteresis_threshold(nd, 0.25, 2.0)
    core = morphology.opening(mask, morphology.disk(8)) & (nd > 1.0)  # drops walls / berms (< 8 m wide)
    g = core.copy()
    for _ in range(12):  # regrow the toe, at most 6 m
        g = ndi.binary_dilation(g) & mask
    g = ndi.binary_fill_holes(g)
    sm = ndi.gaussian_filter(nd, 2)
    mk = measure.label(morphology.h_maxima(np.where(g, sm, 0), 1.5) & g)  # split heaps at saddles > 1.5 m
    return segmentation.watershed(-sm, mk, mask=g)


def aoi_mask(shape, aoi):
    m = np.zeros(shape, bool)
    if aoi:
        rr, cc = draw_polygon([p[1] for p in aoi], [p[0] for p in aoi], shape)
        m[rr, cc] = True
    else:
        m[:] = True
    return m


def harmonic(zfix, fixed, dom):
    """Laplace interpolation over dom with Dirichlet values on fixed cells (natural edges elsewhere)."""
    idx = -np.ones(dom.shape, np.int64)
    unk = dom & ~fixed
    n = int(unk.sum())
    idx[unk] = np.arange(n)
    if n == 0:
        return zfix.copy()
    A = lil_matrix((n, n))
    b = np.zeros(n)
    ys, xs = np.nonzero(unk)
    for k, (y, x) in enumerate(zip(ys, xs, strict=True)):
        deg = 0
        for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            yy, xx = y + dy, x + dx
            if 0 <= yy < dom.shape[0] and 0 <= xx < dom.shape[1] and dom[yy, xx]:
                deg += 1
                if fixed[yy, xx]:
                    b[k] += zfix[yy, xx]
                else:
                    A[k, idx[yy, xx]] = -1
        A[k, k] = deg if deg else 1
    sol = spsolve(csr_matrix(A), b)
    out = zfix.copy()
    out[unk] = sol
    return out


def pile_bases(z10, lab5, pid, nd5, R10, log):
    """Per pile: 10 cm bbox arrays + the four bases."""
    sl = ndi.find_objects((lab5 == pid).astype(np.int32))[0]
    pad = 3
    y0, y1 = max(0, sl[0].start - pad), min(lab5.shape[0], sl[0].stop + pad)
    x0, x1 = max(0, sl[1].start - pad), min(lab5.shape[1], sl[1].stop + pad)
    m5 = lab5[y0:y1, x0:x1] == pid
    other = (lab5[y0:y1, x0:x1] > 0) & ~m5
    nd = nd5[y0:y1, x0:x1]
    edge = m5 & ~ndi.binary_erosion(m5)
    touch_ground = ndi.binary_dilation(~(m5 | other)) & edge & (nd < 0.6)  # toe on the yard floor
    z = z10[y0 * F : y1 * F, x0 * F : x1 * F].astype(np.float64)
    m10 = ndi.zoom(m5.astype(np.float32), F, order=1)[: z.shape[0], : z.shape[1]] > 0.5
    m10 &= ~np.isnan(z)
    zf = np.where(np.isnan(z), np.nanmedian(z), z)
    toe10 = m10 & ~ndi.binary_erosion(m10)
    tg10 = toe10 & (
        ndi.zoom(ndi.binary_dilation(touch_ground, iterations=1).astype(np.float32), F, order=0)[
            : z.shape[0], : z.shape[1]
        ]
        > 0.5
    )
    if tg10.sum() < 20:
        tg10 = toe10
    ty, tx = np.nonzero(tg10)
    tz = zf[ty, tx]
    xs = (np.arange(z.shape[1]) + 0.5) * R10
    ys = (np.arange(z.shape[0]) + 0.5) * R10
    XX, YY = np.meshgrid(xs, ys)
    A = np.c_[np.ones(tz.size), XX[ty, tx], YY[ty, tx]]
    c, *_ = np.linalg.lstsq(A, tz, rcond=None)
    bases = {
        "low": np.full(z.shape, tz.min()),
        "avg": np.full(z.shape, tz.mean()),
        "plane": c[0] + c[1] * XX + c[2] * YY,
    }
    # TIN-like base: harmonic surface through the ground-contact toe, solved at 0.5 m then upsampled
    z5 = agg(z10[y0 * F : y1 * F, x0 * F : x1 * F], np.nanmean)[: m5.shape[0], : m5.shape[1]]
    fixed5 = touch_ground if touch_ground.sum() >= 4 else edge
    zfix = np.where(fixed5, z5, 0.0)
    try:
        h5 = harmonic(np.nan_to_num(zfix), fixed5, m5 | fixed5)
        dm = m5 | fixed5
        ii = ndi.distance_transform_edt(~dm, return_distances=False, return_indices=True)
        h5f = h5[ii[0], ii[1]]
        tin = ndi.zoom(h5f, F, order=1)[: z.shape[0], : z.shape[1]]
    except Exception as ex:  # kept from the kit: fall back to the plane, and say so
        log(f"harmonic base failed for zone {pid}: {ex}; using the best-fit plane", "warn")
        tin = bases["plane"]
    bases["tin"] = tin
    return {
        "bbox5": (y0, y1, x0, x1),
        "z": zf,
        "m": m10,
        "toe": toe10,
        "tg": tg10,
        "bases": bases,
        "ground_toe_frac": float(tg10.sum() / max(1, toe10.sum())),
    }


def volumes(z, m, base, R10):
    d = (z - base)[m]
    fill = float(d[d > 0].sum() * R10 * R10)
    cut = float(-d[d < 0].sum() * R10 * R10)
    return {"fill": fill, "cut": cut, "net": fill - cut}


def ring_of(mask, R, X0, Y1, oy=0, ox=0):
    c = max(measure.find_contours(np.pad(mask, 1).astype(float), 0.5), key=len)
    c = measure.approximate_polygon(c, 0.8)
    return [[round(X0 + (ox + p[1] - 1 + 0.5) * R, 2), round(Y1 - (oy + p[0] - 1 + 0.5) * R, 2)] for p in c]


def process(
    job: dict,
    Z10: dict[str, np.ndarray],
    log: Callable[..., None] = lambda *a, **k: None,
    check: Callable[[], None] = lambda: None,
    progress: Callable[[float, str | None], None] = lambda f, m=None: None,
    work: dict | None = None,
) -> dict:
    """Run the kit's process step. ``work``, when given, receives the arrays the kit's
    ``process.py`` saved under ``out/work/`` for ``package.py``: ``zones`` (zones05.npy),
    ``labels`` per epoch (lab05_<e>.npy) and ``piledata`` ((pile, epoch) -> pile_bases dict,
    piledata.pkl)."""
    G = job["grid"]
    R10 = G["dsm_res"]
    R = R10 * F
    X0, Y1 = G["x0"], G["y1"]
    DET = job.get("detect", {}) or {}
    AOI = DET.get("aoi_px05")
    MIN_AREA = DET.get("min_area_m2", 120)
    MIN_H = DET.get("min_height_m", 2.0)
    EPS = [e["id"] for e in job["epochs"]]
    deadband = (job.get("volume") or {}).get("deadband_m", 0.1)

    res: dict = {"job": {k: v for k, v in job.items() if k != "detect"}, "epochs": {}, "piles": []}
    ND, GR = {}, {}
    for e in EPS:
        check()
        g5, zmin5, nod5 = ground_model(Z10[e])
        ND[e] = np.where(nod5, 0, zmin5 - g5)
        GR[e] = g5
    progress(0.15, "Yard floor")
    ea, eb = EPS[0], EPS[-1]
    two = ea != eb
    # pile zones are segmented once on the envelope of both surveys, so a pile keeps its identity
    # and its footprint between dates; each date is then measured inside the same zone.
    env = np.maximum(ND[ea], ND[eb])
    zl = segment(env)
    check()
    aoi = aoi_mask(zl.shape, AOI)
    keep = np.zeros(zl.max() + 1, bool)
    for r in measure.regionprops(zl, intensity_image=env):
        cy, cx = map(int, r.centroid)
        if r.area * R * R >= MIN_AREA and r.intensity_max >= MIN_H and aoi[cy, cx]:
            keep[r.label] = True
    zl = np.where(keep[zl], zl, 0)
    # reviewer edits: clip lines (keep the side holding 'keep') and excluded zones
    yy, xx = np.mgrid[0 : zl.shape[0], 0 : zl.shape[1]]
    for cl in DET.get("clip_lines", []):
        (ax, ay), (bx, by), (kx, ky) = cl["a"], cl["b"], cl["keep"]

        def side(px, py, ax=ax, ay=ay, bx=bx, by=by):
            return (bx - ax) * (py - ay) - (by - ay) * (px - ax)

        sk = np.sign(side(kx, ky))
        zl = np.where(np.sign(side(xx, yy)) == sk, zl, 0)
    EXCL = []
    for ex in DET.get("exclude", []):
        x, y = ex["at"]
        k = zl[y, x]
        if k:
            EXCL.append(
                {
                    "reason": ex["reason"],
                    "ring": ring_of(zl == k, R, X0, Y1),
                    "area_m2": round(float((zl == k).sum() * R * R), 1),
                }
            )
            zl = np.where(zl == k, 0, zl)
    # a clip can leave slivers: keep the largest piece of each zone, drop zones now under the size floor
    zz = np.zeros_like(zl)
    for k in np.unique(zl[zl > 0]):
        cc = measure.label(zl == k, connectivity=1)
        if cc.max() == 0:
            continue
        big = np.argmax(np.bincount(cc[cc > 0]))
        piece = cc == big
        if piece.sum() * R * R >= MIN_AREA:
            zz[piece] = k
    zl = zz
    zl, _, _ = segmentation.relabel_sequential(zl)
    progress(0.3, "Pile zones")
    LAB = {}
    for e in EPS:
        check()
        pres = filters.apply_hysteresis_threshold(ND[e], 0.25, 1.0)
        pres = morphology.opening(pres, morphology.disk(1))
        lab = np.where(pres, zl, 0)
        out = np.zeros_like(lab)  # drop crumbs: keep components >= 25 m2
        for r in measure.regionprops(measure.label(lab > 0, connectivity=1), intensity_image=lab):
            if r.area * R * R >= 25:
                sub = r.image
                vals = lab[r.slice][sub]
                out[r.slice][sub] = vals
        LAB[e] = out
    nz = int(zl.max())
    log(f"{nz} pile zones")
    cents = ndi.center_of_mass(zl > 0, zl, range(1, nz + 1))
    order = sorted(range(1, nz + 1), key=lambda k: (round(cents[k - 1][0] / 60), cents[k - 1][1]))
    items = [
        (cents[k - 1], {e: (k if (LAB[e] == k).sum() * R * R >= 60 else None) for e in EPS}, k) for k in order
    ]

    if work is not None:
        work["zones"] = zl.astype(np.int16)
        work["labels"] = {e: LAB[e].astype(np.int16) for e in EPS}
        work["piledata"] = {}
    meta = {}
    for e in job["epochs"]:
        res["epochs"][e["id"]] = {k: e[k] for k in EPOCH_META if k in e}
        meta[e["id"]] = e

    for n, (_cen, ids, zid) in enumerate(items, 1):
        check()
        pid = f"P{n:02d}"
        P: dict = {"id": pid, "name": f"Pile {n:02d}", "material": None, "zone": int(zid), "epochs": {}}
        P["zone_ring"] = ring_of(zl == zid, R, X0, Y1)
        for e in EPS:
            k = ids[e]
            if not k:
                continue
            d = pile_bases(Z10[e], LAB[e], k, ND[e], R10, log)
            if work is not None:
                work["piledata"][(pid, e)] = d
            vol = {b: volumes(d["z"], d["m"], d["bases"][b], R10) for b in ("low", "avg", "plane", "tin")}
            y0, y1, x0, x1 = d["bbox5"]
            m = d["m"]
            area = float(m.sum() * R10 * R10)
            zt = d["z"][m]
            ring = ring_of(LAB[e][y0:y1, x0:x1] == k, R, X0, Y1, y0, x0)
            sig = float(meta[e].get("cp_rmse_z_m") or 0.0) * area
            P["epochs"][e] = {
                "k": int(k),
                "area_m2": round(area, 1),
                "top_m": round(float(zt.max()), 2),
                "height_m": round(float(zt.max() - d["bases"]["tin"][m].min()), 2),
                "bbox": [
                    round(X0 + x0 * R, 2),
                    round(Y1 - y1 * R, 2),
                    round(X0 + x1 * R, 2),
                    round(Y1 - y0 * R, 2),
                ],
                "ring": ring,
                "ground_toe_frac": round(d["ground_toe_frac"], 2),
                "vol": {b: {kk: round(vv, 1) for kk, vv in v.items()} for b, v in vol.items()},
                "survey_err_m3": round(sig, 1),
            }
        if two:  # survey-to-survey change over the zone (independent of any base)
            u = zl == zid
            u10 = ndi.zoom(u.astype(np.float32), F, order=0)[: Z10[ea].shape[0], : Z10[ea].shape[1]] > 0.5
            dz = (Z10[eb] - Z10[ea])[u10]
            dz = dz[~np.isnan(dz)]
            P["change"] = {
                "fill": round(float(dz[dz > deadband].sum() * R10 * R10), 1),
                "cut": round(float(-dz[dz < -deadband].sum() * R10 * R10), 1),
            }
            P["change"]["net"] = round(P["change"]["fill"] - P["change"]["cut"], 1)
            P["status"] = "matched" if all(ids[e] for e in EPS) else ("new" if ids[ea] is None else "removed")
        else:
            P["status"] = "measured"
        res["piles"].append(P)
        log(
            f"{pid} {P['status']} "
            + ", ".join(f"{e}: {P['epochs'][e]['vol']['tin']['net']:.1f} m3" for e in P["epochs"])
        )
        progress(0.3 + 0.65 * n / max(1, len(items)), pid)

    if two:  # site change inside the yard
        aoi10 = ndi.zoom(aoi.astype(np.float32), F, order=0)[: Z10[ea].shape[0], : Z10[ea].shape[1]] > 0.5
        dz = Z10[eb] - Z10[ea]
        v = dz[aoi10 & ~np.isnan(dz)]
        res["site_change"] = {
            "fill": round(float(v[v > deadband].sum() * R10 * R10), 1),
            "cut": round(float(-v[v < -deadband].sum() * R10 * R10), 1),
            "area_m2": round(float((aoi10 & ~np.isnan(dz)).sum() * R10 * R10), 1),
        }
        res["site_change"]["net"] = round(res["site_change"]["fill"] - res["site_change"]["cut"], 1)
    res["excluded"] = EXCL
    res["aoi"] = [[round(X0 + p[0] * R, 2), round(Y1 - p[1] * R, 2)] for p in AOI] if AOI else None
    progress(1.0, "Done")
    return res
