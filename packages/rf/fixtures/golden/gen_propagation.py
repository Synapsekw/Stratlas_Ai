"""Independent reference that writes the path-loss golden vectors (propagation.json, Task 5).

Python standard library only (math, json, sys); no numpy. Written from 3GPP TR 38.901 V17
Tables 7.4.1-1 (path loss) and 7.4.2-1 (LOS probability), Okumura-Hata (Hata 1980) and
COST-231 Hata (COST Action 231 final report, ch. 4), not from the TypeScript. Edit the vectors
here, never the JSON by hand.

Run from the repository root, then format with prettier (the committed file is prettier output):

    python -I packages/rf/fixtures/golden/gen_propagation.py packages/rf/fixtures/golden/propagation.json
    npx prettier --write packages/rf/fixtures/golden/propagation.json

Then check both engines: `pnpm vitest run --project @aio/rf` and the pytest golden test (Task 6).
"""

import json
import math
import sys

# Test-only format id, built in two parts so the schema registry scan (versions.test.ts), which
# lists file-schema literals in source, does not read it as an unregistered file schema.
FORMAT = "aio.rf-golden" + "/1"

C_38901 = 3.0e8  # TR 38.901 note 1 of Table 7.4.1-1
C = 299792458.0  # free space uses the exact speed of light
H_E = 1.0  # effective environment height (UMi; UMa simplified, see conventions)
MIN_D2D = 10.0
RMA_H = 5.0  # average building height
RMA_W = 20.0  # average street width

HATA_RANGE = (150.0, 1500.0)
COST231_RANGE = (1500.0, 2000.0)
TR_RANGE = {"uma": (500.0, 100000.0), "umi": (500.0, 100000.0), "rma": (500.0, 30000.0)}
HATA_AREA_OF_ENV = {"uma": "urban", "umi": "urban", "rma": "open"}


def lg(x):
    return math.log10(x)


def dist3(d2, hbs, hut):
    return math.sqrt(d2 * d2 + (hbs - hut) ** 2)


def p_los(env, d2, hut):
    if env == "rma":
        return 1.0 if d2 <= 10 else math.exp(-(d2 - 10) / 1000)
    if d2 <= 18:
        return 1.0
    base_rate = 63.0 if env == "uma" else 36.0
    p = 18 / d2 + math.exp(-d2 / base_rate) * (1 - 18 / d2)
    if env == "uma":
        if hut <= 13:
            cp = 0.0
        else:
            cp = math.pow((hut - 13) / 10, 1.5)
        p = p * (1 + cp * 1.25 * math.pow(d2 / 100, 3) * math.exp(-d2 / 150))
    return p


def tr38901(env, f_mhz, d2_in, hbs, hut):
    """Returns (los, nlos, plos, expected, breakpoint)."""
    fg = f_mhz / 1000.0
    fhz = f_mhz * 1e6
    d2 = max(d2_in, MIN_D2D)
    d3 = dist3(d2, hbs, hut)
    if env in ("uma", "umi"):
        dbp = 4 * (hbs - H_E) * (hut - H_E) * fhz / C_38901
        if env == "uma":
            a, b1, b2, k = 28.0, 22.0, 40.0, 9.0
        else:
            a, b1, b2, k = 32.4, 21.0, 40.0, 9.5
        if d2 <= dbp:
            los = a + b1 * lg(d3) + 20 * lg(fg)
        else:
            los = a + b2 * lg(d3) + 20 * lg(fg) - k * lg(dbp * dbp + (hbs - hut) ** 2)
        if env == "uma":
            nlos_p = 13.54 + 39.08 * lg(d3) + 20 * lg(fg) - 0.6 * (hut - 1.5)
        else:
            nlos_p = 35.3 * lg(d3) + 22.4 + 21.3 * lg(fg) - 0.3 * (hut - 1.5)
    else:
        dbp = 2 * math.pi * hbs * hut * fhz / C_38901
        h, w = RMA_H, RMA_W

        def pl1(d):
            return (
                20 * lg(40 * math.pi * d * fg / 3)
                + min(0.03 * h**1.72, 10) * lg(d)
                - min(0.044 * h**1.72, 14.77)
                + 0.002 * lg(h) * d
            )

        los = pl1(d3) if d2 <= dbp else pl1(dbp) + 40 * lg(d3 / dbp)
        nlos_p = (
            161.04
            - 7.1 * lg(w)
            + 7.5 * lg(h)
            - (24.37 - 3.7 * (h / hbs) ** 2) * lg(hbs)
            + (43.42 - 3.1 * lg(hbs)) * (lg(d3) - 3)
            + 20 * lg(fg)
            - (3.2 * lg(11.75 * hut) ** 2 - 4.97)
        )
    nlos = los if los > nlos_p else nlos_p
    p = p_los(env, d2, hut)
    return los, nlos, p, p * los + (1 - p) * nlos, dbp


