"""The survey engine's shared fixtures (packages/schema/src/__fixtures__/survey/), synthetic only.

    uv run python tests/survey_fixtures.py        # (from python/) writes the fixtures

Small analytic grids and TINs at a fictional site, polygons, comparison items and the results of
the Python reference core (``survey/compare.py``). The TypeScript executor's parity test
(``packages/survey/src/engine/parity.test.ts``) runs the same cases and must agree to 1e-6
relative; ``test_survey_fixtures.py`` checks the Python core still reproduces them. The format is
in the folder's README.
"""

from __future__ import annotations

import json
import math
import sys
from pathlib import Path
from typing import Any

import numpy as np

HERE = Path(__file__).resolve().parent
OUT = HERE.parent.parent / "packages" / "schema" / "src" / "__fixtures__" / "survey"
sys.path.insert(0, str(HERE.parent / "src"))

from aio_pipelines.runtime import JobError  # noqa: E402
from aio_pipelines.similarity import Similarity  # noqa: E402
from aio_pipelines.survey.compare import Resolved, compare_item  # noqa: E402
from aio_pipelines.survey.grid import TILE, ArraySurface, encode_tile  # noqa: E402
from aio_pipelines.survey.series import base_spread, compare_series, spread_pct  # noqa: E402

#: A fictional desert site, UTM 31N (the demo's).
E0, N0 = 302000.0, 2574000.0
SCALE = 2.0**-10
SITE = {"verticalDatum": {"kind": "project"}}
NOW = "2026-10-09T00:00:00Z"


def grid(
    name: str, fp: str, cell: float, nx: int, ny: int, fn, base: float = 100.0, de=0.0, dn=0.0, hole=None
):
    """A grid surface with heights quantised to 2**-10 m above ``base`` (exact in float32)."""
    xs = (np.arange(nx) + 0.5) * cell + de
    ys = (np.arange(ny) + 0.5) * cell + dn
    X, Y = np.meshgrid(xs, ys)
    h = fn(X, Y)
    k = np.round((h - base) / SCALE).astype(np.int64)
    z: list[int | None] = [int(v) for v in k.reshape(-1)]
    if hole is not None:
        mask = hole(X, Y).reshape(-1)
        z = [None if m else v for v, m in zip(z, mask, strict=True)]
    return {
        "kind": "grid",
        "name": name,
        "fingerprint": fp,
        "originE": E0 + de,
        "originN": N0 + dn,
        "cellM": cell,
        "nx": nx,
        "ny": ny,
        "base": base,
        "scale": SCALE,
        "z": z,
    }


def cone(cx, cy, r, h, floor=100.0):
    return lambda X, Y: floor + np.clip(h * (1 - np.hypot(X - cx, Y - cy) / r), 0, None)


def tin(name, fp, vertices, triangles, offset=0.0):
    return {
        "kind": "tin",
        "name": name,
        "fingerprint": fp,
        "vertices": [[E0 + v[0], N0 + v[1], v[2]] for v in vertices],
        "triangles": triangles,
        "offsetM": offset,
    }


def pad_tin(top: float, half: float, toe: float, cx=10.0, cy=10.0, floor=100.0):
    """A flat-topped pad: a square top at ``top`` within ``half`` of the centre, batters to ``toe``."""
    v = []
    for s in (half, toe):
        z = top if s == half else floor
        v += [[cx - s, cy - s, z], [cx + s, cy - s, z], [cx + s, cy + s, z], [cx - s, cy + s, z]]
    t = [[0, 1, 2], [0, 2, 3]]
    for k in range(4):
        a, b = k, (k + 1) % 4
        t += [[4 + a, 4 + b, b], [4 + a, b, a]]
    return v, t


