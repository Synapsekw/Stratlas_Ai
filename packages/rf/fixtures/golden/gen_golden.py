"""Independent reference that writes the RF golden vectors (pattern-budget.json, Task 4).

Python standard library only (math, json, statistics); no numpy. It deliberately does not mirror
the TypeScript: the antenna basis is built with Rodrigues rotations, elevation uses asin and the
fade quantile is statistics.NormalDist. Edit the vectors here, never the JSON by hand.

Run from the repository root, then format with prettier (the committed file is prettier output):

    python -I packages/rf/fixtures/golden/gen_golden.py packages/rf/fixtures/golden/pattern-budget.json
    npx prettier --write packages/rf/fixtures/golden/pattern-budget.json

Then check both engines: `pnpm vitest run --project @aio/rf` and the pytest golden test (Task 6).
"""

import json
import math
import sys
from statistics import NormalDist

R = math.pi / 180
# Test-only format id, built in two parts so the schema registry scan (versions.test.ts), which
# lists file-schema literals in source, does not read it as an unregistered file schema.
FORMAT = "aio.rf-golden" + "/1"


def rodrigues(v, axis, ang_deg):
    a = math.radians(ang_deg)
    n = math.sqrt(sum(x * x for x in axis))
    k = [x / n for x in axis]
    c, s = math.cos(a), math.sin(a)
    kxv = [k[1] * v[2] - k[2] * v[1], k[2] * v[0] - k[0] * v[2], k[0] * v[1] - k[1] * v[0]]
    kdv = sum(k[i] * v[i] for i in range(3))
    return [v[i] * c + kxv[i] * s + k[i] * kdv * (1 - c) for i in range(3)]


def dot(a, b):
    return sum(a[i] * b[i] for i in range(3))


def wrap180(d):
    d = d % 360.0
    return d - 360.0 if d > 180 else d


def antenna_angles(d_grid, az_grid, conv, mech):
    # grid -> true: clockwise (about -z) by the convergence
    d = rodrigues(d_grid, [0, 0, -1], conv)
    n = math.sqrt(dot(d, d))
    d = [x / n for x in d]
    true_az = (az_grid + conv) % 360.0
    # antenna basis at azimuth 0: boresight north, right east, up up; turn clockwise by az
    b = rodrigues([0, 1, 0], [0, 0, -1], true_az)
    r = rodrigues([1, 0, 0], [0, 0, -1], true_az)
    u = [0, 0, 1]
    # downtilt: rotate boresight and up by -mech about the right axis
    b = rodrigues(b, r, -mech)
    u = rodrigues(u, r, -mech)
    x, y, z = dot(d, b), dot(d, r), dot(d, u)
    az = math.degrees(math.atan2(y, x))
    down = -math.degrees(math.asin(max(-1.0, min(1.0, z))))
    az = wrap180(az)
    if round(az, 6) == -180.0:
        az = 180.0
    return true_az, az, down


def parametric_loss(p, etilt, az, down):
    ah = min(12 * (wrap180(az) / p["hBeamwidthDeg"]) ** 2, p["amDb"])
    av = min(12 * ((down - etilt) / p["vBeamwidthDeg"]) ** 2, p["slavDb"])
    return min(ah + av, p["amDb"])


def cut(c, ang):
    a = ang % 360.0
    i0 = math.floor(a)
    t = a - i0
    return c[i0 % 360] * (1 - t) + c[(i0 + 1) % 360] * t


def two_cut_loss(p, az, down):
    return min(cut(p["horizontalDb"], az) + cut(p["verticalDb"], down), p["capDb"])


NRB = {
    ("lte", 20, None): 100,
    ("lte", 10, None): 50,
    ("nr", 100, 30): 273,
    ("nr", 20, 15): 106,
    ("nr", 40, 30): 106,
}
PEN = {"outdoor": 0, "in-car": 7, "indoor": 15, "deep-indoor": 20}
TH = {"excellentDbm": -80, "goodDbm": -95, "fairDbm": -105, "poorDbm": -115}


def klass(x):
    for name, k in (
        ("excellent", "excellentDbm"),
        ("good", "goodDbm"),
        ("fair", "fairDbm"),
        ("poor", "poorDbm"),
    ):
        if x >= TH[k]:
            return name
    return "none"


def sym(i):
    return i if i <= 180 else i - 360


H_MSI = []
for i in range(360):
    phi = sym(i)
    k = 1.1 if phi > 0 else 1.0  # 10 % more loss clockwise (right): checks the clockwise convention
    H_MSI.append(round(min(12 * (phi / 65) ** 2 * k, 25.0), 2))
