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

from aio_pipelines.survey.compare import Resolved, compare_item  # noqa: E402
from aio_pipelines.survey.grid import TILE, ArraySurface, encode_tile  # noqa: E402

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
            return resolved(surfs[ref["surface"]], ref.get("capture"))
        if k in ("current", "previous"):
            c = case["captures"][k]
            return resolved(surfs[c["surface"]], c["capture"])
        return resolved(surfs[f"{ref['design']}/{ref['layer']}"])

    return resolve


def run_case(surfs: dict[str, Any], case: dict[str, Any]) -> dict[str, Any]:
    r = compare_item(case["ring"], case["item"], resolver(surfs, case), case.get("site"), now=NOW)
    r.pop("computedAt", None)
    r.pop("engine", None)
    return r


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


if __name__ == "__main__":
    main()