def surfaces() -> dict[str, Any]:
    s: dict[str, Any] = {}
    s["flat"] = grid("Flat ground", "fp-flat", 0.5, 40, 40, lambda X, Y: 100.0 + 0 * X)
    s["cone"] = grid("Cone survey", "fp-cone", 0.5, 40, 40, cone(10, 10, 7, 4))
    s["mound"] = grid(
        "Mound on a slope",
        "fp-mound",
        0.5,
        40,
        40,
        lambda X, Y: (
            100.0 + 0.05 * X - 0.03 * Y + np.clip(3 * (1 - np.hypot(X - 9, Y - 11) / 6), 0, None) ** 1.5
        ),
    )
    rng = np.random.default_rng(7)
    noise = rng.uniform(-0.02, 0.02, (40, 40))
    s["noise"] = grid("Noisy flat", "fp-noise", 0.5, 40, 40, lambda X, Y: 100.0 + noise)
    s["pit"] = grid(
        "Pit",
        "fp-pit",
        0.5,
        40,
        40,
        lambda X, Y: 100.0 - np.clip(2 * (1 - np.maximum(abs(X - 10), abs(Y - 10)) / 5), 0, None),
    )
    s["cone-holes"] = grid(
        "Cone with holes",
        "fp-cone-holes",
        0.5,
        40,
        40,
        cone(10, 10, 7, 4),
        hole=lambda X, Y: (X > 14) & (Y > 14),
    )
    # a coarser, shifted grid: sampled bilinearly from the cone's cells
    s["slope-coarse"] = grid(
        "Coarse slope",
        "fp-slope-coarse",
        1.0,
        22,
        22,
        lambda X, Y: 99.0 + 0.1 * X + 0.05 * Y,
        de=-0.75,
        dn=-1.25,
    )
    v, t = pad_tin(102.0, 3.0, 6.0)
    s["pad/top"] = tin("Pad design, Finished level", "fp-pad-top", v, t)
    s["pad/sub"] = tin("Pad design, Subgrade", "fp-pad-sub", v, t, offset=-0.3)
    v2, t2 = pad_tin(101.0, 4.0, 7.5, cx=10.5, cy=9.5)
    s["pad2/top"] = tin("Second pad, Top", "fp-pad2-top", v2, t2)
    return s


def circle(cx, cy, r, n=24, rot=0.0):
    return [
        [E0 + cx + r * math.cos(rot + 2 * math.pi * k / n), N0 + cy + r * math.sin(rot + 2 * math.pi * k / n)]
        for k in range(n)
    ]


def rect(x0, y0, x1, y1):
    return [[E0 + x0, N0 + y0], [E0 + x1, N0 + y0], [E0 + x1, N0 + y1], [E0 + x0, N0 + y1]]


def rotated_rect(cx, cy, w, h, a):
    c, s = math.cos(a), math.sin(a)
    pts = [(-w / 2, -h / 2), (w / 2, -h / 2), (w / 2, h / 2), (-w / 2, h / 2)]
    return [[E0 + cx + x * c - y * s, N0 + cy + x * s + y * c] for x, y in pts]


#: A line-up turn of the fixtures: half a degree about a pivot 200 m south-west of the site, so it
#: moves the ring about two metres more than the shift alone.
TURN = {"rotationDeg": 0.5, "scale": 1.0, "pivotE": E0 - 200.0, "pivotN": N0 - 200.0}

SV = lambda sid: {"kind": "survey", "surface": sid}  # noqa: E731


def item(iid, frm, to, **kw):
    return {"id": iid, "from": frm, "to": to, "useDeadband": kw.pop("useDeadband", False), **kw}


L_SHAPE = [[E0 + x, N0 + y] for x, y in [(3, 3), (17, 3), (17, 9), (9.3, 9), (9.3, 17), (3, 17)]]