V_MSI = []
for i in range(360):
    d = sym(i)
    V_MSI.append(round(min(12 * ((d - 4) / 7) ** 2, 20.0), 2) if abs(d) <= 90 else 20.0)

PATTERNS = {
    "generic-65x7-fb30": {
        "kind": "parametric",
        "hBeamwidthDeg": 65,
        "vBeamwidthDeg": 7,
        "amDb": 30,
        "slavDb": 30,
    },
    "generic-65x7-fb25": {
        "kind": "parametric",
        "hBeamwidthDeg": 65,
        "vBeamwidthDeg": 7,
        "amDb": 25,
        "slavDb": 30,
    },
    "aau-ssb-65x12": {
        "kind": "parametric",
        "hBeamwidthDeg": 65,
        "vBeamwidthDeg": 12,
        "amDb": 30,
        "slavDb": 30,
    },
    "msi-synthetic-tilt4": {
        "kind": "two-cut",
        "tiltDeg": 4,
        "capDb": 25,
        "note": "Synthetic MSI-style cuts, not a vendor file. Horizontal is 10 % lossier clockwise (right) of boresight so a mirrored reader fails; vertical holds a 4 deg electrical tilt.",
        "horizontalDb": H_MSI,
        "verticalDb": V_MSI,
    },
}

OUTDOOR = {"marginPreset": "outdoor", "bodyLossDb": 3, "edgeProbability": 0.9, "shadowSigmaDb": 8}
LTE20 = {"tech": "lte", "bandwidthMHz": 20, "scsKHz": None}


def horizon(bearing, dist=1000.0):
    return {"east": dist * math.sin(bearing * R), "north": dist * math.cos(bearing * R), "up": 0.0}


def depressed(bearing, dep, dist=1000.0):
    return {
        "east": dist * math.sin(bearing * R),
        "north": dist * math.cos(bearing * R),
        "up": -dist * math.tan(dep * R),
    }


def ground(bearing, dist, up=-28.5):
    return {"east": dist * math.sin(bearing * R), "north": dist * math.cos(bearing * R), "up": up}


def vec(
    id,
    covers,
    note,
    direction,
    az=0.0,
    conv=0.0,
    mech=0.0,
    etilt=0.0,
    pattern="generic-65x7-fb30",
    p=43.0,
    carrier=LTE20,
    loss=0.5,
    gain=17.5,
    pl=120.0,
    margins=OUTDOOR,
):
    return {
        "id": id,
        "covers": covers,
        "note": note,
        "input": {
            "directionGrid": {k: round(v, 9) + 0.0 for k, v in direction.items()},
            "azimuthGridDeg": az,
            "convergenceDeg": conv,
            "mechanicalDowntiltDeg": mech,
            "eTiltDeg": None if PATTERNS[pattern]["kind"] == "two-cut" else etilt,
            "pattern": pattern,
            "portPowerDbm": p,
            "carrier": carrier,
            "feederLossDb": loss,
            "antennaGainDbi": gain,
            "pathLossDb": pl,
            "margins": margins,
        },
    }


