"""Benchmark of ``walk.process`` on one 360 camera file (Walks 360; plan 2026-10-12-walk-process-pipeline).

    python python/scripts/walk_bench.py <clip.insv> [--out <folder>] [--keep]
    pnpm bench:walk <clip.insv>

Builds a throwaway project with the clip as an imported walk (``walks/<id>/walk.json``, the
original read in place, never copied or changed), runs the job as the app would and prints the
seconds per step, the real-time factor (processing time over clip length) and the peak memory.
``bench.json`` with the same numbers is written beside the project. The target is a 15 minute
walk in 30 minutes or less on a laptop CPU (real-time factor 2 or less).

Heavy: minutes of full CPU. Run it only in a window the founder gives, never in CI, never from an
agent on its own. The pytest wrapper (``tests/test_walk_reference.py``) runs only when
``QUADRION_WALK_BENCH`` names a file.
"""

from __future__ import annotations

import argparse
import json
import os
import platform
import re
import shutil
import sys
import tempfile
import threading
import time
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "src"))

from aio_pipelines.pipelines import all_pipelines  # noqa: E402
from aio_pipelines.runtime import Job  # noqa: E402
from aio_pipelines.walk import ffmpeg as ff  # noqa: E402


def walk_id(name: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", Path(name).stem.lower()).strip("-")
    return (slug or "walk")[:80]


def make_project(root: Path, clip: Path) -> str:
    """A project folder holding the clip as an imported walk, as the app's import leaves it."""
    info = ff.probe(str(clip))
    wid = walk_id(clip.name)
    folder = root / "walks" / wid
    folder.mkdir(parents=True)
    streams = info.get("streams") or []
    video = [s for s in streams if s.get("type", "video") == "video"] or [{}]
    layout = "insv-dual-stream" if len(video) >= 2 else "dual-fisheye"
    walk = {
        "schema": "aio.walk/1",
        "id": wid,
        "name": clip.stem,
        "createdAt": "2026-10-12T00:00:00.000Z",
        "source": {
            "file": clip.name,
            "bytes": clip.stat().st_size,
            "layout": layout,
            "trailer": True,
            "streams": [
                {
                    "width": int(s.get("width") or info.get("width") or 1),
                    "height": int(s.get("height") or info.get("height") or 1),
                    "codec": str(s.get("codec") or "hvc1")[:16],
                    "fps": float(s.get("fps") or info.get("fps") or 0),
                }
                for s in video[:2]
            ],
        },
        "video": {
            "src": f"walks/{wid}/playback.mp4",
            "width": 3840,
            "height": 1920,
            "durationS": float(info.get("duration") or 0),
            "fps": 29.97,
            "audio": bool(info.get("audio")),
        },
    }
    (folder / "walk.json").write_text(json.dumps(walk, indent=1), encoding="utf-8")
    # the job reads the original (src); the import's playback copy is not needed for the benchmark
    (folder / "playback.mp4").write_bytes(b"")
    (root / "manifest.json").write_text(
        json.dumps({"schema": "aio.project/1", "layers": []}), encoding="utf-8"
    )
    return wid


def peak_memory_mb() -> float | None:
    try:
        from aio_pipelines.photo.native import peak_memory

        return round(peak_memory() / 2**20, 1)
    except Exception:
        return None


def run(clip: Path, out: Path | None = None, keep: bool = False) -> dict[str, Any]:
    if ff.find_ffmpeg() is None:
        raise SystemExit(ff.FFMPEG_MISSING)
    base = Path(tempfile.mkdtemp(prefix="walk-bench-", dir=out))
    project = base / "project"
    project.mkdir()
    wid = make_project(project, clip)
    duration = float(ff.probe(str(clip)).get("duration") or 0)
    steps: dict[str, float] = {}
    started: dict[str, float] = {}

    def emit(method: str, params: dict[str, Any]) -> None:
        if method != "progress":
            return
        step, state = params.get("step"), params.get("state")
        if not isinstance(step, str):
            return
        if state in ("start", "running") and step not in started:
            started[step] = time.perf_counter()
            print(f"  {step} ...", flush=True)
        elif state in ("done", "failed") and step in started and step not in steps:
            steps[step] = round(time.perf_counter() - started[step], 1)
            print(f"  {step}: {steps[step]} s", flush=True)

    pipeline = all_pipelines()["walk.process"]
    t0 = time.perf_counter()
    job = Job("walk-bench", pipeline, project, {"walk": wid, "src": [str(clip)]}, emit, threading.Event())
    result = job.run()
    total = time.perf_counter() - t0
    record_path = project / "walks" / wid / "process.json"
    record = json.loads(record_path.read_text(encoding="utf-8")) if record_path.is_file() else {}
    report = {
        "clipSeconds": round(duration, 1),
        "totalSeconds": round(total, 1),
        "realTimeFactor": round(total / duration, 2) if duration else None,
        "target": "15 min walk in 30 min (real-time factor 2 or less)",
        "steps": steps,
        "timings": record.get("timings"),
        "path": record.get("path"),
        "stills": record.get("stills"),
        "warnings": record.get("warnings"),
        "status": result.get("status") if isinstance(result, dict) else None,
        "peakMemoryMB": peak_memory_mb(),
        "cpu": platform.processor() or platform.machine(),
        "threads": os.cpu_count(),
        "ffmpeg": ff.version(ff.find_ffmpeg() or "ffmpeg"),
    }
    (base / "bench.json").write_text(json.dumps(report, indent=1), encoding="utf-8")
    if not keep:
        shutil.rmtree(project, ignore_errors=True)
    print(json.dumps(report, indent=1))
    print(f"bench.json: {base / 'bench.json'}")
    return report


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("clip", type=Path)
    ap.add_argument("--out", type=Path, default=None, help="folder for the throwaway project")
    ap.add_argument("--keep", action="store_true", help="keep the project with its outputs")
    a = ap.parse_args(argv)
    if not a.clip.is_file():
        print(f"{a.clip} is not a file.", file=sys.stderr)
        return 2
    run(a.clip.resolve(), a.out, a.keep)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