def cases() -> list[dict[str, Any]]:
    caps = {"current": {"surface": "cone", "capture": "c2"}, "previous": {"surface": "flat", "capture": "c1"}}
    c = []

    def add(cid, ring, it, note, **kw):
        c.append({"id": cid, "note": note, "ring": ring, "item": it, "site": SITE, **kw})

    ring = circle(10, 10, 8)
    add("cone-over-flat", ring, item("a", SV("flat"), SV("cone")), "Survey to survey, fill only")
    add("flat-over-cone", ring, item("a", SV("cone"), SV("flat")), "Survey to survey, cut only")
    # lined up: a survey-scoped ring is stored 2 m west and 1 m south of where its prepared surface
    # sits (shift 2 E, -1 N): sampled shifted it is the same ring as above; the dates' shifts now
    # (3.5, 0.5 for the ring's date) are in the fingerprint only
    add(
        "cone-over-flat-lined-up",
        circle(8, 11, 8),
        item("a", SV("flat"), SV("cone")),
        "A survey-scoped ring on a lined-up date: shifted before sampling, the shifts in the fingerprint",
        lineUp={
            "current": {"flat": [0.0, 0.0], "cone": [3.5, 0.5]},
            "ringShift": [2.0, -1.0],
            "ringCurrent": [3.5, 0.5],
        },
    )
    # turned: the same, with a 0.5 degree turn beside each shift (``lineUpTurn``, as a capture's
    # turn sits beside its ``lineUp``): the ring is stored where the line-up's inverse puts the
    # first case's ring, shifted and turned before sampling it is that ring again (the shift alone
    # would cut the cone); the turns join the fingerprint
    placed = Similarity.from_line_up({"eastM": 2.0, "northM": -1.0}, TURN)
    add(
        "cone-over-flat-turned",
        [list(placed.inverse().apply_en(e, n)) for e, n in ring],
        item("a", SV("flat"), SV("cone")),
        "A survey-scoped ring on a turned line-up: shifted and turned before sampling, the turns in the fingerprint",
        lineUp={
            "current": {"flat": [0.0, 0.0], "cone": [3.5, 0.5]},
            "ringShift": [2.0, -1.0],
            "ringCurrent": [3.5, 0.5],
        },
        lineUpTurn={
            "current": {"cone": TURN},
            "ring": TURN,
            "ringCurrent": {**TURN, "rotationDeg": 0.25},
        },
    )
    # prepared before the line-up: the surface has no dateShiftM, so the stored ring is sampled
    # where it is (no prepared shift or turn) while the date's line-up now (shift and turn) joins
    # the fingerprint; the result is the first case's volume, read stale
    add(
        "cone-over-flat-prepared-before-line-up",
        ring,
        item("a", SV("flat"), SV("cone")),
        "A survey-scoped ring whose surface was prepared before its date was lined up: sampled as stored, the line-up now in the fingerprint",
        lineUp={"current": {"cone": [2.0, -1.0]}, "ringShift": [0.0, 0.0], "ringCurrent": [2.0, -1.0]},
        lineUpTurn={"current": {"cone": TURN}, "ringCurrent": TURN},
    )
    # only the turn now is given for the ring: it is enough to put the current line-up in the
    # fingerprint (with the prepared shift)
    add(
        "cone-over-flat-turn-now-only",
        ring,
        item("a", SV("flat"), SV("cone")),
        "A ring whose date's turn now is given without its shift now: the turn joins the fingerprint",
        lineUp={"ringShift": [0.0, 0.0]},
        lineUpTurn={"ringCurrent": TURN},
    )
    add(
        "previous-current",
        ring,
        item("a", {"kind": "previous"}, {"kind": "current"}),
        "Captures",
        captures=caps,
    )
    for b in (
        {"kind": "smart"},
        {"kind": "fit-plane"},
        {"kind": "perimeter-mean"},
        {"kind": "reference", "mode": "perimeter-min"},
        {"kind": "reference", "mode": "perimeter-max"},
        {"kind": "reference", "mode": "interior-min"},
        {"kind": "reference", "mode": "interior-max"},
        {"kind": "reference", "mode": "level", "levelM": 101.25},
    ):
        name = b["kind"] if b["kind"] != "reference" else f"reference-{b['mode']}"
        add(
            f"mound-{name}",
            circle(9, 11, 7.2, 30),
            item("a", b, SV("mound")),
            f"Base {name} on a sloped mound",
        )
    add(
        "mound-to-base",
        circle(9, 11, 7.2, 30),
        item("a", SV("mound"), {"kind": "fit-plane"}),
        "A base on the To side (sampled on From)",
    )
    add(
        "rect-smart",
        rect(2, 3, 17.5, 18),
        item("a", {"kind": "smart"}, SV("mound")),
        "A rectangle: its densified edge has many cocircular points",
    )
    add(
        "rotated-smart",
        rotated_rect(10, 10, 12, 8, 0.4),
        item("a", {"kind": "smart"}, SV("cone")),
        "A rotated rectangle, smart base",
    )
    add("l-shape-cone", L_SHAPE, item("a", SV("flat"), SV("cone")), "A concave polygon")
    add(
        "custom-base",
        circle(10, 10, 8, 6),
        item(
            "a",
            {
                "kind": "custom",
                "vertices": [
                    {"e": p[0], "n": p[1], **({"z": 100.2} if k % 2 else {"offsetM": -0.1})}
                    for k, p in enumerate(circle(10, 10, 8, 6))
                ],
            },
            SV("cone"),
        ),
        "Custom base: absolute heights and offsets from the surface",
    )
    add(
        "deadband-noise",
        rect(2, 2, 18, 18),
        item("a", SV("flat"), SV("noise"), deadbandM=0.05, useDeadband=True),
        "Noise below the deadband gives exactly zero",
    )
    add(
        "deadband-off",
        rect(2, 2, 18, 18),
        item("a", SV("flat"), SV("noise"), deadbandM=0.05, useDeadband=False),
        "The same without using the deadband",
    )
    add(
        "deadband-cone",
        ring,
        item("a", SV("flat"), SV("cone"), deadbandM=0.5, useDeadband=True),
        "A deadband removes the low rim of the cone",
    )
    add("pit-cut", circle(10, 10, 6), item("a", SV("flat"), SV("pit")), "A pit: cut")
    add("partial", circle(17, 10, 4), item("a", SV("flat"), SV("cone")), "About 10% outside the survey")
    add("refused", circle(19, 10, 4), item("a", SV("flat"), SV("cone")), "Over 20% outside the survey")
    add("holes", circle(10, 10, 8), item("a", SV("flat"), SV("cone-holes")), "Holes in the survey")
    add(
        "cell-coarser",
        ring,
        item("a", SV("flat"), SV("cone"), cellM=0.7),
        "An item cell that is not the surface's: bilinear sampling",
    )
    add(
        "two-grids",
        circle(9, 9, 6),
        item("a", SV("slope-coarse"), SV("cone")),
        "Two grids with different cells and origins",
    )
    add(
        "design-vs-survey",
        circle(10, 10, 5.5),
        item("a", {"kind": "design", "design": "pad", "layer": "top"}, SV("cone")),
        "A design TIN against a survey (grid path, barycentric)",
    )
    add(
        "design-level",
        circle(10, 10, 5.5),
        item(
            "a",
            {"kind": "reference", "mode": "level", "levelM": 100},
            {"kind": "design", "design": "pad", "layer": "top"},
        ),
        "TIN to a level: exact",
    )
    add(
        "design-design",
        rect(4.5, 4.5, 15.5, 15.5),
        item(
            "a",
            {"kind": "design", "design": "pad2", "layer": "top"},
            {"kind": "design", "design": "pad", "layer": "top"},
        ),
        "TIN to TIN: exact, cut and fill",
    )
    add(
        "design-offset",
        rect(4.5, 4.5, 15.5, 15.5),
        item(
            "a",
            {"kind": "design", "design": "pad", "layer": "sub"},
            {"kind": "design", "design": "pad", "layer": "top"},
        ),
        "A design and its offset copy: 0.3 m over the TIN",
    )
    add(
        "design-smart",
        circle(10, 10, 5, 12),
        item("a", {"kind": "smart"}, {"kind": "design", "design": "pad", "layer": "top"}, cellM=0.5),
        "A smart base on a design: exact path",
    )
    add(
        "design-deadband",
        rect(4.5, 4.5, 15.5, 15.5),
        item(
            "a",
            {"kind": "design", "design": "pad2", "layer": "top"},
            {"kind": "design", "design": "pad", "layer": "top"},
            deadbandM=0.25,
            useDeadband=True,
        ),
        "TIN to TIN with a deadband",
    )
    add(
        "crossing",
        [[E0 + 2, N0 + 2], [E0 + 18, N0 + 18], [E0 + 18, N0 + 2], [E0 + 2, N0 + 18]],
        item("a", SV("flat"), SV("cone")),
        "A polygon that crosses itself is refused",
    )
    return c