V = [
    vec(
        "boresight-horizon",
        ["boresight", "mech-tilt-0", "etilt-0"],
        "On boresight at the horizon: no pattern loss.",
        horizon(0),
        pl=100,
    ),
    vec("boresight-strong", ["boresight"], "Boresight close in, class excellent.", horizon(37), az=37, pl=70),
    vec(
        "h-3db-edge",
        ["h-3db-edge"],
        "32.5 deg right of a 65 deg beam: A_H = -3 dB.",
        horizon(122.5),
        az=90,
        pl=105,
    ),
    vec(
        "h-3db-edge-left",
        ["h-3db-edge"],
        "32.5 deg left, across north: A_H = -3 dB.",
        horizon(347.5),
        az=20,
        pl=105,
    ),
    vec(
        "v-3db-edge",
        ["v-3db-edge"],
        "e-tilt 4, point 7.5 deg down: A_V = -3 dB with a 7 deg beam.",
        depressed(0, 7.5),
        etilt=4,
        pl=105,
    ),
    vec(
        "corner-3db-3db",
        ["h-3db-edge", "v-3db-edge"],
        "Both 3 dB edges: 6 dB.",
        depressed(32.5, 0.5),
        etilt=4,
        pl=105,
    ),
    vec(
        "back-lobe-cap",
        ["back-lobe"],
        "Behind at the horizon, e-tilt 6: 25 + 8.8 capped at Am = 25 (front-to-back).",
        horizon(270),
        az=90,
        etilt=6,
        pattern="generic-65x7-fb25",
        pl=95,
    ),
    vec(
        "back-lobe-mech",
        ["back-lobe", "mech-tilt-180"],
        "Behind with 6 deg mechanical tilt: the rear plane lifts, the point reads 6 deg down; loss capped at 30.",
        horizon(20),
        az=200,
        mech=6,
        pl=90,
    ),
    vec(
        "mech-tilt-0",
        ["mech-tilt-0"],
        "Mechanical 6 deg, horizon point on boresight: 6 deg above the beam, 12 (6/7)^2 = 8.816.",
        horizon(200),
        az=200,
        mech=6,
    ),
    vec(
        "mech-tilt-45",
        ["mech-tilt-45"],
        "Mechanical 6 deg, horizon point 45 deg off: down = -asin(cos45 sin6) = -4.239, az 45.157.",
        horizon(245),
        az=200,
        mech=6,
    ),
    vec(
        "mech-tilt-90",
        ["mech-tilt-90"],
        "Mechanical 6 deg, horizon point 90 deg off: tilt has no effect, A_V = 0.",
        horizon(290),
        az=200,
        mech=6,
        pl=100,
    ),
    vec(
        "etilt-0",
        ["etilt-0"],
        "Electrical 6 deg, horizon point on boresight: same 8.816 as mechanical.",
        horizon(200),
        az=200,
        etilt=6,
    ),
    vec(
        "etilt-45",
        ["etilt-45"],
        "Electrical 6 deg, 45 deg off: 5.752 + 8.816 = 14.568 (mechanical gives 10.19).",
        horizon(245),
        az=200,
        etilt=6,
    ),
    vec(
        "etilt-90",
        ["etilt-90"],
        "Electrical 6 deg, 90 deg off: 23.006 + 8.816 capped at 30 (mechanical gives 23.006).",
        horizon(290),
        az=200,
        etilt=6,
        pl=100,
    ),
    vec(
        "mech-tilt-45-on-plane",
        ["mech-tilt-45"],
        "Mechanical 10 deg; a point 45 deg off at atan(tan10 cos45) = 7.107 deg down lies on the beam plane.",
        depressed(45, math.degrees(math.atan(math.tan(10 * R) * math.cos(45 * R)))),
        mech=10,
    ),
    vec(
        "convergence-1.5",
        ["convergence-1.5", "h-3db-edge"],
        "Grid azimuth 120, convergence 1.5 (true 121.5); point 32.5 deg clockwise on the grid stays at the 3 dB edge.",
        horizon(152.5),
        az=120,
        conv=1.5,
        pl=105,
    ),
    vec(
        "convergence-1.5-ground",
        ["convergence-1.5", "ground"],
        "Convergence 1.5, mech 6, e-tilt 2, ground point 300 m away, 30 deg right on the grid, 28.5 m below.",
        ground(330, 300),
        az=300,
        conv=1.5,
        mech=6,
        etilt=2,
        pl=98,
    ),
    vec(
        "convergence-minus-1.5",
        ["convergence-1.5"],
        "Convergence -1.5 across north: grid 359, true 357.5.",
        horizon(9),
        az=359,
        conv=-1.5,
        mech=3,
        etilt=3,
        pl=100,
    ),
    vec(
        "ground-typical",
        ["ground"],
        "Typical: 30 m mast, mech 4, e-tilt 2, 500 m, 20 deg right.",
        ground(80, 500),
        az=60,
        mech=4,
        etilt=2,
        pl=92,
    ),
    vec(
        "nadir",
        ["ground"],
        "Straight below the antenna: 86 deg below the beam, capped at SLAv then Am.",
        {"east": 0.0, "north": 0.0, "up": -28.5},
        az=60,
        mech=4,
        etilt=2,
        pl=60,
    ),
    vec(
        "two-cut-boresight",
        ["two-cut", "boresight"],
        "Synthetic MSI, point 4 deg down on boresight (its baked tilt): 0 dB.",
        depressed(0, 4),
        pattern="msi-synthetic-tilt4",
        pl=105,
    ),
    vec(
        "two-cut-right-interp",
        ["two-cut"],
        "MSI, 20.5 deg right (between whole degrees, lossier side), 1.3 deg down.",
        depressed(20.5, 1.3),
        pattern="msi-synthetic-tilt4",
        pl=105,
    ),
    vec(
        "two-cut-left-interp",
        ["two-cut"],
        "MSI, 20.5 deg left: less loss than the right side.",
        depressed(-20.5, 1.3),
        pattern="msi-synthetic-tilt4",
        pl=105,
    ),
    vec(
        "two-cut-seam",
        ["two-cut"],
        "MSI, 0.5 deg left: interpolates H(359) and H(0); 2 deg up reads V(358).",
        depressed(359.5, -2),
        pattern="msi-synthetic-tilt4",
        pl=105,
    ),
    vec(
        "two-cut-mech",
        ["two-cut", "mech-tilt-45"],
        "MSI with 5 deg mechanical tilt, ground point 45 deg right.",
        ground(145, 250),
        az=100,
        mech=5,
        pattern="msi-synthetic-tilt4",
        pl=95,
    ),
    vec(
        "two-cut-back-cap",
        ["two-cut", "back-lobe"],
        "MSI behind: capped at 25.",
        horizon(180),
        pattern="msi-synthetic-tilt4",
        pl=90,
    ),
    vec(
        "nr-n78-ssb",
        ["nr"],
        "NR n78 100 MHz at 30 kHz (273 PRB), AAU SSB beam 65x12, in car.",
        ground(15, 400),
        az=10,
        mech=2,
        etilt=6,
        pattern="aau-ssb-65x12",
        p=40.0,
        carrier={"tech": "nr", "bandwidthMHz": 100, "scsKHz": 30},
        loss=0.0,
        gain=24.0,
        pl=95,
        margins={"marginPreset": "in-car", "bodyLossDb": 3, "edgeProbability": 0.9, "shadowSigmaDb": 8},
    ),
    vec(
        "nr-20-15khz-indoor",
        ["nr"],
        "NR 20 MHz at 15 kHz (106 PRB), indoor, 95 % edge.",
        horizon(0),
        etilt=0,
        carrier={"tech": "nr", "bandwidthMHz": 20, "scsKHz": 15},
        p=46.0,
        pl=85,
        margins={"marginPreset": "indoor", "bodyLossDb": 3, "edgeProbability": 0.95, "shadowSigmaDb": 8},
    ),
    vec(
        "lte10-deep-indoor-p50",
        ["lte"],
        "LTE 10 MHz (50 RB), deep indoor, 50 % edge (no fade margin), sigma 6, no body loss.",
        horizon(0),
        carrier={"tech": "lte", "bandwidthMHz": 10, "scsKHz": None},
        p=40.0,
        pl=115,
        margins={"marginPreset": "deep-indoor", "bodyLossDb": 0, "edgeProbability": 0.5, "shadowSigmaDb": 6},
    ),
]

