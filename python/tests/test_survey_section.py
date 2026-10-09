"""survey.section (M11 G5): the cross-section sampler, DXF read back by ezdxf, CSV against the
TypeScript sampler on a shared fixture.

    uv run python tests/test_survey_section.py    # (from python/) writes the parity fixture

The parity fixture (``packages/survey/src/section/__fixtures__/section-parity.json``) samples G2's
shared surfaces (``packages/schema/src/__fixtures__/survey/surfaces.json``: a cone grid, the same
cone with holes, a pad design TIN and its offset copy) along one line; ``section.test.ts`` checks
the TypeScript sampler gives the same numbers, this file that the Python one and the CSV do.
"""

from __future__ import annotations

import csv
import json
import math
import sys
from pathlib import Path

import numpy as np
import pytest

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent / "src"))

from aio_pipelines.pipelines import all_pipelines  # noqa: E402
from aio_pipelines.runtime import JobError  # noqa: E402
from aio_pipelines.survey.grid import ArraySurface  # noqa: E402
from aio_pipelines.survey.section import (  # noqa: E402
    Profile,
    Section,
    default_step,
    layer_name,
    sample_section,
    stations,
)
from aio_pipelines.survey.tin import write_tin  # noqa: E402
from conftest import run_job  # noqa: E402
from survey_fixtures import E0, N0, prepared_tiles, resolved, surfaces  # noqa: E402

FIXTURE = (
    HERE.parent.parent / "packages" / "survey" / "src" / "section" / "__fixtures__" / "section-parity.json"
)
REFS = [
    {"kind": "survey", "surface": "cone"},
    {"kind": "survey", "surface": "cone-holes"},
    {"kind": "design", "design": "pad", "layer": "top"},
    {"kind": "design", "design": "pad", "layer": "sub"},
]
LINE = [[E0 + 1.3, N0 + 2.2], [E0 + 18.1, N0 + 16.9], [E0 + 12.4, N0 + 19.3]]


def _resolve(ref):
    s = surfaces()
    key = ref["surface"] if ref["kind"] == "survey" else f"{ref['design']}/{ref['layer']}"
    return resolved(s[key])


def parity_section() -> Section:
    return sample_section([tuple(p) for p in LINE], [(r, _resolve(r)) for r in REFS])


def _z(v: float) -> float | None:
    return float(v) if math.isfinite(v) else None


def parity_doc() -> dict:
    sec = parity_section()
    return {
        "note": "Written by python/tests/test_survey_section.py; checked by section.test.ts.",
        "surfaces": REFS,
        "line": LINE,
        "expected": {
            "stepM": sec.step,
            "chainage": [float(c) for c in sec.chainage],
            "e": [float(e) for e in sec.e],
            "n": [float(n) for n in sec.n],
            "profiles": [
                {"surface": p.key, "label": p.label, "z": [_z(v) for v in p.z]} for p in sec.profiles
            ],
        },
    }


# ------------------------------------------------------------------------------------- sampling


def test_stations_hold_every_vertex_at_most_a_step_apart():
    line = [(0.0, 0.0), (3.0, 4.0), (3.0, 4.0), (3.0, 10.1)]
    st, ch, es, ns = stations(line, 0.7)
    assert st == 0.7
    assert ch[0] == 0 and abs(ch[-1] - 11.1) < 1e-12
    assert 5.0 in list(ch)
    d = np.diff(ch)
    assert (d > 0).all() and (d <= 0.7 + 1e-12).all()
    assert np.allclose(np.hypot(np.diff(es), np.diff(ns)), d)
    assert default_step([0.5, None, 0.2]) == 0.1 and default_step([None]) == 0.5


def test_pins_on_a_plane_are_exact():
    def plane(x, y):
        return 100 + 0.3 * x - 0.2 * y

    n = 44
    xs = (np.arange(n) + 0.5) * 0.5
    X, Y = np.meshgrid(xs, xs)
    from aio_pipelines.survey.compare import Resolved

    r = Resolved(kind="grid", name="Plane", fingerprint="fp", grid=ArraySurface(E0, N0, 0.5, plane(X, Y)))
    sec = sample_section(
        [(E0 + 2.3, N0 + 3.1), (E0 + 17.9, N0 + 12.4)], [({"kind": "survey", "surface": "p"}, r)]
    )
    assert sec.step == 0.25
    truth = plane(sec.e - E0, sec.n - N0)
    assert np.abs(sec.profiles[0].z - truth).max() < 1e-9


