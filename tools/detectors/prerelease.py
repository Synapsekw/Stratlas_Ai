"""Pre-release detector check: bench every shipped detector against its stored reference.

    uv run --project python python tools/detectors/prerelease.py [--dataset <dir>] [--server <url>] \
        [--model <id>] [--tolerance 0.05] [--limit 50] [--update-references] [--out <dir>]

Always checks each shipped detector's ``tunedOn`` against the model the Analytics pack ships and warns
when it is stale. Without a reference dataset (``--dataset`` or ``QUADRION_DETECTOR_BENCH_DATA``) it
prints ``skipped: no dataset`` per detector and exits 0, so the release flow can call it on any
machine. With a dataset it needs a running llama-server (``--server`` or
``QUADRION_DETECTOR_BENCH_SERVER``) and runs ``bench.py`` on the bench split for each detector,
comparing with ``references/<detector id>.json``.

The dataset is a folder of reference projects (each with a ``manifest.json``), or one project.
Exit codes: 0 fine (warnings allowed), 1 a regression beyond the tolerance, 2 a usage problem.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
sys.path.insert(0, str(HERE))

import metrics  # noqa: E402

DETECTORS = ROOT / "tools" / "analytics-pack" / "detectors"
LOCK = ROOT / "tools" / "analytics-pack" / "lock.json"
REFERENCES = HERE / "references"
DATA_ENV = "QUADRION_DETECTOR_BENCH_DATA"
SERVER_ENV = "QUADRION_DETECTOR_BENCH_SERVER"


def shipped(detectors_dir: Path) -> list[tuple[Path, dict[str, Any]]]:
    """Every shipped detector file and its document."""
    return [(f, json.loads(f.read_text("utf-8"))) for f in sorted(detectors_dir.rglob("detector.json"))]


def projects_in(dataset: Path) -> list[Path]:
    if (dataset / "manifest.json").is_file():
        return [dataset]
    return sorted(p for p in dataset.iterdir() if (p / "manifest.json").is_file())


def _bench_main(argv: list[str]) -> int:
    import bench  # imports the detect engine; only needed when there is data to run

    return bench.main(argv)


def _read_ref(path: Path) -> dict[str, Any] | None:
    return json.loads(path.read_text("utf-8")) if path.is_file() else None


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Bench every shipped detector before a release.")
    ap.add_argument(
        "--dataset", default=os.environ.get(DATA_ENV), help=f"reference projects (or ${DATA_ENV})"
    )
    ap.add_argument(
        "--server", default=os.environ.get(SERVER_ENV), help=f"llama-server URL (or ${SERVER_ENV})"
    )
    ap.add_argument("--model", help="model id the server has loaded (default: ask the server)")
    ap.add_argument("--api-key", default=os.environ.get("LLAMA_API_KEY"))
    ap.add_argument("--tolerance", type=float, default=0.05)
    ap.add_argument("--limit", type=int, default=50, help="most photos per project")
    ap.add_argument("--update-references", action="store_true", help="write each run as the new reference")
    ap.add_argument(
        "--force-references",
        action="store_true",
        help="with --update-references: write even when the comparison failed or the settings changed",
    )
    # Outputs hold contact sheets of reference photos: never inside the repository.
    ap.add_argument("--out", default=str(Path(tempfile.gettempdir()) / "quadrion-detector-bench"))
    ap.add_argument("--detectors", default=str(DETECTORS), help=argparse.SUPPRESS)
    ap.add_argument("--lock", default=str(LOCK), help=argparse.SUPPRESS)
    ap.add_argument("--references", default=str(REFERENCES), help=argparse.SUPPRESS)
    args = ap.parse_args(argv)

    pack_model = str(json.loads(Path(args.lock).read_text("utf-8"))["model"]["id"])
    dets = shipped(Path(args.detectors))
    refs_dir = Path(args.references)
    print(f"Shipped detectors: {len(dets)}; the Analytics pack ships {pack_model}.")

    for _, det in dets:
        name = det.get("id")
        try:
            ref = _read_ref(refs_dir / f"{name}.json")
        except (OSError, ValueError) as e:
            print(f"warning: {name}: the stored reference cannot be read: {e}")
            continue
        for w in metrics.stale_tuned_on(det, pack_model, ref):
            print(f"warning: {w}")
        if ref is None:
            print(f"warning: {name}: no stored reference ({name}.json); add one with --update-references")
        elif not isinstance(ref.get("metrics"), dict):
            print(f"warning: {name}: the stored reference has no metrics yet, so nothing can regress")

    if not args.dataset:
        for _, det in dets:
            print(f"{det.get('id')}: skipped: no dataset (pass --dataset or set {DATA_ENV})")
        return 0
    dataset = Path(args.dataset)
    if not dataset.is_dir():
        print(f"error: the dataset {dataset} does not exist", file=sys.stderr)
        return 2
    projects = projects_in(dataset)
    if not projects:
        print(f"error: no reference project (a folder with manifest.json) in {dataset}", file=sys.stderr)
        return 2
    if not args.server:
        print(
            f"error: a dataset was given but no model server (pass --server or set {SERVER_ENV})",
            file=sys.stderr,
        )
        return 2

    worst = 0
    for det_file, det in dets:
        name = str(det.get("id"))
        ref_file = refs_dir / f"{name}.json"
        try:
            ref = _read_ref(ref_file) or {}
            code = _bench_main(_bench_args(args, projects, det_file, det, ref, ref_file))
        except Exception as e:  # a broken reference or a bench crash fails the check; it is no regression
            print(f"error: {name}: {type(e).__name__}: {e}", file=sys.stderr)
            code = 2
        print(f"{name}: {'REGRESSION' if code == 1 else 'failed' if code else 'ok'}")
        worst = max(worst, code)
    return worst


def _first(*values: Any) -> Any:
    """The first value that is set (not None), so 0 and [] count as set."""
    return next((v for v in values if v is not None), None)


def _bench_args(
    args: argparse.Namespace,
    projects: list[Path],
    det_file: Path,
    det: dict[str, Any],
    ref: dict[str, Any],
    ref_file: Path,
) -> list[str]:
    # truth classes [] in a reference means every class, as no --truth-class does in the bench
    own = [det["classId"]] if det.get("classId") is not None else []
    classes = _first(ref.get("truthClasses"), own)
    cmd = [arg for p in projects for arg in ("--project", str(p))]
    cmd += ["--detector", str(det_file), "--server", args.server, "--split", "bench"]
    cmd += [arg for c in classes for arg in ("--truth-class", str(c))]
    cmd += ["--threshold", str(_first(ref.get("threshold"), det.get("threshold"), 0.8))]
    cmd += ["--iou", str(_first(ref.get("iouMin"), metrics.IOU_MIN)), "--limit", str(args.limit)]
    cmd += ["--tolerance", str(args.tolerance), "--out", str(Path(args.out) / str(det.get("id")))]
    if args.model:
        cmd += ["--model", args.model]
    if args.api_key:
        cmd += ["--api-key", args.api_key]
    if ref_file.is_file():
        cmd += ["--compare", str(ref_file)]
    if args.update_references:
        cmd += ["--write-reference", str(ref_file)]
    if args.force_references:
        cmd += ["--force-reference"]
    print(f"{det.get('id')}: bench on {len(projects)} project(s)")
    return cmd


if __name__ == "__main__":
    raise SystemExit(main())
