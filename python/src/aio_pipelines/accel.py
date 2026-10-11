"""The GPU add-on: find it, load it, and test that this computer's graphics card runs it.

The add-on is an optional folder beside the pipeline pack, ``pipeline-addon-cuda-<version>/``
(``manifest.json`` ``aio.pipeline-addon/1`` and ``site/`` with CuPy and NVIDIA's CUDA runtime,
built by ``tools/pipeline-pack/accelerator.mjs``). The pack never imports it by itself: the app
names it in ``AIO_PHOTO_ADDON`` and a stage that wants the card calls ``activate``.

``python -m aio_pipelines.accel --selftest [--addon <folder>]`` prints one JSON object and always
exits 0: ``state`` is ``ready`` or says why not (``not-installed``, ``failed``,
``driver-too-old``, ``unsupported-gpu``, ``off``) with a ``reason`` in plain words. The app runs
it in a process of its own with a time limit, so a driver fault cannot take anything else down.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

from . import __version__

ADDON_SCHEMA = "aio.pipeline-addon/1"
ADDON_DIR = re.compile(r"^pipeline-addon-cuda-(.+)$")
#: The add-on's folder, set by the app for the photo jobs and the self-test.
ADDON_ENV = "AIO_PHOTO_ADDON"
#: ``0`` switches the graphics card off for photo processing (Settings, and tests).
GPU_ENV = "AIO_PHOTO_GPU"
#: Where CuPy keeps the kernels it compiles on this computer (the add-on itself is read-only).
CACHE_ENV = "AIO_PHOTO_GPU_CACHE"
#: Cards of this compute capability and later (RTX 50-series) need the 570 driver branch.
BLACKWELL_DRIVER = "570.65"
#: NVIDIA's libraries the add-on loads itself, each after what it needs (nvblas, a drop-in BLAS
#: for other programs, is left alone).
PRELOAD = ("cudart64_*.dll", "nvrtc-builtins64_*.dll", "nvrtc64_*.dll", "cublasLt64_*.dll", "cublas64_*.dll")


class AddonProblem(Exception):
    """The add-on cannot be used; ``state`` is the self-test state and the message says why."""

    def __init__(self, state: str, reason: str):
        super().__init__(reason)
        self.state = state


def _numbers(version: str) -> tuple[int, ...]:
    return tuple(int(x) for x in re.findall(r"\d+", version.split("+")[0])[:4])


def in_range(version: str, wanted: str) -> bool:
    """Whether ``version`` satisfies a range such as ``>=0.5.0 <0.6.0`` (the manifest's form)."""
    v = _numbers(version)
    for part in wanted.split():
        m = re.fullmatch(r"(>=|<=|>|<|==)(.+)", part)
        if not m:
            return False
        op, other = m.group(1), _numbers(m.group(2))
        ok = {">=": v >= other, "<=": v <= other, ">": v > other, "<": v < other, "==": v == other}[op]
        if not ok:
            return False
    return True


def find_addon(runtime: Path) -> Path | None:
    """The newest ``pipeline-addon-cuda-*`` folder with a manifest in ``runtime``, or None."""
    found = []
    if runtime.is_dir():
        for p in runtime.iterdir():
            m = ADDON_DIR.match(p.name)
            if m and (p / "manifest.json").is_file():
                found.append((_numbers(m.group(1)), p))
    return max(found)[1] if found else None


def read_manifest(addon: Path, pack_version: str | None = None) -> dict[str, Any]:
    """The add-on's manifest, checked against this pack; ``AddonProblem`` says what is wrong."""
    pack_version = __version__ if pack_version is None else pack_version
    path = addon / "manifest.json"
    if not path.is_file():
        raise AddonProblem("not-installed", "The GPU add-on is not installed.")
    try:
        doc = json.loads(path.read_text("utf-8"))
    except (OSError, ValueError) as e:
        raise AddonProblem("failed", f"The GPU add-on's manifest cannot be read ({e}).") from e
    if not isinstance(doc, dict) or doc.get("schema") != ADDON_SCHEMA or doc.get("kind") != "gpu-cuda":
        raise AddonProblem("failed", "The GPU add-on's manifest is not one this version reads.")
    here = f"{sys.version_info[0]}.{sys.version_info[1]}"
    if doc.get("python") != here:
        raise AddonProblem(
            "failed", f"The GPU add-on is for Python {doc.get('python')}; the processing tools use {here}."
        )
    wanted = str(doc.get("packRange", ""))
    # a development tree has no version of its own ("0.0.0+src"): it is not held to the range
    if not pack_version.startswith("0.0.0") and not in_range(pack_version, wanted):
        raise AddonProblem(
            "failed",
            f"GPU add-on {doc.get('version')} fits processing tools {wanted}; this is {pack_version}. "
            "Install the add-on made for this version.",
        )
    return doc


def activate(addon: Path) -> dict[str, Any]:
    """Make the add-on importable in this process and answer its manifest.

    The add-on comes after everything already on the path, so the pack's own libraries win. The
    job runs isolated (``-I``), so nothing but this puts the add-on on the path.
    """
    doc = read_manifest(addon)
    site = addon / "site"
    if not site.is_dir():
        raise AddonProblem("failed", "The GPU add-on is incomplete: its site folder is missing.")
    if str(site) not in sys.path:
        sys.path.append(str(site))
    # NVIDIA's libraries: CuPy's finder looks in Python's own site-packages, which the add-on is
    # not, but takes a library this process has already loaded. So they are loaded here, by path.
    if hasattr(os, "add_dll_directory"):
        import ctypes

        bins = sorted(site.glob("nvidia/*/bin"))
        for bin_dir in bins:
            os.add_dll_directory(str(bin_dir))
        try:
            for pattern in PRELOAD:  # in the order they need each other
                for bin_dir in bins:
                    for dll in sorted(bin_dir.glob(pattern)):
                        if ".alt." not in dll.name:
                            ctypes.WinDLL(str(dll))
        except OSError as e:
            # an import failure to the caller: on a computer without the card it is the card
            # that is missing, not the add-on that is damaged
            raise ImportError(str(e)) from e
    # CuPy compiles its kernels against the CUDA headers. It looks for them in Python's own
    # site-packages, which the add-on is not, and then under CUDA_PATH: point that at the add-on's
    # runtime, in this process only (a CUDA Toolkit installed on the computer is another version).
    runtime = site / "nvidia" / "cuda_runtime"
    if (runtime / "include").is_dir():
        os.environ["CUDA_PATH"] = os.environ["CUDA_HOME"] = str(runtime)
    cache = os.environ.get(CACHE_ENV)
    if cache:
        Path(cache).mkdir(parents=True, exist_ok=True)
        os.environ["CUPY_CACHE_DIR"] = cache
    return doc


def driver() -> dict[str, str] | None:
    """Name and driver of the first NVIDIA card as ``nvidia-smi`` reports them, or None."""
    exe = shutil.which("nvidia-smi")
    if exe is None:
        return None
    try:
        p = subprocess.run(
            [exe, "--query-gpu=name,driver_version", "--format=csv,noheader"],
            capture_output=True,
            text=True,
            timeout=15,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    line = (p.stdout or "").strip().splitlines()[0] if p.returncode == 0 and p.stdout.strip() else ""
    if "," not in line:
        return None
    name, version = (x.strip() for x in line.rsplit(",", 1))
    return {"name": name, "driver": version}


def probe() -> dict[str, Any]:
    """Run one kernel and one matrix product on the card and compare with numpy.

    Called after ``activate``. Answers the card's name, compute capability and memory; raises
    whatever CuPy raises when the card, the driver or a library is not there.
    """
    import cupy as cp  # type: ignore[import-not-found]
    import numpy as np

    dev = cp.cuda.Device(0)
    major, minor = int(dev.compute_capability[:-1]), int(dev.compute_capability[-1])
    free, total = (int(x) for x in dev.mem_info)
    a = cp.arange(1 << 20, dtype=cp.int64)
    kernel = int(((a * a) % 7).sum())
    b = np.arange(1 << 20, dtype=np.int64)
    if kernel != int(((b * b) % 7).sum()):
        raise RuntimeError("a kernel gave a different answer on the card than on the CPU")
    m = np.arange(64 * 32, dtype=np.float32).reshape(64, 32) % 5
    if not np.array_equal(cp.asnumpy(cp.asarray(m) @ cp.asarray(m).T), m @ m.T):
        raise RuntimeError("a matrix product gave a different answer on the card than on the CPU")
    props = cp.cuda.runtime.getDeviceProperties(0)
    name = props.get("name", b"")
    return {
        "gpu": name.decode("utf-8", "replace").strip("\x00 ") if isinstance(name, bytes) else str(name),
        "capability": f"{major}.{minor}",
        "vramBytes": total,
        "freeBytes": free,
        "cupy": str(cp.__version__),
    }


def selftest(addon: Path | None = None) -> dict[str, Any]:
    """The add-on's state on this computer, as a JSON-ready dictionary (never raises)."""
    t0 = time.monotonic()
    out: dict[str, Any] = {"state": "not-installed"}

    def done(state: str, reason: str | None = None) -> dict[str, Any]:
        out["state"] = state
        if reason:
            out["reason"] = reason
        out["seconds"] = round(time.monotonic() - t0, 2)
        return out

    if os.environ.get(GPU_ENV) == "0":
        return done("off", "The graphics card is switched off for photo processing.")
    if addon is None:
        env = os.environ.get(ADDON_ENV)
        addon = Path(env) if env else None
    if addon is None:
        return done("not-installed", "The GPU add-on is not installed.")
    try:
        doc = read_manifest(addon)
    except AddonProblem as e:
        return done(e.state, str(e))
    out["version"] = doc.get("version")
    out["cuda"] = (doc.get("runtime") or {}).get("cuda")
    need = str((doc.get("runtime") or {}).get("minDriver", ""))
    card = driver()
    if card is not None:
        out["gpu"], out["driver"] = card["name"], card["driver"]
        if need and _numbers(card["driver"]) < _numbers(need):
            return done(
                "driver-too-old",
                f"The GPU add-on needs graphics driver {need} or later (found {card['driver']}).",
            )
    try:
        activate(addon)
        out.update(probe())
    except AddonProblem as e:
        return done(e.state, str(e))
    except ImportError as e:
        if card is None:
            return done("unsupported-gpu", f"No NVIDIA graphics card was found ({str(e)[:200]}).")
        return done("failed", f"The GPU add-on could not be loaded ({e}).")
    except Exception as e:
        text = f"{type(e).__name__}: {e}".strip()
        if card is None:
            return done("unsupported-gpu", f"No NVIDIA graphics card was found ({text[:200]}).")
        if _numbers(card["driver"]) < _numbers(BLACKWELL_DRIVER):
            return done(
                "driver-too-old",
                f"This graphics card may need driver {BLACKWELL_DRIVER} or later "
                f"(found {card['driver']}): {text[:200]}",
            )
        return done("failed", f"The graphics card did not pass the test ({text[:300]}).")
    return done("ready")


def check(addon: Path | None = None, timeout: float = 120.0) -> dict[str, Any]:
    """``selftest`` in a process of its own, as a job asks before it uses the card: a driver
    fault or a hang there cannot take the job down. Never raises."""
    cmd = [sys.executable, *subprocess._args_from_interpreter_flags(), "-m", "aio_pipelines.accel"]
    cmd.append("--selftest")
    if addon is not None:
        cmd += ["--addon", str(addon)]
    try:
        p = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=timeout,
            stdin=subprocess.DEVNULL,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        out = json.loads(p.stdout.strip().splitlines()[-1])
        if isinstance(out, dict) and isinstance(out.get("state"), str):
            return out
        raise ValueError("no state in the answer")
    except subprocess.TimeoutExpired:
        return {
            "state": "failed",
            "reason": f"The graphics card did not answer its test within {timeout:.0f} s.",
        }
    except (OSError, ValueError, IndexError) as e:
        return {"state": "failed", "reason": f"The graphics card's test could not run ({e})."}


def main(argv: list[str] | None = None) -> int:
    args = sys.argv[1:] if argv is None else argv
    if "--selftest" not in args:
        print("usage: python -m aio_pipelines.accel --selftest [--addon <folder>]", file=sys.stderr)
        return 2
    addon = Path(args[args.index("--addon") + 1]) if "--addon" in args[:-1] else None
    print(json.dumps(selftest(addon)), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