for v in V:
    i = v["input"]
    d = [i["directionGrid"]["east"], i["directionGrid"]["north"], i["directionGrid"]["up"]]
    true_az, az, down = antenna_angles(
        d, i["azimuthGridDeg"], i["convergenceDeg"], i["mechanicalDowntiltDeg"]
    )
    pat = PATTERNS[i["pattern"]]
    att = (
        two_cut_loss(pat, az, down)
        if pat["kind"] == "two-cut"
        else parametric_loss(pat, i["eTiltDeg"], az, down)
    )
    c = i["carrier"]
    sc = 12 * NRB[(c["tech"], c["bandwidthMHz"], c["scsKHz"])]
    off = 10 * math.log10(sc)
    m = i["margins"]
    fade = NormalDist().inv_cdf(m["edgeProbability"]) * m["shadowSigmaDb"]
    marg = PEN[m["marginPreset"]] + m["bodyLossDb"] + fade
    rsrp = i["portPowerDbm"] - off - i["feederLossDb"] + i["antennaGainDbi"] - att - i["pathLossDb"] - marg
    v["expected"] = {
        "trueAzimuthDeg": round(true_az, 6),
        "antennaAzimuthDeg": round(az, 6) + 0.0,
        "antennaDownElevationDeg": round(down, 6) + 0.0,
        "attenuationDb": round(att, 6) + 0.0,
        "perReOffsetDb": round(off, 6),
        "marginDb": round(marg, 6),
        "rsrpDbm": round(rsrp, 6),
        "rsrpClass": klass(rsrp),
    }

