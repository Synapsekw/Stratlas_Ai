"""Package processed results as the Volumetric Survey Kit's data scripts (``window.VS_*``).

Ported from the kit's ``package.py`` and ``pack3d.py`` with the maths unchanged:

- ``package``: per pile ``data/piles/<id>.js`` (10 cm surfaces, pile masks, TIN base, plane,
  low and average base, 6 cm photo crops), the authoritative volumes recomputed from exactly
  these quantised grids (the kit's viewer and the app's volume worker use the same maths),
  surface to surface change per pile, the 0.4 m site DSM ``data/dsm_<e>.js``, totals and
  ``data/site.js``, and the register ``piles.csv``.
- ``pack3d``: ``data/vol.js`` (0.4 m pile masks and TIN bases aligned to the site DSM) and the
  site photo texture ``data/tex_<e>.js`` (JPEG data URI).

Left out, because the app draws them itself from the grids: the colour relief and change
overlays (``overlays/*.webp``, which needed matplotlib) and their 3D textures
(``tex_relief_<e>.js``, ``tex_change.js``).

Grid encoding (decoded by ``packages/volumetric/src/model/kitdata.ts``): int16 centimetres above
``zoff`` stored as row deltas, zlib, base64; masks as numpy ``packbits``, zlib, base64.
"""

from __future__ import annotations

import base64
import csv
import io
import json
import warnings
import zlib
from collections.abc import Callable
from pathlib import Path

import numpy as np
from scipy import ndimage as ndi

F = 5  # 0.5 m segmentation cells = 5 x 0.1 m
BASES = ("low", "avg", "plane", "tin")
SR = 0.4  # site DSM cell (kit)


def b64(b: bytes) -> str:
    return base64.b64encode(b).decode()


def enc_i16(a: np.ndarray) -> str:
    """int16 grid -> row-delta -> zlib -> base64 (decoder: unzlib, cumulative sum along rows)."""
    a = a.astype(np.int32)
    d = np.diff(a, axis=1, prepend=0).astype("<i2")
    return b64(zlib.compress(d.tobytes(), 9))


def enc_bits(m: np.ndarray) -> str:
    return b64(zlib.compress(np.packbits(m.astype(np.uint8), axis=None).tobytes(), 9))


def fill_nearest(z: np.ndarray) -> np.ndarray:
    nan = np.isnan(z)
    if not nan.any():
        return z
    if nan.all():
        return np.zeros_like(z)
    ii = ndi.distance_transform_edt(nan, return_distances=False, return_indices=True)
    return z[ii[0], ii[1]]


def jpeg_uri(im, q: int = 80) -> str:
    bio = io.BytesIO()
    im.convert("RGB").save(bio, "JPEG", quality=q, optimize=True)
    return "data:image/jpeg;base64," + b64(bio.getvalue())


def keyed_script(var: str, key: str, value) -> str:
    return (
        f"window.{var}=window.{var}||{{}};window.{var}[{json.dumps(key)}]="
        + json.dumps(value, separators=(",", ":"))
        + ";\n"
    )


def level_res(grid: dict, z: int) -> float:
    return grid["ortho_res"] * 2 ** (grid["zmax"] - z)