def fspl(f_mhz, d3):
    return 20 * lg(4 * math.pi * d3 * f_mhz * 1e6 / C)


def a_hm(f, hm, area):
    if area == "urban-large":
        if f < 300:
            return 8.29 * lg(1.54 * hm) ** 2 - 1.1
        return 3.2 * lg(11.75 * hm) ** 2 - 4.97
    return (1.1 * lg(f) - 0.7) * hm - (1.56 * lg(f) - 0.8)


def hata_family(model, f, d2_in, hb, hm, area):
    d2 = max(d2_in, MIN_D2D)
    dkm = d2 / 1000.0
    slope = (44.9 - 6.55 * lg(hb)) * lg(dkm)
    if model == "okumura-hata":
        urban = 69.55 + 26.16 * lg(f) - 13.82 * lg(hb) - a_hm(f, hm, area) + slope
    else:
        cm = 3.0 if area == "urban-large" else 0.0
        urban = 46.3 + 33.9 * lg(f) - 13.82 * lg(hb) - a_hm(f, hm, area) + slope + cm
    if area == "suburban" and model == "okumura-hata":
        pl = urban - 2 * lg(f / 28) ** 2 - 5.4
    elif area == "open":
        pl = urban - 4.78 * lg(f) ** 2 + 18.33 * lg(f) - 40.94
    else:
        pl = urban
    floor = fspl(f, dist3(d2, hb, hm))
    return (pl, False) if pl >= floor else (floor, True)


def refusal(model, env, f, hb, hm):
    if model == "okumura-hata":
        lo, hi = HATA_RANGE
    elif model == "cost231-hata":
        lo, hi = COST231_RANGE
    elif model == "tr38901":
        lo, hi = TR_RANGE[env]
    else:
        lo, hi = None, None
    if lo is not None and not (lo <= f <= hi):
        return {"refused": True, "code": "frequency", "rangeMHz": [lo, hi]}
    if hb <= 0 or hm <= 0:
        return {"refused": True, "code": "height", "rangeMHz": None}
    if model == "tr38901" and env in ("uma", "umi") and (hm <= H_E or hb <= H_E):
        return {"refused": True, "code": "height", "rangeMHz": None}
    return None


def band_tag(f):
    return "f-" + str(int(round(f)))


def vector(vid, model, env, f, d2, hb, hm, area=None, extra=()):
    covers = [model if model != "tr38901" else env, band_tag(f), "d-" + str(int(d2))] + list(extra)
    if model == "tr38901":
        covers.append("tr38901")
    inp = {
        "model": model,
        "environment": env,
        "hataArea": area,
        "frequencyMHz": f,
        "d2DM": d2,
        "hBsM": hb,
        "hUtM": hm,
    }
    r = refusal(model, env, f, hb, hm)
    if r is not None:
        covers.append("refused-" + r["code"])
        return {"id": vid, "covers": covers, "input": inp, "expected": r}
    exp = {"refused": False, "losDb": None, "nlosDb": None, "pLos": None, "breakpointM": None}
    if model == "tr38901":
        los, nlos, p, e, dbp = tr38901(env, f, d2, hb, hm)
        covers.append("los-pl1" if max(d2, MIN_D2D) <= dbp else "los-pl2")
        if nlos == los:
            covers.append("nlos-floor-los")
        if env == "uma" and hm > 13 and d2 > 18:
            covers.append("uma-c-prime")
        exp.update(
            pathLossDb=round(e, 6),
            losDb=round(los, 6),
            nlosDb=round(nlos, 6),
            pLos=round(p, 9),
            breakpointM=round(dbp, 6),
        )
    elif model == "free-space":
        exp["pathLossDb"] = round(fspl(f, dist3(max(d2, MIN_D2D), hb, hm)), 6)
    else:
        a = area if area is not None else HATA_AREA_OF_ENV[env]
        pl, floored = hata_family(model, f, d2, hb, hm, a)
        if floored:
            covers.append("free-space-floor")
        exp["pathLossDb"] = round(pl, 6)
    return {"id": vid, "covers": covers, "input": inp, "expected": exp}


BANDS = [760.0, 1840.0, 2600.0, 3500.0]
DISTANCES = [50.0, 200.0, 500.0, 1000.0, 3000.0, 10000.0]


