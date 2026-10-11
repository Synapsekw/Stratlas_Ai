"""The GPU add-on's loader and self-test (aio_pipelines.accel). No graphics card is needed: the
part that touches the card is replaced; one test runs the real thing when ``AIO_TEST_ADDON``
names a built add-on on a computer with an NVIDIA card."""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import pytest

from aio_pipelines import accel

HERE = f"{sys.version_info[0]}.{sys.version_info[1]}"
CARD = {"gpu": "Test Card", "capability": "8.9", "vramBytes": 8 << 30, "freeBytes": 6 << 30, "cupy": "14.2.0"}


def _addon(root: Path, version: str = "0.1.0", **over) -> Path:
    d = root / f"pipeline-addon-cuda-{version}"
    (d / "site").mkdir(parents=True, exist_ok=True)
    doc = {
        "schema": "aio.pipeline-addon/1",
        "kind": "gpu-cuda",
        "version": version,
        "packRange": ">=0.5.0 <0.6.0",
        "python": HERE,
        "platform": "win32-x64",
        "runtime": {"cuda": "12.9", "minDriver": "528.33"},
        "createdAt": "2026-10-11T00:00:00.000Z",
        "files": {},
        **over,
    }
    (d / "manifest.json").write_text(json.dumps(doc), "utf-8")
    return d


@pytest.fixture(autouse=True)
def _clean(monkeypatch):
    for name in (accel.ADDON_ENV, accel.GPU_ENV, accel.CACHE_ENV):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setattr(accel, "driver", lambda: {"name": "Test Card", "driver": "591.86"})
    monkeypatch.setattr(accel, "probe", lambda: dict(CARD))
    path = list(sys.path)
    yield
    sys.path[:] = path


@pytest.mark.parametrize(
    "version, wanted, ok",
    [
        ("0.5.3", ">=0.5.0 <0.6.0", True),
        ("0.6.0", ">=0.5.0 <0.6.0", False),
        ("0.4.9", ">=0.5.0 <0.6.0", False),
        ("0.5.10", ">=0.5.9", True),
        ("0.5.3", "about 0.5", False),
    ],
)
def test_pack_ranges(version, wanted, ok):
    assert accel.in_range(version, wanted) is ok


def test_the_newest_add_on_with_a_manifest_is_found(tmp_path):
    assert accel.find_addon(tmp_path) is None
    _addon(tmp_path, "0.1.0")
    newest = _addon(tmp_path, "0.10.0")
    _addon(tmp_path, "0.9.0")
    (tmp_path / "pipeline-addon-cuda-9.0.0").mkdir()  # no manifest: not an add-on
    (tmp_path / "pipeline-pack-0.5.3").mkdir()
    assert accel.find_addon(tmp_path) == newest


def test_a_ready_card_reports_what_it_is(tmp_path):
    out = accel.selftest(_addon(tmp_path))
    assert out["state"] == "ready" and "reason" not in out
    assert out["version"] == "0.1.0" and out["cuda"] == "12.9"
    assert out["gpu"] == "Test Card" and out["driver"] == "591.86" and out["vramBytes"] == 8 << 30
    assert out["seconds"] >= 0


def test_the_add_on_comes_after_the_packs_own_libraries_on_the_path(tmp_path, monkeypatch):
    addon = _addon(tmp_path)
    monkeypatch.setenv(accel.CACHE_ENV, str(tmp_path / "kernels"))
    before = list(sys.path)
    accel.activate(addon)
    accel.activate(addon)  # twice is once
    assert sys.path == [*before, str(addon / "site")]
    assert (tmp_path / "kernels").is_dir() and os.environ["CUPY_CACHE_DIR"] == str(tmp_path / "kernels")


def test_no_add_on_is_not_installed(tmp_path, monkeypatch):
    assert accel.selftest()["state"] == "not-installed"
    assert accel.selftest(tmp_path / "pipeline-addon-cuda-0.1.0") == {
        "state": "not-installed",
        "reason": "The GPU add-on is not installed.",
        "seconds": pytest.approx(0, abs=5),
    }
    monkeypatch.setenv(accel.ADDON_ENV, str(_addon(tmp_path)))
    assert accel.selftest()["state"] == "ready"  # the app names it in the environment


def test_switched_off_wins(tmp_path, monkeypatch):
    monkeypatch.setenv(accel.GPU_ENV, "0")
    out = accel.selftest(_addon(tmp_path))
    assert (
        out["state"] == "off" and out["reason"] == "The graphics card is switched off for photo processing."
    )


