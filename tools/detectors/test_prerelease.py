"""Tests for the pre-release detector check, with the bench stubbed (no model, no data)."""

import json
import sys
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import prerelease  # noqa: E402

PACK_MODEL = "qwen3.5-9b-q4_k_m"


@pytest.fixture
def env(tmp_path: Path, monkeypatch) -> dict:
    monkeypatch.delenv(prerelease.DATA_ENV, raising=False)
    monkeypatch.delenv(prerelease.SERVER_ENV, raising=False)
    dets = tmp_path / "detectors"
    for name, tuned in (("old-one", "qwen2.5-vl-7b-instruct-q4_k_m"), ("fresh-one", PACK_MODEL)):
        (dets / "plant" / name).mkdir(parents=True)
        doc = {"id": name, "version": 1, "classId": "rust", "threshold": 0.7, "tunedOn": {"model": tuned}}
        (dets / "plant" / name / "detector.json").write_text(json.dumps(doc))
    lock = tmp_path / "lock.json"
    lock.write_text(json.dumps({"model": {"id": PACK_MODEL}}))
    refs = tmp_path / "refs"
    refs.mkdir()
    ref = {"model": PACK_MODEL, "truthClasses": ["rust", "corrosion"], "threshold": 0.8, "iouMin": 0.4,
           "metrics": {"precision": 0.5, "recall": 0.5, "f1": 0.5}}  # fmt: skip
    (refs / "fresh-one.json").write_text(json.dumps(ref))
    calls: list[list[str]] = []
    codes: dict[str, int] = {}

    def fake_bench(argv: list[str]) -> int:
        calls.append(argv)
        det = json.loads(Path(argv[argv.index("--detector") + 1]).read_text())
        return codes.get(det["id"], 0)

    monkeypatch.setattr(prerelease, "_bench_main", fake_bench)
    base = [
        "--detectors",
        str(dets),
        "--lock",
        str(lock),
        "--references",
        str(refs),
        "--out",
        str(tmp_path / "out"),
    ]
    return {"base": base, "calls": calls, "codes": codes, "tmp": tmp_path, "refs": refs}


def _dataset(tmp: Path) -> Path:
    data = tmp / "data"
    for p in ("a", "b"):
        (data / p).mkdir(parents=True)
        (data / p / "manifest.json").write_text("{}")
    (data / "not-a-project").mkdir()
    return data


def _values(argv: list[str], flag: str) -> list[str]:
    return [argv[i + 1] for i, a in enumerate(argv) if a == flag]


def test_no_dataset_skips_and_still_flags_a_stale_tuned_on(env, capsys):
    assert prerelease.main(env["base"]) == 0
    out = capsys.readouterr().out
    assert "old-one: skipped: no dataset" in out and "fresh-one: skipped: no dataset" in out
    assert "stale tunedOn" in out and "qwen2.5-vl-7b-instruct-q4_k_m" in out
    assert "old-one: no stored reference" in out
    assert env["calls"] == []


def test_missing_dataset_or_server_is_a_usage_error(env, capsys):
    assert prerelease.main([*env["base"], "--dataset", str(env["tmp"] / "nope"), "--server", "http://x"]) == 2
    data = _dataset(env["tmp"])
    assert prerelease.main([*env["base"], "--dataset", str(data)]) == 2
    assert "no model server" in capsys.readouterr().err
    assert env["calls"] == []


def test_runs_the_bench_per_detector_with_its_reference(env, monkeypatch):
    data = _dataset(env["tmp"])
    monkeypatch.setenv(prerelease.DATA_ENV, str(data))
    monkeypatch.setenv(prerelease.SERVER_ENV, "http://127.0.0.1:1")
    assert prerelease.main(env["base"]) == 0
    assert len(env["calls"]) == 2
    by = {Path(c[c.index("--detector") + 1]).parent.name: c for c in env["calls"]}
    fresh, old = by["fresh-one"], by["old-one"]
    assert _values(fresh, "--project") == [str(data / "a"), str(data / "b")]
    assert _values(fresh, "--truth-class") == ["rust", "corrosion"]
    assert _values(fresh, "--threshold") == ["0.8"] and _values(fresh, "--iou") == ["0.4"]
    assert _values(fresh, "--split") == ["bench"]
    assert _values(fresh, "--compare") == [str(env["refs"] / "fresh-one.json")]
    # no reference: the detector's own class and threshold, nothing to compare
    assert "--compare" not in old and _values(old, "--threshold") == ["0.7"]
    assert _values(old, "--truth-class") == ["rust"]
    assert "--write-reference" not in old


def test_a_regression_fails_the_check(env):
    data = _dataset(env["tmp"])
    env["codes"]["fresh-one"] = 1
    assert prerelease.main([*env["base"], "--dataset", str(data), "--server", "http://x"]) == 1


def test_update_references_writes_each(env):
    data = _dataset(env["tmp"])
    prerelease.main([*env["base"], "--dataset", str(data), "--server", "http://x", "--update-references"])
    assert len(env["calls"]) == 2
    for c in env["calls"]:
        name = Path(c[c.index("--detector") + 1]).parent.name
        assert _values(c, "--write-reference") == [str(env["refs"] / f"{name}.json")]


def test_the_repository_defaults_skip_without_data(monkeypatch, capsys):
    monkeypatch.delenv(prerelease.DATA_ENV, raising=False)
    assert prerelease.main([]) == 0
    out = capsys.readouterr().out
    assert "corrosion-metal: skipped: no dataset" in out
    # the shipped corrosion detector still names Qwen2.5-VL: flagged, never failed
    assert "corrosion-metal: tunedOn names qwen2.5-vl-7b-instruct-q4_k_m" in out
    assert "has no metrics yet" in out


def test_shipped_references_are_well_formed():
    for f in (HERE / "references").glob("*.json"):
        ref = json.loads(f.read_text("utf-8"))
        assert ref["schema"] == "aio.detector-bench-ref/1"
        assert ref["detector"] == f.stem
        assert {"detectorVersion", "model", "date", "datasetHash", "metrics", "truthClasses"} <= set(ref)
    names = {d["id"] for _, d in prerelease.shipped(prerelease.DETECTORS)}
    assert names <= {f.stem for f in (HERE / "references").glob("*.json")}