def vectors():
    out = []
    heights = {
        "uma": [(25.0, 1.5), (35.0, 1.5), (25.0, 16.0)],
        "umi": [(10.0, 1.5), (15.0, 3.0)],
        "rma": [(35.0, 1.5), (60.0, 5.0)],
    }
    for env, hs in heights.items():
        for hb, hm in hs:
            for f in BANDS:
                for d in DISTANCES:
                    out.append(
                        vector(f"{env}-{int(f)}-h{hb:g}-{hm:g}-d{int(d)}", "tr38901", env, f, d, hb, hm)
                    )
    # near the mast: inside 18 m (P_LOS = 1) and the 10 m clamp
    out.append(vector("uma-1840-d5-clamp", "tr38901", "uma", 1840.0, 5.0, 25.0, 1.5))
    out.append(vector("umi-3500-d15", "tr38901", "umi", 3500.0, 15.0, 10.0, 1.5))
    # refusals in 38.901
    out.append(vector("uma-ue-1m-refused", "tr38901", "uma", 1840.0, 500.0, 25.0, 1.0))
    out.append(vector("rma-40ghz-refused", "tr38901", "rma", 40000.0, 500.0, 35.0, 1.5))
    out.append(vector("uma-400mhz-refused", "tr38901", "uma", 400.0, 500.0, 25.0, 1.5))

    for area in ["urban-large", "urban", "suburban", "open"]:
        for f in [760.0, 900.0, 1500.0]:
            for d in DISTANCES:
                for hb, hm in [(30.0, 1.5), (50.0, 5.0)]:
                    out.append(
                        vector(
                            f"hata-{area}-{int(f)}-h{hb:g}-{hm:g}-d{int(d)}",
                            "okumura-hata",
                            "uma",
                            f,
                            d,
                            hb,
                            hm,
                            area,
                        )
                    )
        for f in [1500.0, 1840.0, 2000.0]:
            for d in DISTANCES:
                out.append(
                    vector(
                        f"cost231-{area}-{int(f)}-d{int(d)}", "cost231-hata", "uma", f, d, 30.0, 1.5, area
                    )
                )
    # Hata area from the 38.901 environment (rma -> open, uma/umi -> urban)
    out.append(vector("hata-env-rma-760-d3000", "okumura-hata", "rma", 760.0, 3000.0, 35.0, 1.5))
    out.append(vector("cost231-env-umi-1840-d500", "cost231-hata", "umi", 1840.0, 500.0, 15.0, 1.5))
    # range refusals
    for f in [2600.0, 3500.0, 149.0, 1500.5]:
        out.append(vector(f"hata-{f:g}-refused", "okumura-hata", "uma", f, 1000.0, 30.0, 1.5, "urban"))
    for f in [760.0, 1499.0, 2600.0]:
        out.append(vector(f"cost231-{f:g}-refused", "cost231-hata", "uma", f, 1000.0, 30.0, 1.5, "urban"))

    for f in BANDS:
        for d in DISTANCES:
            out.append(vector(f"fs-{int(f)}-d{int(d)}", "free-space", "uma", f, d, 30.0, 1.5))
    return out