# ------------------------------------------------------------------------------------- resolving


def resolved(spec: dict[str, Any], capture: str | None = None) -> Resolved:
    if spec["kind"] == "grid":
        k = np.array([np.nan if v is None else float(v) for v in spec["z"]]).reshape(spec["ny"], spec["nx"])
        h = spec["base"] + k * spec["scale"]
        return Resolved(
            kind="grid",
            name=spec["name"],
            fingerprint=spec["fingerprint"],
            capture=capture,
            grid=ArraySurface(spec["originE"], spec["originN"], spec["cellM"], h),
        )
    v = np.array(spec["vertices"], dtype=np.float64)
    return Resolved(
        kind="tin",
        name=spec["name"],
        fingerprint=spec["fingerprint"],
        vertices=v,
        triangles=np.array(spec["triangles"], dtype=np.int64),
        offset=float(spec["offsetM"]),
    )


def resolver(surfs: dict[str, Any], case: dict[str, Any]):
    def resolve(ref: dict[str, Any]) -> Resolved:
        k = ref["kind"]
        if k == "survey":
            r = resolved(surfs[ref["surface"]], ref.get("capture"))
            shift = ((case.get("lineUp") or {}).get("current") or {}).get(ref["surface"], (0.0, 0.0))
            turn = ((case.get("lineUpTurn") or {}).get("current") or {}).get(ref["surface"])
            r.current = Similarity.from_line_up({"eastM": shift[0], "northM": shift[1]}, turn)
            return r
        if k in ("current", "previous"):
            c = case["captures"][k]
            return resolved(surfs[c["surface"]], c["capture"])
        return resolved(surfs[f"{ref['design']}/{ref['layer']}"])

    return resolve