def test_an_add_on_for_another_pack_or_python_is_refused_in_words(tmp_path, monkeypatch):
    monkeypatch.setattr(accel, "__version__", "0.6.1")
    out = accel.selftest(_addon(tmp_path))
    assert out["state"] == "failed"
    assert out["reason"] == (
        "GPU add-on 0.1.0 fits processing tools >=0.5.0 <0.6.0; this is 0.6.1. "
        "Install the add-on made for this version."
    )
    with pytest.raises(accel.AddonProblem, match=r"is for Python 3\.99; the processing tools use"):
        accel.read_manifest(_addon(tmp_path, "0.2.0", python="3.99"), "0.5.3")
    # a source tree has no version of its own and is not held to the range
    assert accel.read_manifest(_addon(tmp_path, "0.3.0"), "0.0.0+src")["version"] == "0.3.0"


def test_a_damaged_or_foreign_manifest_is_refused(tmp_path):
    bad = _addon(tmp_path, "0.1.0")
    (bad / "manifest.json").write_text("{not json", "utf-8")
    assert accel.selftest(bad)["state"] == "failed"
    other = _addon(tmp_path, "0.2.0", schema="aio.pipeline-pack/1")
    assert accel.selftest(other)["reason"] == "The GPU add-on's manifest is not one this version reads."
    empty = _addon(tmp_path, "0.3.0")
    (empty / "site").rmdir()
    assert accel.selftest(empty)["reason"] == "The GPU add-on is incomplete: its site folder is missing."


def test_an_old_driver_is_named_with_the_one_needed(tmp_path, monkeypatch):
    monkeypatch.setattr(accel, "driver", lambda: {"name": "Old Card", "driver": "512.15"})
    out = accel.selftest(_addon(tmp_path))
    assert out["state"] == "driver-too-old"
    assert out["reason"] == "The GPU add-on needs graphics driver 528.33 or later (found 512.15)."


def test_no_nvidia_card_is_unsupported_not_failed(tmp_path, monkeypatch):
    def no_card():
        raise RuntimeError("cudaErrorNoDevice: no CUDA-capable device is detected")

    monkeypatch.setattr(accel, "driver", lambda: None)
    monkeypatch.setattr(accel, "probe", no_card)
    out = accel.selftest(_addon(tmp_path))
    assert out["state"] == "unsupported-gpu"
    assert out["reason"].startswith("No NVIDIA graphics card was found (RuntimeError: cudaErrorNoDevice")

    # without the card's driver its libraries may not even load: still "no card", not "damaged"
    def no_driver():
        raise ImportError("DLL load failed while importing runtime")

    monkeypatch.setattr(accel, "probe", no_driver)
    out = accel.selftest(_addon(tmp_path, "0.2.0"))
    assert out["state"] == "unsupported-gpu" and "DLL load failed" in out["reason"]


def test_a_card_that_fails_the_test_says_what_happened(tmp_path, monkeypatch):
    def boom():
        raise RuntimeError("a kernel gave a different answer on the card than on the CPU")

    monkeypatch.setattr(accel, "probe", boom)
    out = accel.selftest(_addon(tmp_path))
    assert out["state"] == "failed" and "a kernel gave a different answer" in out["reason"]

    def missing():
        raise ImportError("DLL load failed while importing core")

    monkeypatch.setattr(accel, "probe", missing)
    out = accel.selftest(_addon(tmp_path))
    assert out["reason"] == "The GPU add-on could not be loaded (DLL load failed while importing core)."

    # a new card on a driver older than its generation needs
    monkeypatch.setattr(accel, "driver", lambda: {"name": "New Card", "driver": "560.94"})
    monkeypatch.setattr(accel, "probe", boom)
    out = accel.selftest(_addon(tmp_path))
    assert out["state"] == "driver-too-old" and "570.65 or later (found 560.94)" in out["reason"]


def test_the_command_prints_one_json_object_and_exits_zero(tmp_path, capsys):
    assert accel.main(["--selftest", "--addon", str(_addon(tmp_path))]) == 0
    assert json.loads(capsys.readouterr().out)["state"] == "ready"
    assert accel.main(["--selftest"]) == 0
    assert json.loads(capsys.readouterr().out)["state"] == "not-installed"
    assert accel.main([]) == 2


REAL = os.environ.get("AIO_TEST_ADDON")


@pytest.mark.skipif(
    not REAL, reason="set AIO_TEST_ADDON to a built GPU add-on on a computer with an NVIDIA card"
)
def test_the_real_add_on_runs_on_this_card(monkeypatch, tmp_path):
    import subprocess

    env = {**os.environ, accel.CACHE_ENV: str(tmp_path / "kernels")}
    p = subprocess.run(
        [sys.executable, "-m", "aio_pipelines.accel", "--selftest", "--addon", str(REAL)],
        capture_output=True,
        text=True,
        timeout=300,
        env=env,
    )
    out = json.loads(p.stdout.strip().splitlines()[-1])
    assert out["state"] == "ready", out
    assert out["vramBytes"] > 0 and out["cupy"]
