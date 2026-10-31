"""Multi-view vote bench: the E2 metrics before and after the vote, on a synthetic multi-view fixture.

    uv run --project python python tools/detectors/vote_bench.py [--seed 7] [--threshold 0.8] [--out <dir>]

No model and no project: the fixture is a 40 x 30 m flat site with flat objects (rust patches, 0.6 m)
and a 4 x 3 grid of oblique photos 30 m up, every pose known. A simulated detector finds each object
a photo sees with probability ``--recall`` (box jittered, score 0.55 to 0.98) and adds false boxes
(Poisson, ``--false-per-photo`` per photo, score 0.5 to 0.95, the hard case where a false box scores
as high as a true one).

"Before" is the pass as ``detect.vlm`` wrote it up to pack 0.28.0, one draft per box. "After" is the
same pass through ``multiview.vote`` twice: on the surface (the site as a mesh) and with no surface
(box-centre rays triangulated). Both are scored with ``metrics.evaluate`` per photo (IoU 0.3, one to
one): after the vote each draft is spread back over its photos (it and its ``sightings``) with the
voted confidence, so the same truth is matched. The report adds what a reviewer sees: the drafts to
review at the threshold, and the objects they cover.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "python" / "src"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import metrics

from aio_pipelines.multiview.scene import MeshSurface
from aio_pipelines.multiview.vote import Camera, vote

W, H = 1000, 750
HFOV = 70.0
CLASS = "rust"
OBJECT_HALF = 0.3  # metres


def fixture(seed: int, objects: int = 15) -> tuple[dict[str, Camera], list[np.ndarray]]:
    rng = np.random.default_rng(seed)
    cams: dict[str, Camera] = {}
    for i, x in enumerate(np.linspace(-15, 15, 4)):
        for j, z in enumerate(np.linspace(-10, 10, 3)):
            pos = (x + rng.normal(0, 0.5), 30.0, z + 12.0)
            cams[f"p{i}{j}"] = Camera.look_at(pos, (x * 0.5, 0.0, z * 0.5 - 4.0), HFOV, W, H)
    objs = [np.array([rng.uniform(-18, 18), 0.0, rng.uniform(-13, 13)]) for _ in range(objects)]
    return cams, objs


def object_box(cam: Camera, centre: np.ndarray) -> tuple[float, float, float, float] | None:
    corners = np.array(
        [
            centre + np.array([dx, 0.0, dz])
            for dx in (-OBJECT_HALF, OBJECT_HALF)
            for dz in (-OBJECT_HALF, OBJECT_HALF)
        ]
    )
    uv, ok = cam.project(corners, margin=0.0)
    if not ok.all():
        return None
    return (float(uv[:, 0].min()), float(uv[:, 1].min()), float(uv[:, 0].max()), float(uv[:, 1].max()))


def simulate(
    cams: dict[str, Camera], objs: list[np.ndarray], seed: int, recall: float, false_per_photo: float
) -> tuple[list[dict[str, Any]], dict[str, list[dict[str, Any]]], dict[str, list[int]]]:
    """The detector's drafts, the per-photo truth and, per photo, which object each truth item is."""
    rng = np.random.default_rng(seed + 1)
    drafts: list[dict[str, Any]] = []
    truth: dict[str, list[dict[str, Any]]] = {}
    owner: dict[str, list[int]] = {}
    for pid, cam in cams.items():
        truth[pid], owner[pid] = [], []
        for k, o in enumerate(objs):
            b = object_box(cam, o)
            if b is None:
                continue
            truth[pid].append({"box": b, "class": CLASS})
            owner[pid].append(k)
            if rng.random() > recall:
                continue
            w, h = b[2] - b[0], b[3] - b[1]
            j = rng.normal(0, 0.12, 4) * [w, h, w, h]
            box = [b[0] + j[0], b[1] + j[1], b[2] + j[2], b[3] + j[3]]
            drafts.append(_draft(f"{pid}-o{k}", pid, box, float(rng.uniform(0.55, 0.98))))
        for n in range(rng.poisson(false_per_photo)):
            x, y = rng.uniform(40, W - 80), rng.uniform(40, H - 80)
            s = rng.uniform(12, 40)
            drafts.append(_draft(f"{pid}-f{n}", pid, [x, y, x + s, y + s], float(rng.uniform(0.5, 0.95))))
    return drafts, truth, owner


def _draft(ident: str, photo: str, box: list[float], score: float) -> dict[str, Any]:
    return {"id": ident, "photo": photo, "class": CLASS, "severity": "uncertain", "status": "draft",
            "confidence": round(score, 4), "bbox": [round(v, 1) for v in box], "space": "preview",
            "origin": {"threshold": 0.8}}  # fmt: skip


def spread(dets: list[dict[str, Any]]) -> list[tuple[int, dict[str, Any]]]:
    """Per-photo boxes of a pass for the E2 metrics: (draft index, {photo, box, score})."""
    out = []
    for i, d in enumerate(dets):
        out.append((i, {"photo": d["photo"], "box": d["bbox"], "score": d.get("confidence")}))
        for s in (d.get("vote") or {}).get("sightings") or []:
            out.append((i, {"photo": s["photo"], "box": s["bbox"], "score": d.get("confidence")}))
    return out