def run_case(surfs: dict[str, Any], case: dict[str, Any]) -> dict[str, Any]:
    up = case.get("lineUp") or {}
    turn = case.get("lineUpTurn") or {}

    def line_up(shift, t):
        return Similarity.from_line_up({"eastM": shift[0], "northM": shift[1]}, t)

    r = compare_item(
        case["ring"],
        case["item"],
        resolver(surfs, case),
        case.get("site"),
        now=NOW,
        ring_shift=line_up(up.get("ringShift", (0.0, 0.0)), turn.get("ring")),
        ring_current=(
            line_up(up.get("ringCurrent", up.get("ringShift", (0.0, 0.0))), turn.get("ringCurrent"))
            if "ringCurrent" in up or "ringCurrent" in turn
            else None
        ),
    )
    r.pop("computedAt", None)
    r.pop("engine", None)
    return r


# ------------------------------------------------------------------- volume per date, base spread


def dates(*pairs: tuple[str, str | None]) -> list[dict[str, Any]]:
    """Survey dates in order: each capture and its prepared surface (``None``: none)."""
    return [{"capture": c, "surface": s} for c, s in pairs]


def at_resolver(surfs: dict[str, Any], ds: list[dict[str, Any]], capture: str):
    """The dates viewed on ``capture``, by ``ProjectSurfaces``' rules and with its messages."""
    caps = [d for d in ds if d["surface"] is not None]
    k = next((i for i, d in enumerate(caps) if d["capture"] == capture), -1)

    def resolve(ref: dict[str, Any]) -> Resolved:
        kind = ref["kind"]
        if kind == "survey":
            return resolved(surfs[ref["surface"]], ref.get("capture"))
        if kind in ("current", "previous"):
            j = k if kind == "current" else k - 1
            if k < 0 or j < 0:
                raise JobError(f"There is no {kind} survey with a prepared surface.")
            return resolved(surfs[caps[j]["surface"]], caps[j]["capture"])
        if kind == "design":
            return resolved(surfs[f"{ref['design']}/{ref['layer']}"])
        raise JobError(f'"{kind}" is not a surface.')

    return resolve