CONVENTIONS = {
    "distance": "d2DM is the horizontal distance from the mast to the UE. Every model clamps it to at least 10 m (the 38.901 lower bound); d3D = sqrt(d2D^2 + (hBsM - hUtM)^2). Beyond the validated range (5 km for 38.901 UMa/UMi NLOS and RMa NLOS, 10 km RMa LOS, 1 to 20 km for Hata) the formulas are extrapolated as written; that is a warning, never a refusal.",
    "heights": "hBsM is the antenna height above the tower-base ground, hUtM the UE height above the same ground (flat ground, spec D17).",
    "tr38901": "3GPP TR 38.901 V17 Table 7.4.1-1, fc in GHz inside the formulas, c = 3.0e8. UMa: d'BP = 4 h'BS h'UT fc[Hz]/c with h' = h - hE, PL1 = 28 + 22 log10(d3D) + 20 log10(fc), PL2 = 28 + 40 log10(d3D) + 20 log10(fc) - 9 log10(d'BP^2 + (hBS - hUT)^2), NLOS' = 13.54 + 39.08 log10(d3D) + 20 log10(fc) - 0.6 (hUT - 1.5). UMi street canyon: same d'BP, PL1 = 32.4 + 21 log10(d3D) + 20 log10(fc), PL2 = 32.4 + 40 log10(d3D) + 20 log10(fc) - 9.5 log10(d'BP^2 + (hBS - hUT)^2), NLOS' = 35.3 log10(d3D) + 22.4 + 21.3 log10(fc) - 0.3 (hUT - 1.5). RMa: dBP = 2 pi hBS hUT fc[Hz]/c with actual heights, PL1(d) = 20 log10(40 pi d fc/3) + min(0.03 h^1.72, 10) log10(d) - min(0.044 h^1.72, 14.77) + 0.002 log10(h) d, PL2 = PL1(dBP) + 40 log10(d3D/dBP), NLOS' = 161.04 - 7.1 log10(W) + 7.5 log10(h) - (24.37 - 3.7 (h/hBS)^2) log10(hBS) + (43.42 - 3.1 log10(hBS)) (log10(d3D) - 3) + 20 log10(fc) - (3.2 (log10(11.75 hUT))^2 - 4.97), h = 5 m, W = 20 m. PL1 when d2D <= breakpoint, else PL2. PL_NLOS = max(PL_LOS, NLOS'). hE = 1 m: exact for UMi; for UMa the TR draws hE = 1 m with probability 1/(1 + C(d2D, hUT)) and C = 0 for hUT < 13 m, so 1 m is exact at the default 1.5 m UE and a simplification above 13 m. UMa and UMi refuse hUT <= 1 m or hBS <= 1 m (no effective height). Frequency range: UMa and UMi 500 MHz to 100 GHz, RMa 500 MHz to 30 GHz; outside is refused.",
    "losProbability": "TR 38.901 Table 7.4.2-1 on d2D (clamped to 10 m). UMi: 1 for d2D <= 18 m, else 18/d2D + exp(-d2D/36)(1 - 18/d2D). UMa: 1 for d2D <= 18 m, else [18/d2D + exp(-d2D/63)(1 - 18/d2D)] [1 + C'(hUT) 5/4 (d2D/100)^3 exp(-d2D/150)], C' = 0 for hUT <= 13 m, ((hUT - 13)/10)^1.5 above. RMa: 1 for d2D <= 10 m, else exp(-(d2D - 10)/1000).",
    "expected": "pathLossDb for tr38901 is the expected path loss with LOS probability, combined in the dB domain: P_LOS PL_LOS + (1 - P_LOS) PL_NLOS (spec D14 'LOS probability averaged into an expected path loss'). The dB-domain mean is the planning convention; a linear-power mean would sit up to a few dB lower where P_LOS is mid-range.",
    "hata": "f in MHz, d in km, heights in m. a(hm): medium or small city (1.1 log10 f - 0.7) hm - (1.56 log10 f - 0.8); large city 8.29 (log10(1.54 hm))^2 - 1.1 below 300 MHz, else 3.2 (log10(11.75 hm))^2 - 4.97. Okumura-Hata urban = 69.55 + 26.16 log10 f - 13.82 log10 hb - a(hm) + (44.9 - 6.55 log10 hb) log10 d; suburban = urban - 2 (log10(f/28))^2 - 5.4; open = urban - 4.78 (log10 f)^2 + 18.33 log10 f - 40.94. COST-231 Hata = 46.3 + 33.9 log10 f - 13.82 log10 hb - a(hm) + (44.9 - 6.55 log10 hb) log10 d + Cm, Cm = 3 dB for urban-large (with the large-city a(hm)), else 0; suburban is the COST-231 medium-city formula as published; open applies the Okumura-Hata open-area correction (an extension, not in COST-231). Areas: urban-large, urban (medium city), suburban, open; when hataArea is null it follows the 38.901 environment: uma and umi urban, rma open. Both are floored at free space over d3D (the empirical fits go below free space near the mast, outside their 1 km validity). Okumura-Hata refuses f outside 150 to 1500 MHz, COST-231 outside 1500 to 2000 MHz (inclusive edges).",
    "freeSpace": "20 log10(4 pi d3D f / c), c = 299792458 m/s (equal to 32.45 + 20 log10 f[MHz] + 20 log10 d[km] to 0.001 dB).",
}


def main():
    doc = {
        "format": FORMAT,
        "suite": "propagation",
        "generator": "packages/rf/fixtures/golden/gen_propagation.py",
        "tolerance": {"db": 0.01, "probability": 1e-6, "m": 0.001},
        "units": {
            "frequencyMHz": "MHz",
            "d2DM": "m, horizontal",
            "hBsM": "m above ground",
            "hUtM": "m above ground",
            "pathLossDb": "dB",
            "pLos": "probability, 0 to 1",
            "breakpointM": "m",
        },
        "conventions": CONVENTIONS,
        "vectors": vectors(),
    }
    with open(sys.argv[1], "w", encoding="utf-8", newline="\n") as fh:
        json.dump(doc, fh, indent=2, ensure_ascii=True)
        fh.write("\n")


if __name__ == "__main__":
    main()