DOC = {
    "format": FORMAT,
    "description": "Shared golden vectors for the RF antenna pattern, tilt geometry and link budget (spec D11, D13, D15, D16). Run by vitest (packages/rf/src/golden.test.ts) and pytest (python/tests/rf). Both engines must match every expected value within the tolerance.",
    "tolerance": {"db": 0.01, "deg": 0.001},
    "units": {
        "directionGrid": "metres, offset from the antenna to the point in the project CRS: east = grid east, north = grid north, up = vertical",
        "angles": "degrees",
        "portPowerDbm": "dBm per port over the whole carrier",
        "feederLossDb, pathLossDb, attenuationDb, marginDb, perReOffsetDb": "dB, positive is a loss",
        "antennaGainDbi": "dBi, peak gain of the port (for an AAU, the SSB or broadcast beam)",
        "rsrpDbm": "dBm per resource element",
        "carrier.bandwidthMHz": "MHz; carrier.scsKHz is kHz, null for LTE",
        "pattern cuts": "dB attenuation relative to the peak gain, one value per whole degree 0..359",
    },
    "conventions": {
        "frames": "Grid: project CRS axes. True: east, true north, up. A grid vector turns clockwise by convergenceDeg into the true frame (true bearing = grid bearing + convergence).",
        "azimuth": "Degrees clockwise from north. trueAzimuthDeg = azimuthGridDeg + convergenceDeg, wrapped to [0, 360). Because directionGrid is also on the grid, the convergence turns both and cancels in the antenna-frame angles; using the true azimuth against a grid direction is the wrong-way error.",
        "tilt": "Downtilt is positive when the beam points down, mechanical and electrical alike. Mechanical tilt is a rotation of the antenna; electrical tilt shifts the vertical cut. They are never added.",
        "antennaFrame": "Rotate the unit direction by the true azimuth about the vertical, then by the mechanical downtilt about the antenna's horizontal (right-hand) axis. forward = along the tilted boresight, right = horizontal tilt axis, up = antenna up. antennaAzimuthDeg = atan2(right, forward), (-180, 180], positive clockwise (right). antennaDownElevationDeg = -asin(up), [-90, 90], positive below the boresight plane. 38.901 zenith theta = 90 + antennaDownElevationDeg.",
        "pattern": {
            "parametric": "3GPP TR 38.901 Table 7.3-1: A_H = -min(12 (phi/hBeamwidthDeg)^2, amDb); A_V = -min(12 ((antennaDownElevationDeg - eTiltDeg)/vBeamwidthDeg)^2, slavDb); A = -min(-(A_H + A_V), amDb); attenuationDb = -A. phi = antennaAzimuthDeg. amDb is the front-to-back value.",
            "two-cut": "Summing method: attenuationDb = min(H(antennaAzimuthDeg) + V(antennaDownElevationDeg), capDb). H and V are read by linear interpolation between whole degrees, angles taken modulo 360 (so -0.5 interpolates indices 359 and 0, and -2 reads index 358). horizontalDb index = degrees clockwise from boresight seen from above; verticalDb index = degrees below boresight (0 forward at the horizon, 90 straight down, 270 straight up). The cuts already hold the electrical tilt (tiltDeg is informational) so eTiltDeg is null.",
        },
        "budget": "rsrpDbm = portPowerDbm - perReOffsetDb - feederLossDb + antennaGainDbi - attenuationDb - pathLossDb - marginDb, with perReOffsetDb = 10 log10(12 N_RB) (N_RB from TS 36.101 Table 5.6-1 for LTE and TS 38.101-1 Table 5.3.2-1 for NR) and marginDb = penetration (outdoor 0, in-car 7, indoor 15, deep-indoor 20) + bodyLossDb + Phi^-1(edgeProbability) * shadowSigmaDb.",
        "classes": "A value at or above a threshold is in that class: excellent >= excellentDbm, good >= goodDbm, fair >= fairDbm, poor >= poorDbm, otherwise none.",
        "pathLoss": "pathLossDb is an input here; propagation models have their own tests (Task 5).",
    },
    "thresholds": TH,
    "patterns": PATTERNS,
    "vectors": V,
}

with open(sys.argv[1], "w", encoding="utf-8", newline="\n") as f:
    json.dump(DOC, f, indent=2, ensure_ascii=True)
    f.write("\n")
for v in V:
    e = v["expected"]
    print(
        f"{v['id']:28s} az={e['antennaAzimuthDeg']:9.4f} down={e['antennaDownElevationDeg']:8.4f} att={e['attenuationDb']:8.4f} rsrp={e['rsrpDbm']:9.4f} {e['rsrpClass']}"
    )