def series_cases() -> dict[str, list[dict[str, Any]]]:
    """Cases of ``series.json`` (without ``expected``): an item over every survey date, and the
    spread across bases. ``main`` fills ``expected`` and writes the file."""
    series: list[dict[str, Any]] = []
    spread: list[dict[str, Any]] = []
    cur, prev = {"kind": "current"}, {"kind": "previous"}
    smart = {"kind": "smart"}
    pad = {"kind": "design", "design": "pad", "layer": "top"}
    sub = {"kind": "design", "design": "pad", "layer": "sub"}

    def add(cid, ring, it, ds, note):
        series.append({"id": cid, "note": note, "ring": ring, "item": it, "site": SITE, "dates": ds})

    ring = circle(10, 10, 8)
    mound_ring = circle(9, 11, 7.2, 30)
    add(
        "smart-two-dates",
        ring,
        item("a", smart, cur),
        dates(("c1", "flat"), ("c2", "cone")),
        "A stockpile on two dates: nothing, then a cone",
    )
    add(
        "smart-three-dates",
        mound_ring,
        item("a", smart, cur),
        dates(("c1", "flat"), ("c2", "mound"), ("c3", "cone")),
        "A stockpile on three dates, each its own surface",
    )
    add(
        "previous-current-three-dates",
        ring,
        item("a", prev, cur),
        dates(("c1", "flat"), ("c2", "cone"), ("c3", "pit")),
        "Previous follows the date: the first date has none and is refused",
    )
    add(
        "refused-date-no-surface",
        mound_ring,
        item("a", smart, cur),
        dates(("c1", "cone"), ("c2", None), ("c3", "mound")),
        "A date with no prepared surface is refused, the others computed",
    )
    add(
        "previous-skips-a-date",
        ring,
        item("a", prev, cur),
        dates(("c1", "flat"), ("c2", None), ("c3", "cone")),
        "Previous is the date before with a prepared surface",
    )
    add(
        "partial-date",
        ring,
        item("a", SV("flat"), cur),
        dates(("c1", "cone"), ("c2", "cone-holes")),
        "A fixed survey to each date: the second has holes, partly outside the survey",
    )
    add(
        "outside-on-every-date",
        circle(19, 10, 4),
        item("a", SV("flat"), cur),
        dates(("c1", "cone"), ("c2", "mound")),
        "A polygon mostly outside the surveys is refused on every date",
    )
    add(
        "design-to-date",
        circle(10, 10, 5.5),
        item("a", pad, cur),
        dates(("c1", "cone"), ("c2", "mound"), ("c3", "pit")),
        "A fixed design side against each date (grid path)",
    )
    add(
        "date-to-design",
        circle(10, 10, 5.5),
        item("a", cur, sub),
        dates(("c1", "flat"), ("c2", "cone")),
        "Each date against a design with an offset",
    )
    add(
        "fixed-survey-with-capture",
        ring,
        item("a", {"kind": "survey", "surface": "flat", "capture": "c0"}, cur),
        dates(("c1", "pit"), ("c2", "cone"), ("c3", "mound")),
        "A survey pinned to its capture stays fixed",
    )

    def add_spread(cid, ring, it, note, ds=None, at="c1"):
        spread.append(
            {
                "id": cid,
                "note": note,
                "ring": ring,
                "item": it,
                "site": SITE,
                "dates": ds or dates(("c1", "mound")),
                "at": at,
            }
        )

    add_spread("mound-smart", mound_ring, item("a", smart, SV("mound")), "A mound on a slope: bases differ")
    add_spread(
        "cone-current",
        rotated_rect(10, 10, 12, 8, 0.4),
        item("a", {"kind": "fit-plane"}, cur),
        "The current date's cone, from a best-fit plane item",
        ds=dates(("c1", "flat"), ("c2", "cone")),
        at="c2",
    )
    add_spread(
        "partial-bases",
        circle(17, 10, 4),
        item("a", smart, SV("cone")),
        "Partly outside the survey: partial results count",
    )
    add_spread(
        "refused-bases",
        circle(19, 10, 4),
        item("a", smart, SV("cone")),
        "Mostly outside the survey: every base refused, no spread",
    )
    add_spread(
        "surface-to-surface",
        ring,
        item("a", SV("flat"), SV("cone")),
        "A surface-to-surface item has no spread",
    )
    add_spread(
        "base-on-to-side",
        mound_ring,
        item("a", SV("mound"), {"kind": "fit-plane"}),
        "A base on the To side: no spread (only From is replaced)",
    )
    add_spread("flat-zero", ring, item("a", smart, SV("flat")), "Flat ground: a zero mean, no spread")
    add_spread(
        "design-exact",
        circle(10, 10, 5, 12),
        item("a", smart, pad, cellM=0.5),
        "Bases on a design: the exact path",
    )
    # the spread formula on totals alone: with SPREAD_BASES a single ok base cannot happen on a
    # surface (the two perimeter levels need the same samples and coverage), so it is pinned here
    formula = [
        {"id": "one-total", "note": "One ok base: no spread", "totals": [120.0]},
        {"id": "no-totals", "note": "No ok base: no spread", "totals": []},
        {"id": "hand", "note": "(300 - 100) / 2 / 200 = 50 %", "totals": [100.0, 200.0, 300.0]},
        {"id": "equal", "note": "Bases agree: 0 %", "totals": [80.0, 80.0]},
        {"id": "zero-mean", "note": "A mean below 1e-6 m3 counts as 0", "totals": [0.0, 1e-7]},
    ]
    return {"series": series, "spread": spread, "formula": formula}