def test_the_cone_section_matches_its_analytic_profile():
    """A cone (R 10, H 5) on a 0.1 m grid: within 1 mm of truth away from its apex and toe."""
    R, H, c = 10.0, 5.0, 0.1
    n = 300
    xs = (np.arange(n) + 0.5) * c
    X, Y = np.meshgrid(xs, xs)

    def cone(x, y):
        return 100 + np.clip(H * (1 - np.hypot(x - 15, y - 15) / R), 0, None)

    from aio_pipelines.survey.compare import Resolved

    r = Resolved(kind="grid", name="Cone", fingerprint="fp", grid=ArraySurface(E0, N0, c, cone(X, Y)))
    sec = sample_section(
        [(E0 + 2, N0 + 15.02), (E0 + 28, N0 + 15.02)], [({"kind": "survey", "surface": "c"}, r)]
    )
    rr = np.hypot(sec.e - E0 - 15, sec.n - N0 - 15)
    keep = (rr > 1) & (np.abs(rr - R) > 0.2)
    assert np.abs(sec.profiles[0].z - cone(sec.e - E0, sec.n - N0))[keep].max() < 1e-3


def test_the_parity_fixture_is_what_the_python_sampler_gives():
    doc = json.loads(FIXTURE.read_text("utf-8"))
    got = parity_doc()["expected"]
    exp = doc["expected"]
    assert got["stepM"] == exp["stepM"]
    for k in ("chainage", "e", "n"):
        assert np.allclose(got[k], exp[k], rtol=0, atol=1e-9)
    for g, e in zip(got["profiles"], exp["profiles"], strict=True):
        assert (g["surface"], g["label"]) == (e["surface"], e["label"])
        for a, b in zip(g["z"], e["z"], strict=True):
            assert (a is None) == (b is None)
            if a is not None:
                assert abs(a - b) < 1e-9
    # the fixture exercises data, no data, both surfaces kinds and an offset
    zs = [p["z"] for p in exp["profiles"]]
    assert all(any(v is not None for v in z) for z in zs)
    assert any(v is None for v in zs[1]) and any(v is None for v in zs[2])
    assert exp["profiles"][3]["label"] == "Pad design, Subgrade (offset -0.3 m)"


# -------------------------------------------------------------------------------------- pipeline


def _project(root: Path) -> None:
    """G2's fixture surfaces as a project: prepared tiles and a pad design with two layers."""
    s = surfaces()
    for sid in ("cone", "cone-holes"):
        meta, files = prepared_tiles(s[sid])
        meta["id"] = sid
        meta["fingerprint"] = s[sid]["fingerprint"]
        d = root / "survey" / "surfaces" / sid
        (d / "0").mkdir(parents=True, exist_ok=True)
        (d / "tiles.json").write_text(json.dumps(meta), "utf-8")
        for rel, data in files.items():
            (d / rel).write_bytes(data)
    tin = s["pad/top"]
    folder = root / "survey" / "designs" / "pad"
    folder.mkdir(parents=True)
    write_tin(folder / "top.tin", np.array(tin["vertices"]), np.array(tin["triangles"]), {"epsg": 32631})
    layer = {"kind": "surface", "file": "top.tin", "visible": True, "archived": False, "counts": {}}
    designs = {
        "schema": "aio.designs/1",
        "designs": [
            {
                "id": "pad",
                "name": "Pad design",
                "layers": [
                    {**layer, "id": "top", "name": "Finished level", "verticalOffsetM": 0},
                    {**layer, "id": "sub", "name": "Subgrade", "verticalOffsetM": -0.3},
                ],
            }
        ],
    }
    (root / "survey" / "designs.json").write_text(json.dumps(designs), "utf-8")


def _run(tmp_path: Path, fmt: str) -> tuple[Path, dict]:
    _project(tmp_path)
    out = tmp_path / "exports" / f"section.{'csv' if fmt == 'csv' else 'dxf'}"
    params = {"line": LINE, "surfaces": REFS, "format": fmt, "out": str(out)}
    result, _ = run_job(all_pipelines()["survey.section"], tmp_path, params)
    return out, result