def ortho_crop(tiles: Path, grid: dict, e: str, x0m, y1m, x1m, y0m, zl: int, max_px: int = 1800):
    """Compose a crop (CRS bounds) from the tiles of level ``zl``; returns (PIL RGB, m per px)."""
    from PIL import Image

    T = grid.get("tile", 1024)
    X0, Y1 = grid["x0"], grid["y1"]
    res_px = level_res(grid, zl)
    px0 = int(np.floor((x0m - X0) / res_px))
    px1 = int(np.ceil((x1m - X0) / res_px))
    py0 = int(np.floor((Y1 - y1m) / res_px))
    py1 = int(np.ceil((Y1 - y0m) / res_px))
    im = Image.new("RGBA", (px1 - px0, py1 - py0), (120, 116, 108, 255))
    for ty in range(py0 // T, (py1 - 1) // T + 1):
        for tx in range(px0 // T, (px1 - 1) // T + 1):
            f = tiles / e / str(zl) / f"{tx}_{ty}.webp"
            if f.exists():
                with Image.open(f) as src:
                    t = src.convert("RGBA")
                ox, oy = tx * T - px0, ty * T - py0
                if ox >= 0 and oy >= 0:
                    im.alpha_composite(t, (ox, oy))
                else:
                    im.paste(t, (ox, oy), t)
    s = min(1.0, max_px / max(im.size))
    if s < 1:
        im = im.resize((max(1, int(im.width * s)), max(1, int(im.height * s))), Image.LANCZOS)
    return im.convert("RGB"), (px1 - px0) * res_px / im.width


def package(
    job: dict,
    Z10: dict[str, np.ndarray],
    res: dict,
    PD: dict,
    ZL: np.ndarray,
    tiles: Path | None,
    out: Path,
    log: Callable[..., None] = lambda *a, **k: None,
    check: Callable[[], None] = lambda: None,
    progress: Callable[[float, str | None], None] = lambda f, m=None: None,
) -> dict:
    """Write ``out/data/piles/*.js``, ``out/data/dsm_*.js``, ``out/data/site.js`` and
    ``out/piles.csv``; return the site document (``VS_SITE``) with the authoritative volumes."""
    (out / "data" / "piles").mkdir(parents=True, exist_ok=True)
    G = job["grid"]
    X0, Y1, Xr, Y0 = G["x0"], G["y1"], G["x1"], G["y0"]
    R10 = G["dsm_res"]
    R5 = R10 * F
    EPS = [e["id"] for e in job["epochs"]]
    DB = (job.get("volume") or {}).get("deadband_m", 0.1)
    ZOFF = float(np.floor(min(np.nanmin(Z10[e]) for e in EPS))) - 1.0
    zpile = max(0, G["zmax"] - 1)  # the kit crops pile photos from level 4 of 5 (6 cm)

    def q_cm(z):
        return np.round((z - ZOFF) * 100).astype(np.int16)

    has_tiles = {e: bool(tiles and (tiles / e / str(zpile)).is_dir()) for e in EPS}
    vol_piles: dict = {}
    n_piles = len(res["piles"])
    for n, P in enumerate(res["piles"], 1):
        check()
        pid = P["id"]
        zid = P["zone"]
        zm5 = zid == ZL
        ys, xs = np.nonzero(zm5)
        by0, by1, bx0, bx1 = ys.min(), ys.max() + 1, xs.min(), xs.max() + 1
        for e in P["epochs"]:
            y0, y1, x0, x1 = PD[(pid, e)]["bbox5"]
            by0, by1, bx0, bx1 = min(by0, y0), max(by1, y1), min(bx0, x0), max(bx1, x1)
        by0, bx0 = max(0, by0 - 2), max(0, bx0 - 2)
        by1, bx1 = min(ZL.shape[0], by1 + 2), min(ZL.shape[1], bx1 + 2)
        H, W = int((by1 - by0) * F), int((bx1 - bx0) * F)
        zone10 = ndi.zoom(zm5[by0:by1, bx0:bx1].astype(np.uint8), F, order=0).astype(bool)
        x0m, y1m = X0 + bx0 * R5, Y1 - by0 * R5
        outp: dict = {
            "id": pid,
            "res": R10,
            "w": W,
            "h": H,
            "x0": round(float(x0m), 3),
            "y1": round(float(y1m), 3),
            "zoff": ZOFF,
            "zone": enc_bits(zone10),
            "ep": {},
        }
        Q: dict = {}
        for e in EPS:
            z = Z10[e][by0 * F : by1 * F, bx0 * F : bx1 * F].astype(np.float64)
            zq = q_cm(fill_nearest(z))
            Q[e] = {"z": zq, "valid": ~np.isnan(z)}
            ent: dict = {"z": enc_i16(zq)}
            if e in P["epochs"]:
                d = PD[(pid, e)]
                ey0, _, ex0, _ = d["bbox5"]
                oy, ox = (ey0 - by0) * F, (ex0 - bx0) * F
                hh, ww = d["m"].shape
                m = np.zeros((H, W), bool)
                m[oy : oy + hh, ox : ox + ww] = d["m"]
                tin = np.full((H, W), np.nan)
                tin[oy : oy + hh, ox : ox + ww] = d["bases"]["tin"]
                tinq = q_cm(fill_nearest(tin))
                pl = d["bases"]["plane"]
                c = np.linalg.lstsq(
                    np.c_[
                        np.ones(pl.size),
                        np.tile((np.arange(ww) + 0.5) * R10, hh),
                        np.repeat((np.arange(hh) + 0.5) * R10, ww),
                    ],
                    pl.ravel(),
                    rcond=None,
                )[0]
                dx, dy = ox * R10, oy * R10
                plane = [float(c[0] - c[1] * dx - c[2] * dy), float(c[1]), float(c[2])]
                low = float(d["bases"]["low"].flat[0])
                avg = float(d["bases"]["avg"].flat[0])
                plane_r = [round(v, 6) for v in plane]
                ent.update(
                    {
                        "m": enc_bits(m),
                        "tin": enc_i16(tinq),
                        "low": round(low, 3),
                        "avg": round(avg, 3),
                        "plane": plane_r,
                    }
                )
                Q[e].update(
                    {"m": m, "tin": tinq, "low": round(low, 3), "avg": round(avg, 3), "plane": plane_r}
                )
            outp["ep"][e] = ent
        tex = {}
        for e in EPS:
            if has_tiles[e] and tiles is not None:
                im, _ = ortho_crop(tiles, G, e, x0m, y1m, x0m + W * R10, y1m - H * R10, zpile)
                tex[e] = jpeg_uri(im, 78)
        if tex:
            outp["tex"] = tex
        # authoritative volumes from exactly these quantised arrays (same maths as the viewer)
        XX = (np.arange(W) + 0.5) * R10
        YY = (np.arange(H) + 0.5) * R10
        for e in P["epochs"]:
            q = Q[e]
            zc = q["z"].astype(np.float64) / 100 + ZOFF
            m = q["m"]
            bases = {
                "low": np.full((H, W), q["low"]),
                "avg": np.full((H, W), q["avg"]),
                "plane": q["plane"][0] + q["plane"][1] * XX[None, :] + q["plane"][2] * YY[:, None],
                "tin": q["tin"].astype(np.float64) / 100 + ZOFF,
            }
            for b, base in bases.items():
                dd = (zc - base)[m]
                fill = float(dd[dd > 0].sum() * R10 * R10)
                cut = float(-dd[dd < 0].sum() * R10 * R10)
                P["epochs"][e]["vol"][b] = {
                    "fill": round(fill, 1),
                    "cut": round(cut, 1),
                    "net": round(fill - cut, 1),
                }
        if len(EPS) == 2:
            a, b_ = EPS
            dz = (Q[b_]["z"].astype(np.int32) - Q[a]["z"].astype(np.int32)) / 100.0
            ok = zone10 & Q[a]["valid"] & Q[b_]["valid"]
            v = dz[ok]
            P["change"] = {
                "fill": round(float(v[v > DB].sum() * R10 * R10), 1),
                "cut": round(float(-v[v < -DB].sum() * R10 * R10), 1),
            }
            P["change"]["net"] = round(P["change"]["fill"] - P["change"]["cut"], 1)
        js = (
            "window.VS_PILE=window.VS_PILE||{};window.VS_PILE["
            + json.dumps(pid)
            + "]="
            + json.dumps(outp, separators=(",", ":"))
            + ";\n"
        )
        (out / "data" / "piles" / f"{pid}.js").write_text(js, "utf-8")
        vol_piles[pid] = _coarse_pile(Q, outp, zone10, EPS, ZOFF, G)
        log(
            f"{pid}: "
            + ", ".join(f"{e} {P['epochs'][e]['vol']['tin']['net']:,.1f} m3" for e in P["epochs"])
            + (f", change {P['change']['net']:+,.1f} m3" if "change" in P else "")
        )
        progress(0.85 * n / max(1, n_piles), pid)

    # ------------------------------------------------------------------ site DSM (0.4 m)
    f4 = round(SR / R10)
    for e in EPS:
        check()
        z = Z10[e]
        Hh, Ww = z.shape[0] // f4, z.shape[1] // f4
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            za = np.nanmean(z[: Hh * f4, : Ww * f4].reshape(Hh, f4, Ww, f4), axis=(1, 3))
        valid = ~np.isnan(za)
        doc = {
            "res": SR,
            "w": int(Ww),
            "h": int(Hh),
            "x0": X0,
            "y1": Y1,
            "zoff": ZOFF,
            "z": enc_i16(q_cm(fill_nearest(za))),
            "valid": enc_bits(valid),
        }
        (out / "data" / f"dsm_{e}.js").write_text(keyed_script("VS_DSM", e, doc), "utf-8")
    progress(0.9, "Site DSM")

    # ------------------------------------------------------------------ 0.4 m pile grids (pack3d)
    vol = {"res": SR, "x0": X0, "y1": Y1, "piles": vol_piles}
    (out / "data" / "vol.js").write_text(
        "window.VS_VOL=" + json.dumps(vol, separators=(",", ":")) + ";\n", "utf-8"
    )

    # ------------------------------------------------------------------ totals and site.js
    tot = {}
    for e in EPS:
        tot[e] = {
            b: round(sum(P["epochs"][e]["vol"][b]["net"] for P in res["piles"] if e in P["epochs"]), 1)
            for b in BASES
        }
        tot[e]["area_m2"] = round(sum(P["epochs"][e]["area_m2"] for P in res["piles"] if e in P["epochs"]), 1)
    res["totals"] = tot
    if len(EPS) == 2:
        res["pile_change"] = {
            k: round(sum(P["change"][k] for P in res["piles"] if "change" in P), 1)
            for k in ("fill", "cut", "net")
        }
    res["grid"] = {
        "x0": X0,
        "y0": Y0,
        "x1": Xr,
        "y1": Y1,
        "tile": G.get("tile", 1024),
        "zmax": G.get("zmax", 0),
        "ortho_res": G.get("ortho_res"),
    }
    res["volume"] = job.get("volume") or {}
    res["zoff"] = ZOFF
    res["meta"] = {k: job.get(k) for k in ("title", "customer", "site", "crs", "crs_name")}
    res["meta"]["epoch_order"] = EPS
    res.pop("job", None)
    (out / "data" / "site.js").write_text(
        "window.VS_SITE=" + json.dumps(res, separators=(",", ":")) + ";\n", "utf-8"
    )
    _register_csv(res, EPS, out / "piles.csv")
    progress(1.0, "Packaged")
    return res


def _coarse_pile(Q: dict, R: dict, zone: np.ndarray, EPS: list[str], ZOFF: float, G: dict) -> dict:
    """One pile of ``vol.js`` (kit pack3d.py): 4 x 4 blocks of the 10 cm grids aligned to the
    0.4 m site DSM, mask where at least half the block is pile, TIN base as the block mean."""
    X0, Y1 = G["x0"], G["y1"]
    F4 = round(SR / G["dsm_res"])
    w, h = R["w"], R["h"]
    c0 = round((R["x0"] - X0) / G["dsm_res"])
    r0 = round((Y1 - R["y1"]) / G["dsm_res"])
    gc0, gr0 = c0 // F4, r0 // F4
    gc1, gr1 = -(-(c0 + w) // F4), -(-(r0 + h) // F4)
    W4, H4 = gc1 - gc0, gr1 - gr0
    oc, orr = c0 - gc0 * F4, r0 - gr0 * F4

    def block(a, fill):  # place a (h, w) 10 cm array into the aligned canvas, as 4 x 4 blocks
        cv = np.full((H4 * F4, W4 * F4), fill, dtype=np.float64)
        cv[orr : orr + h, oc : oc + w] = a
        return cv.reshape(H4, F4, W4, F4)

    zf = block(zone.astype(float), 0).mean(axis=(1, 3)) >= 0.5
    ent: dict = {"bx0": int(gc0), "by0": int(gr0), "w": int(W4), "h": int(H4), "zone": enc_bits(zf)}
    for e in EPS:
        q = Q[e]
        if "m" not in q:
            continue
        m = q["m"]
        tin = q["tin"].astype(np.float64) / 100 + ZOFF
        m4 = block(m.astype(float), 0).mean(axis=(1, 3)) >= 0.5
        tb = block(np.where(m, tin, np.nan), np.nan)
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            t4 = np.nanmean(tb, axis=(1, 3))
        t4 = fill_nearest(t4)
        ent[e] = {
            "m": enc_bits(m4),
            "tin": enc_i16(np.round((t4 - ZOFF) * 100)),
            "low": q["low"],
            "avg": q["avg"],
            "plane": {"c": q["plane"], "x0": R["x0"], "y1": R["y1"]},
        }
    return ent


def _register_csv(res: dict, EPS: list[str], path: Path) -> None:
    with open(path, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        hdr = ["pile", "status"]
        for e in EPS:
            hdr += [f"{e}_area_m2", f"{e}_height_m"] + [
                f"{e}_vol_{b}_m3" for b in ("tin", "plane", "avg", "low")
            ]
            hdr += [f"{e}_survey_err_m3"]
        hdr += ["change_fill_m3", "change_cut_m3", "change_net_m3", "centre_e", "centre_n"]
        w.writerow(hdr)
        for P in res["piles"]:
            r = [P["id"], P["status"]]
            for e in EPS:
                E = P["epochs"].get(e)
                r += (
                    [E["area_m2"], E["height_m"]]
                    + [E["vol"][b]["net"] for b in ("tin", "plane", "avg", "low")]
                    + [E["survey_err_m3"]]
                    if E
                    else [""] * 7
                )
            ring = np.array(P["zone_ring"])
            ch = P.get("change") or {"fill": "", "cut": "", "net": ""}
            r += [
                ch["fill"],
                ch["cut"],
                ch["net"],
                round(float(ring[:, 0].mean()), 2),
                round(float(ring[:, 1].mean()), 2),
            ]
            w.writerow(r)


def site_photo(tiles: Path, grid: dict, e: str, max_px: int = 4096):
    """The 3D site texture (kit pack3d.py ``site_photo``): level ``zmax - 2`` tiles composed over
    the whole grid on the kit's ground colour, then resized. The kit used 0.135 m per px from
    0.12 m tiles at Masafi; here that is 1.125 x the tile level, coarser when the site would
    exceed ``max_px`` (the WebGL texture limit the app keeps to)."""
    from PIL import Image

    T = grid.get("tile", 1024)
    X0, Y0, X1, Y1 = grid["x0"], grid["y0"], grid["x1"], grid["y1"]
    z3 = max(0, grid["zmax"] - 2)
    r3 = level_res(grid, z3)
    W = int(np.ceil((X1 - X0) / r3))
    H = int(np.ceil((Y1 - Y0) / r3))
    im = Image.new("RGBA", (int(np.ceil(W / T)) * T, int(np.ceil(H / T)) * T), (118, 112, 102, 255))
    for f in sorted((tiles / e / str(z3)).glob("*.webp")):
        if f.name.startswith("."):
            continue
        x, y = map(int, f.stem.split("_"))
        with Image.open(f) as src:
            im.alpha_composite(src.convert("RGBA"), (x * T, y * T))
    im = im.crop((0, 0, W, H))
    res_out = max(r3 * 1.125, max(X1 - X0, Y1 - Y0) / max_px)
    s = r3 / res_out
    return im.resize((max(1, int(W * s)), max(1, int(H * s))), Image.LANCZOS)