def run_series(surfs: dict[str, Any], doc: dict[str, list[dict[str, Any]]]) -> None:
    """Fills ``expected`` of every case of ``doc`` (``series_cases()``) from the Python core."""
    for case in doc["series"]:
        rs = compare_series(
            case["ring"],
            case["item"],
            lambda c, case=case: at_resolver(surfs, case["dates"], c),
            [d["capture"] for d in case["dates"]],
            case.get("site"),
            now=NOW,
        )
        for r in rs:
            r.pop("computedAt", None)
            r.pop("engine", None)
        case["expected"] = rs
    for case in doc["spread"]:
        case["expected"] = base_spread(
            case["ring"],
            case["item"],
            at_resolver(surfs, case["dates"], case["at"]),
            case.get("site"),
            now=NOW,
        )
    for case in doc["formula"]:
        case["expected"] = spread_pct(case["totals"])


def prepared_tiles(spec: dict[str, Any]) -> tuple[dict[str, Any], dict[str, bytes]]:
    """A fixture grid as prepared height tiles (one tile), for the TypeScript codec test."""
    k = np.array([np.nan if v is None else float(v) for v in spec["z"]]).reshape(spec["ny"], spec["nx"])
    h = np.full((TILE, TILE), np.nan)
    h[: spec["ny"], : spec["nx"]] = spec["base"] + k * spec["scale"]
    ok = np.isfinite(h)
    meta = {
        "schema": "aio.height-tiles/1",
        "id": "cone",
        "name": spec["name"],
        "source": {"kind": "dsm", "layer": "cone"},
        "crs": {"epsg": 32631},
        "cellM": spec["cellM"],
        "tileSize": TILE,
        "originE": spec["originE"],
        "originN": spec["originN"],
        "cols": 1,
        "rows": 1,
        "levels": 1,
        "bounds": [
            spec["originE"],
            spec["originN"],
            float(h[ok].min()),
            spec["originE"] + spec["nx"] * spec["cellM"],
            spec["originN"] + spec["ny"] * spec["cellM"],
            float(h[ok].max()),
        ],
        "tiles": ["0_0"],
        "fingerprint": spec["fingerprint"],
        "preparedAt": NOW,
    }
    return meta, {"0/0_0.bin": encode_tile(h)}


def main() -> None:
    surfs = surfaces()
    cs = cases()
    for case in cs:
        case["expected"] = run_case(surfs, case)
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "surfaces.json").write_text(json.dumps(surfs, separators=(",", ":")) + "\n", "utf-8", newline="")
    (OUT / "cases.json").write_text(json.dumps({"cases": cs}, indent=1) + "\n", "utf-8", newline="")
    sd = series_cases()
    run_series(surfs, sd)
    (OUT / "series.json").write_text(json.dumps(sd, indent=1) + "\n", "utf-8", newline="")
    meta, files = prepared_tiles(surfs["cone"])
    tdir = OUT / "tiles" / "cone"
    (tdir / "0").mkdir(parents=True, exist_ok=True)
    (tdir / "tiles.json").write_text(json.dumps(meta, indent=1) + "\n", "utf-8", newline="")
    for rel, data in files.items():
        (tdir / rel).write_bytes(data)
    # the repository formats JSON with prettier (the tests compare parsed JSON, not bytes)
    import shutil
    import subprocess

    npx = shutil.which("npx")
    if npx:
        subprocess.run([npx, "prettier", "--write", str(OUT)], check=False, capture_output=True)
    for case in cs:
        e = case["expected"]
        print(f"{case['id']:24s} {e['status']:8s} fill {e['fillM3']:10.4f} cut {e['cutM3']:10.4f}")
    for case in sd["series"]:
        print(f"{case['id']:30s}", [(r["status"], round(r["netM3"], 3)) for r in case["expected"]])
    for case in sd["spread"]:
        e = case["expected"]
        print(
            f"{case['id']:30s}", None if e is None else (round(e["pct"], 3), [n["base"] for n in e["nets"]])
        )


if __name__ == "__main__":
    main()