def score(
    dets: list[dict[str, Any]],
    truth: dict[str, list[dict[str, Any]]],
    owner: dict[str, list[int]],
    threshold: float,
    n_objects: int,
) -> dict[str, Any]:
    rows = spread(dets)
    boxes = [r for _, r in rows]
    matches = metrics.match(boxes, truth, metrics.IOU_MIN)
    e2 = metrics.evaluate(boxes, truth, threshold, metrics.IOU_MIN, CLASS, len(truth), matches)
    curve = metrics.pr_curve(boxes, truth, metrics.IOU_MIN, CLASS, len(truth))
    best = max(curve, key=lambda r: r["f1"] or 0.0)
    # what a reviewer sees: drafts at the threshold, and whether each stands for a real object
    shown = {i for i, d in enumerate(dets) if (d.get("confidence") or 0) >= threshold}
    real: set[int] = set()
    covered: set[int] = set()
    for (i, r), (j, _) in zip(rows, matches, strict=True):
        if i in shown and j is not None:
            real.add(i)
            covered.add(owner[r["photo"]][j])
    return {
        "e2": {k: e2[k] for k in ("drafts", "tp", "fp", "fn", "precision", "recall", "f1", "draftsPerPhoto")},
        "bestF1": {"threshold": best["threshold"], "f1": best["f1"]},
        "review": {
            "drafts": len(shown),
            "real": len(real),
            "false": len(shown) - len(real),
            "objectsCovered": len(covered),
            "objects": n_objects,
            "singleViewFlagged": sum(1 for d in dets if (d.get("vote") or {}).get("singleView")),
        },
    }


def _site_mesh():
    import trimesh

    ground = trimesh.creation.box(extents=(80.0, 0.2, 60.0))
    ground.apply_translation((0.0, -0.1, 0.0))
    return ground


RUNS = ("before", "afterMesh", "afterRays")


def run_one(seed: int, threshold: float, recall: float, false_per_photo: float) -> dict[str, Any]:
    cams, objs = fixture(seed)
    drafts, truth, owner = simulate(cams, objs, seed, recall, false_per_photo)
    seen = {k for ks in owner.values() for k in ks}
    report: dict[str, Any] = {
        "fixture": {"seed": seed, "photos": len(cams), "objectsInView": len(seen),
                    "truthBoxes": sum(len(v) for v in truth.values()), "drafts": len(drafts),
                    "falseDrafts": sum(1 for d in drafts if "-f" in d["id"])},
        "before": score(drafts, truth, owner, threshold, len(seen)),
    }  # fmt: skip
    for name, surface in (("afterMesh", MeshSurface(_site_mesh())), ("afterRays", None)):
        voted, stats = vote(drafts, cams, surface)
        report[name] = score(voted, truth, owner, threshold, len(seen)) | {"vote": stats}
    return report


def run(
    seeds: list[int], threshold: float = 0.8, recall: float = 0.75, false_per_photo: float = 1.0
) -> dict[str, Any]:
    """Every seed's report and the totals over them (counts summed, ratios from the sums)."""
    each = [run_one(s, threshold, recall, false_per_photo) for s in seeds]
    total: dict[str, Any] = {
        "settings": {"seeds": seeds, "threshold": threshold, "recall": recall, "falsePerPhoto": false_per_photo,
                     "iou": metrics.IOU_MIN},
        "fixture": {k: sum(r["fixture"][k] for r in each) for k in ("photos", "objectsInView", "truthBoxes",
                                                                   "drafts", "falseDrafts")},
    }  # fmt: skip
    for name in RUNS:
        e2 = {k: sum(r[name]["e2"][k] for r in each) for k in ("drafts", "tp", "fp", "fn")}
        p = e2["tp"] / (e2["tp"] + e2["fp"]) if e2["tp"] + e2["fp"] else None
        rc = e2["tp"] / (e2["tp"] + e2["fn"]) if e2["tp"] + e2["fn"] else None
        e2 |= {"precision": p, "recall": rc, "f1": 2 * p * rc / (p + rc) if p and rc else 0.0}
        review = {k: sum(r[name]["review"][k] for r in each) for k in each[0][name]["review"]}
        best = [r[name]["bestF1"]["f1"] or 0.0 for r in each]
        total[name] = {"e2": e2, "review": review, "meanBestF1": sum(best) / len(best)}
    return {"total": total, "runs": each}


def _f(v: float | None) -> str:
    return "n/a" if v is None else f"{v:.3f}"


def table(r: dict[str, Any]) -> str:
    t = r["total"]
    lines = ["| | drafts to review | real | false | objects covered | E2 precision | E2 recall | E2 F1 | "
             "best F1 (mean) |",
             "| --- | --- | --- | --- | --- | --- | --- | --- | --- |"]  # fmt: skip
    for name in RUNS:
        e, v = t[name]["e2"], t[name]["review"]
        lines.append(
            f"| {name} | {v['drafts']} | {v['real']} | {v['false']} | {v['objectsCovered']} of {v['objects']} | "
            f"{_f(e['precision'])} | {_f(e['recall'])} | {_f(e['f1'])} | {_f(t[name]['meanBestF1'])} |"
        )
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Bench the multi-view vote on a synthetic multi-view fixture.")
    ap.add_argument("--seeds", type=int, default=10, help="fixtures to run (seeds 1 to N)")
    ap.add_argument("--threshold", type=float, default=0.8)
    ap.add_argument(
        "--recall", type=float, default=0.75, help="chance the simulated detector finds a seen object"
    )
    ap.add_argument("--false-per-photo", type=float, default=1.0)
    ap.add_argument("--out", help="folder for report.json")
    a = ap.parse_args(argv)
    r = run(list(range(1, a.seeds + 1)), a.threshold, a.recall, a.false_per_photo)
    if a.out:
        Path(a.out).mkdir(parents=True, exist_ok=True)
        (Path(a.out) / "report.json").write_text(json.dumps(r, indent=1) + "\n", "utf-8")
    print(json.dumps(r["total"]["settings"]))
    print(json.dumps(r["total"]["fixture"]))
    print(table(r))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