def test_csv_values_equal_the_typescript_sampler(tmp_path):
    out, _ = _run(tmp_path, "csv")
    rows = list(csv.reader(out.read_text("utf-8").splitlines()))
    exp = json.loads(FIXTURE.read_text("utf-8"))["expected"]
    assert rows[0] == ["chainage_m", "e", "n", *[p["label"] for p in exp["profiles"]]]
    assert len(rows) - 1 == len(exp["chainage"])
    for k, row in enumerate(rows[1:]):
        assert abs(float(row[0]) - exp["chainage"][k]) < 1e-9
        assert abs(float(row[1]) - exp["e"][k]) < 1e-9
        for j, p in enumerate(exp["profiles"]):
            v = p["z"][k]
            assert (row[3 + j] == "") == (v is None)
            if v is not None:
                assert abs(float(row[3 + j]) - v) < 1e-9


@pytest.mark.parametrize("fmt", ["dxf-2d-xy", "dxf-2d-xz", "dxf-2d-yz", "dxf-3d-zup", "dxf-3d-yup"])
def test_dxf_reads_back_with_a_layer_per_surface_and_the_right_coordinates(tmp_path, fmt):
    import ezdxf

    out, result = _run(tmp_path, fmt)
    doc = ezdxf.readfile(out)
    assert doc.header["$INSUNITS"] == 6
    exp = json.loads(FIXTURE.read_text("utf-8"))["expected"]
    names = [layer_name(k, p["label"]) for k, p in enumerate(exp["profiles"])]
    assert result["outputs"]["section"]["layers"] == names
    for name in [*names, "Section chainage"]:
        assert doc.layers.has_entry(name)
    msp = doc.modelspace()
    ch = np.array(exp["chainage"])
    for k, p in enumerate(exp["profiles"]):
        z = np.array([np.nan if v is None else v for v in p["z"]])
        lines = msp.query(f'POLYLINE[layer=="{names[k]}"]')
        got = [tuple(v.dxf.location) for pl in lines for v in pl.vertices]
        ok = np.isfinite(z)
        assert len(got) == int(ok.sum()) or (k == 1 and len(got) <= int(ok.sum()))
        idx = np.nonzero(ok)[0][: len(got)]
        for (x, y, zz), i in zip(got, idx, strict=True):
            c, e, n, h = ch[i], exp["e"][i], exp["n"][i], z[i]
            want = {
                "dxf-2d-xy": (c, h, 0.0),
                "dxf-2d-xz": (c, 0.0, h),
                "dxf-2d-yz": (0.0, c, h),
                "dxf-3d-zup": (e, n, h),
                "dxf-3d-yup": (e, h, -n),
            }[fmt]
            assert max(abs(x - want[0]), abs(y - want[1]), abs(zz - want[2])) < 1e-6
        # chainage and elevation text
        assert len(msp.query(f'TEXT[layer=="{names[k]}"]')) > 0
    labels = [t.dxf.text for t in msp.query('TEXT[layer=="Section chainage"]')]
    assert labels[0] == "0.00"


def test_a_missing_surface_and_bad_parameters_are_refused(tmp_path):
    _project(tmp_path)
    p = all_pipelines()["survey.section"]
    params = {
        "line": LINE,
        "surfaces": [{"kind": "survey", "surface": "nope"}],
        "format": "csv",
        "out": str(tmp_path / "x.csv"),
    }
    with pytest.raises(JobError, match="not prepared"):
        run_job(p, tmp_path, params)
    with pytest.raises(JobError, match="absolute"):
        p.validate({**params, "out": "x.csv"})
    with pytest.raises(JobError, match="no length"):
        p.validate({**params, "line": [[1, 1], [1, 1]]})
    with pytest.raises(JobError, match="survey, current, previous or design"):
        p.validate({**params, "surfaces": [{"kind": "smart"}]})


def test_runs_split_at_no_data():
    from aio_pipelines.survey.section import _runs

    z = np.array([1.0, 2.0, np.nan, 3.0, np.nan, 4.0, 5.0, 6.0])
    assert _runs(z) == [(0, 2), (5, 8)]
    sec = Section(0.5, np.arange(3.0), np.zeros(3), np.zeros(3), [Profile("k", "a/b:c", np.zeros(3))])
    assert layer_name(0, sec.profiles[0].label) == "01 a-b-c"


if __name__ == "__main__":
    FIXTURE.parent.mkdir(parents=True, exist_ok=True)
    FIXTURE.write_text(json.dumps(parity_doc(), indent=1) + "\n", "utf-8", newline="")
    print(f"wrote {FIXTURE}")
