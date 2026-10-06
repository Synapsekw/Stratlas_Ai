"""change.frames: changes in pose-matched frame and photo pairs, as draft detections (M8 C4).

Parameters as ``ChangeFramesParams`` in ``@aio/schema``: explicit ``pairs`` (the app pairs the
photos by camera pose, ``@aio/video`` ``pairsFor``), or ``from`` and ``to`` to pair the photos of the
two dates here by pose (distance and view angle within ``maxPoseM`` and ``maxAngleDeg``).

Each pair is aligned by ORB features and a RANSAC homography (scikit-image), the earlier frame is
warped into the later one, exposure is matched, and what still differs becomes a change mask. Its
regions become draft detections ``source: model``, ``label: change`` on the later photo in
``detections/change-frames-<run>.json`` (they flow into the existing review), and each pair a
``frame`` item in the change set ``change/<from>-<to>-frames.json`` (data-conventions section 14;
reviews survive a recompute). The masks go to ``change/<from>-<to>-frames/<photo>.png``.

Video frames are skipped with a note: the pipeline pack has no video decoder.
"""

from __future__ import annotations

import json
import math
import re
import shutil
from pathlib import Path
from typing import Any

import numpy as np

from ..params import known_keys, number, text
from ..runtime import JobError, Step, StepContext, atomic_write_bytes, commit_files, now_iso
from .changeset import change_set, change_set_id, dump_change_set, merge_reviews, read_change_set

NAME = "change.frames"
DEFAULT_MAX_POSE_M = 10.0
DEFAULT_MAX_ANGLE_DEG = 15.0
DEFAULT_MIN_AREA_PX = 400
MAX_PAIRS = 5000
#: Working size of the longer image side for features and differences.
WORK_SIDE = 1024
#: Alignment needs this many RANSAC inliers and this share of the matches.
MIN_INLIERS = 15
MIN_INLIER_SHARE = 0.2


# ------------------------------------------------------------------ image change


def _gray(img: np.ndarray) -> np.ndarray:
    a = np.asarray(img, dtype=np.float64)
    if a.ndim == 3:
        a = a[..., :3].mean(axis=2)
    if a.max() > 1.0:
        a = a / 255.0
    return a


def _resize(a: np.ndarray, scale: float) -> np.ndarray:
    if scale >= 1.0:
        return a
    from skimage.transform import resize

    h, w = a.shape
    return resize(a, (max(8, round(h * scale)), max(8, round(w * scale))), anti_aliasing=True)


def frame_change(
    a: np.ndarray, b: np.ndarray, min_area_px: float = DEFAULT_MIN_AREA_PX, work_side: int = WORK_SIDE
) -> dict[str, Any]:
    """Change between frame ``a`` (earlier) and ``b`` (later), in ``b``'s pixels.

    Returns ``aligned``, ``inliers``, ``regions`` (``bbox`` ``[x0, y0, x1, y1]``, ``areaPx``,
    ``score`` 0 to 1) and ``mask`` (bool, working size of ``b``).
    """
    from scipy import ndimage as ndi
    from skimage.feature import ORB, match_descriptors
    from skimage.measure import ransac
    from skimage.transform import ProjectiveTransform, warp

    ga, gb = _gray(a), _gray(b)
    sa = min(1.0, work_side / max(ga.shape))
    sb = min(1.0, work_side / max(gb.shape))
    wa, wb = _resize(ga, sa), _resize(gb, sb)
    empty = {"aligned": False, "inliers": 0, "regions": [], "mask": np.zeros(wb.shape, bool)}

    orb = ORB(n_keypoints=1500, fast_threshold=0.05)
    try:
        orb.detect_and_extract(wa)
        ka, da = orb.keypoints, orb.descriptors
        orb.detect_and_extract(wb)
        kb, db = orb.keypoints, orb.descriptors
    except RuntimeError:  # no features at all (a flat image)
        return empty
    matches = match_descriptors(db, da, cross_check=True, max_ratio=0.85)
    if len(matches) < MIN_INLIERS:
        return empty
    src = kb[matches[:, 0]][:, ::-1]  # (x, y) in b
    dst = ka[matches[:, 1]][:, ::-1]  # (x, y) in a
    model, inliers = ransac(
        (src, dst),
        ProjectiveTransform,
        min_samples=4,
        residual_threshold=2.0,
        max_trials=3000,
        rng=0,
    )
    n_in = int(inliers.sum()) if inliers is not None else 0
    if model is None or n_in < MIN_INLIERS or n_in < MIN_INLIER_SHARE * len(matches):
        return {**empty, "inliers": n_in}

    # the earlier frame in the later one's pixels, and where it has data
    aw = warp(wa, model, output_shape=wb.shape, order=1, cval=0.0)
    valid = warp(np.ones_like(wa), model, output_shape=wb.shape, order=0, cval=0.0) > 0.5
    valid = ndi.binary_erosion(valid, iterations=4)
    if valid.mean() < 0.3:
        return {**empty, "inliers": n_in}

    # match exposure (gain and offset) over the shared area, then compare smoothed frames
    ma, sda = aw[valid].mean(), aw[valid].std() or 1.0
    mb, sdb = wb[valid].mean(), wb[valid].std() or 1.0
    an = (aw - ma) / sda * sdb + mb
    diff = np.abs(ndi.gaussian_filter(wb, 1.5) - ndi.gaussian_filter(an, 1.5))
    d = diff[valid]
    med = float(np.median(d))
    mad = float(np.median(np.abs(d - med))) * 1.4826
    thr = max(0.2, med + 8.0 * mad)
    mask = (diff > thr) & valid
    mask = ndi.binary_opening(mask, iterations=2)
    mask = ndi.binary_closing(mask, iterations=4)
    mask = ndi.binary_fill_holes(mask) & valid

    labels, _ = ndi.label(mask)
    regions: list[dict[str, Any]] = []
    keep = np.zeros_like(mask)
    min_work = min_area_px * sb * sb
    for i, sl in enumerate(ndi.find_objects(labels), start=1):
        if sl is None:
            continue
        part = labels[sl] == i
        area = int(part.sum())
        if area < min_work:
            continue
        keep[sl] |= part
        y0, y1, x0, x1 = sl[0].start, sl[0].stop, sl[1].start, sl[1].stop
        score = float(min(1.0, diff[sl][part].mean() / 0.5))
        regions.append(
            {
                "bbox": [round(x0 / sb), round(y0 / sb), round(x1 / sb), round(y1 / sb)],
                "areaPx": round(area / (sb * sb)),
                "score": round(score, 3),
            }
        )
    regions.sort(key=lambda r: -r["areaPx"])
    return {"aligned": True, "inliers": n_in, "regions": regions, "mask": keep}


# ------------------------------------------------------------------ the project


def _read_manifest(project: Path) -> dict[str, Any]:
    p = project / "manifest.json"
    try:
        return json.loads(p.read_text("utf-8-sig"))
    except (OSError, ValueError) as e:
        raise JobError(f"The project manifest could not be read ({e}).") from e


def _date_tokens(capture: dict[str, Any]) -> list[str]:
    out = [str(capture.get("id", "")).lower()]
    m = re.match(r"^(\d{4})-(\d{2})-(\d{2})$", str(capture.get("date", "")))
    if m:
        out += [f"{m[1]}-{m[2]}-{m[3]}", f"{m[1]}{m[2]}{m[3]}"]
    return [t for t in out if t]


def layer_capture(layer: dict[str, Any], captures: list[dict[str, Any]]) -> str | None:
    """The survey date of a layer: its ``capture``, else the one capture its id or name names."""
    ids = {c.get("id") for c in captures}
    if layer.get("capture") in ids:
        return layer["capture"]
    words = set(re.split(r"[^a-z0-9-]+", f"{layer.get('id', '')} {layer.get('name', '')}".lower()))
    words |= {w for x in list(words) for w in x.split("-")}
    hits = [c["id"] for c in captures if any(t in words for t in _date_tokens(c))]
    return hits[0] if len(hits) == 1 else None


def _rotate(q: list[float], v: tuple[float, float, float]) -> np.ndarray:
    x, y, z, w = q
    u = np.array([x, y, z])
    vv = np.array(v, dtype=float)
    return vv + 2 * w * np.cross(u, vv) + 2 * np.cross(u, np.cross(u, vv))


def _pose(item: dict[str, Any]) -> tuple[np.ndarray, np.ndarray] | None:
    pos, q = item.get("pos"), item.get("q")
    if not (isinstance(pos, list) and isinstance(q, list) and len(pos) == 3 and len(q) == 4):
        return None
    n = math.sqrt(sum(c * c for c in q)) or 1.0
    return np.array(pos, dtype=float), _rotate([c / n for c in q], (0.0, 0.0, -1.0))


def pose_gap(pa: dict[str, Any], pb: dict[str, Any]) -> tuple[float, float] | None:
    """Camera distance (m) and view angle (degrees) between two posed photos."""
    a, b = _pose(pa), _pose(pb)
    if not a or not b:
        return None
    d = float(np.linalg.norm(a[0] - b[0]))
    cos = float(np.clip(np.dot(a[1], b[1]) / (np.linalg.norm(a[1]) * np.linalg.norm(b[1])), -1, 1))
    return d, math.degrees(math.acos(cos))


def _ref_key(ref: dict[str, Any]) -> str:
    return f"{ref['layer']}/{ref['photo']}" if "photo" in ref else f"{ref['layer']}@{ref['t']:g}"


def _check_ref(ref: Any, where: str) -> dict[str, Any]:
    if not isinstance(ref, dict) or set(ref) - {"layer", "t", "photo"}:
        raise JobError(f"{where} must be a frame: a layer with a time or a photo.")
    if not isinstance(ref.get("layer"), str) or not ref["layer"]:
        raise JobError(f"{where} names no layer.")
    has_t, has_p = "t" in ref, "photo" in ref
    if has_t == has_p:
        raise JobError(f"{where}: a frame names a time or a photo, not both.")
    if has_t and (isinstance(ref["t"], bool) or not isinstance(ref["t"], int | float) or ref["t"] < 0):
        raise JobError(f"{where}: the time must be a number of seconds.")
    if has_p and (not isinstance(ref["photo"], str) or not ref["photo"]):
        raise JobError(f"{where} names no photo.")
    return dict(ref)


class ChangeFrames:
    name = NAME
    title = "Change in matched frames"
    description = "Frame and photo pairs of two dates aligned by features; changes become draft detections."
    keys = frozenset({"pairs", "from", "to", "maxPoseM", "maxAngleDeg", "minAreaPx", "out"})

    def validate(self, params: dict[str, Any]) -> dict[str, Any]:
        known_keys(params, set(self.keys), self.name)
        out = dict(params)
        pairs = params.get("pairs")
        if pairs is not None:
            if not isinstance(pairs, list) or not pairs or len(pairs) > MAX_PAIRS:
                raise JobError(f"pairs must be a list of 1 to {MAX_PAIRS} frame pairs.")
            checked = []
            for i, p in enumerate(pairs):
                if not isinstance(p, dict) or set(p) != {"a", "b"}:
                    raise JobError(f"Pair {i + 1} must give a and b.")
                checked.append(
                    {"a": _check_ref(p["a"], f"Pair {i + 1} a"), "b": _check_ref(p["b"], f"Pair {i + 1} b")}
                )
            out["pairs"] = checked
        for key in ("from", "to", "out"):
            text(params, key)
        if pairs is None and not (params.get("from") and params.get("to")):
            raise JobError("Give the frame pairs, or the two dates to pair.")
        number(params, "maxPoseM", lo=1e-6, hi=1000)
        number(params, "maxAngleDeg", lo=1e-6, hi=180)
        number(params, "minAreaPx", lo=1, integer=True)
        return out

    def inputs(self, params: dict[str, Any]) -> list[str]:
        return ["manifest.json"]

    def plan(self, params: dict[str, Any]) -> list[Step]:
        return [
            Step("pair", "Pair the frames of the two dates", self._pair, 0.05),
            Step("compare", "Compare each pair", self._compare, 1.0),
            Step("write", "Write the changes for review", self._write, 0.1),
        ]

    # ---------------------------------------------------------------- steps

    def _pair(self, ctx: StepContext) -> dict[str, Any]:
        p = ctx.params
        manifest = _read_manifest(ctx.project)
        captures = [c for c in manifest.get("captures", []) if isinstance(c, dict)]
        layers = {lay.get("id"): lay for lay in manifest.get("layers", []) if isinstance(lay, dict)}

        def photo(ref: dict[str, Any]) -> dict[str, Any] | None:
            lay = layers.get(ref["layer"])
            if not lay or lay.get("kind") != "photos":
                return None
            return next((it for it in lay.get("items", []) if it.get("id") == ref.get("photo")), None)

        pairs: list[dict[str, Any]] = p.get("pairs") or []
        frm, to = p.get("from"), p.get("to")
        if pairs and not (frm and to):
            first = pairs[0]
            la, lb = layers.get(first["a"]["layer"]), layers.get(first["b"]["layer"])
            frm = frm or (layer_capture(la, captures) if la else None)
            to = to or (layer_capture(lb, captures) if lb else None)
            if not (frm and to):
                raise JobError(
                    "Give the two dates (from and to): the layers do not say which survey they belong to."
                )
        if frm == to:
            raise JobError(f"The two dates are the same ({frm}).")
        if not pairs:
            pairs = self._pose_pairs(ctx, layers, captures, frm, to)

        out: list[dict[str, Any]] = []
        skipped = 0
        for i, pair in enumerate(pairs):
            a, b = pair["a"], pair["b"]
            if "t" in a or "t" in b:
                skipped += 1
                ctx.log(
                    f"Pair {i + 1} ({_ref_key(a)} with {_ref_key(b)}) is a video frame: video frames "
                    "are not compared yet, this pipeline pack cannot decode video.",
                    "warn",
                )
                continue
            pa, pb = photo(a), photo(b)
            if pa is None or pb is None:
                skipped += 1
                ctx.log(
                    f"Pair {i + 1}: the photo {_ref_key(a if pa is None else b)} is not in the project.",
                    "warn",
                )
                continue
            rec: dict[str, Any] = {"a": a, "b": b, "aSrc": pa.get("src"), "bSrc": pb.get("src")}
            gap = pose_gap(pa, pb)
            if gap:
                rec["poseM"], rec["angleDeg"] = gap
            out.append(rec)
        ctx.log(f"{len(out)} pairs to compare between {frm} and {to}.")
        return {"from": frm, "to": to, "pairs": out, "skipped": skipped}

    def _pose_pairs(self, ctx, layers, captures, frm, to) -> list[dict[str, Any]]:
        max_d = number(ctx.params, "maxPoseM", DEFAULT_MAX_POSE_M) or DEFAULT_MAX_POSE_M
        max_a = number(ctx.params, "maxAngleDeg", DEFAULT_MAX_ANGLE_DEG) or DEFAULT_MAX_ANGLE_DEG

        def posed(cap: str) -> list[tuple[str, dict[str, Any]]]:
            return [
                (lay["id"], it)
                for lay in layers.values()
                if lay.get("kind") == "photos" and layer_capture(lay, captures) == cap
                for it in lay.get("items", [])
                if _pose(it)
            ]

        a_list, b_list = posed(frm), posed(to)
        pairs = []
        for la, pa in a_list:
            best: tuple[float, str, dict[str, Any]] | None = None
            for lb, pb in b_list:
                gap = pose_gap(pa, pb)
                if not gap or gap[0] > max_d or gap[1] > max_a:
                    continue
                cost = gap[0] / max_d + gap[1] / max_a
                if best is None or cost < best[0]:
                    best = (cost, lb, pb)
            if best:
                pairs.append(
                    {"a": {"layer": la, "photo": pa["id"]}, "b": {"layer": best[1], "photo": best[2]["id"]}}
                )
        if not pairs:
            raise JobError(
                f"No photos of {frm} and {to} show the same view (within {max_d:g} m and {max_a:g} degrees)."
            )
        return pairs[:MAX_PAIRS]

    def _compare(self, ctx: StepContext) -> dict[str, Any]:
        from PIL import Image

        prev = ctx.outputs("pair")
        pairs = prev.get("pairs", [])
        min_area = number(ctx.params, "minAreaPx", DEFAULT_MIN_AREA_PX) or DEFAULT_MIN_AREA_PX
        set_id = change_set_id(prev["from"], prev["to"], NAME)
        mask_dir = (ctx.params.get("out") or f"change/{set_id}").strip("/")
        results: list[dict[str, Any]] = []
        skipped = int(prev.get("skipped", 0))

        def path_of(src: Any) -> Path:
            if isinstance(src, dict) and isinstance(src.get("path"), str):
                return ctx.input(src["path"])
            if isinstance(src, dict) and isinstance(src.get("hash"), str):
                return ctx.input(f"assets/sha256/{src['hash']}")
            raise JobError("A photo has no file.")

        for i, pair in enumerate(pairs):
            ctx.check()
            ctx.progress(i / max(1, len(pairs)), f"Pair {i + 1} of {len(pairs)}")
            try:
                with Image.open(path_of(pair["aSrc"])) as im:
                    a = np.asarray(im.convert("L"), dtype=np.float64) / 255.0
                with Image.open(path_of(pair["bSrc"])) as im:
                    b = np.asarray(im.convert("L"), dtype=np.float64) / 255.0
            except (OSError, JobError) as e:
                skipped += 1
                ctx.log(
                    f"Pair {i + 1} ({_ref_key(pair['a'])} with {_ref_key(pair['b'])}) skipped: {e}", "warn"
                )
                continue
            r = frame_change(a, b, min_area_px=min_area)
            res = {k: pair[k] for k in ("a", "b", "poseM", "angleDeg") if k in pair}
            res.update(
                aligned=r["aligned"],
                inliers=r["inliers"],
                regions=r["regions"],
                width=b.shape[1],
                height=b.shape[0],
            )
            if not r["aligned"]:
                skipped += 1
                ctx.log(
                    f"Pair {i + 1} ({_ref_key(pair['b'])}) could not be lined up ({r['inliers']} matches).",
                    "warn",
                )
                continue
            if r["regions"]:
                name = re.sub(r"[^A-Za-z0-9._-]+", "-", str(pair["b"].get("photo")))
                rel = f"masks/{name}.png"
                Image.fromarray(r["mask"].astype(np.uint8) * 255, "L").save(ctx.stage(rel))
                res["mask"] = {"staged": rel, "project": f"{mask_dir}/{name}.png"}
            results.append(res)
        ctx.progress(1.0)
        return {"results": results, "skipped": skipped}

    def _write(self, ctx: StepContext) -> dict[str, Any]:
        pair = ctx.outputs("pair")
        cmp_ = ctx.outputs("compare")
        frm, to = pair["from"], pair["to"]
        run = ctx.job.job_id
        det_name = f"change-frames-{run}.json"
        set_id = change_set_id(frm, to, NAME)
        at = now_iso()

        detections: list[dict[str, Any]] = []
        items: list[dict[str, Any]] = []
        layers_b: set[str] = set()
        regions_total = 0
        for i, r in enumerate(cmp_.get("results", [])):
            ids = []
            for k, reg in enumerate(r["regions"]):
                did = f"chg-{i + 1:04d}-{k + 1}"
                ids.append(f"{det_name}#{did}")
                layers_b.add(r["b"]["layer"])
                detections.append(
                    {
                        "id": did,
                        "photo": r["b"]["photo"],
                        "class": "change",
                        "label": "change",
                        "status": "draft",
                        "source": "model",
                        "bbox": reg["bbox"],
                        "confidence": reg["score"],
                        "note": f"Changed since the photo {r['a']['photo']} of {frm}.",
                        "origin": {"model": NAME, "runId": run},
                        "createdAt": at,
                    }
                )
            regions_total += len(ids)
            item: dict[str, Any] = {
                "kind": "frame",
                "id": f"frame:{_ref_key(r['a'])}:{_ref_key(r['b'])}"[:200],
                "verdict": "changed" if ids else "unchanged",
                "a": r["a"],
                "b": r["b"],
                "method": "pose",
                "label": (
                    f"{len(ids)} change{'s' if len(ids) != 1 else ''} in {r['b']['photo']}"
                    if ids
                    else f"No change in {r['b']['photo']}"
                ),
            }
            if ids:
                item["detections"] = ids
                item["score"] = max(reg["score"] for reg in r["regions"])
            if "poseM" in r:
                item["poseM"] = r["poseM"]
            if "angleDeg" in r:
                item["angleDeg"] = r["angleDeg"]
            items.append(item)

        # one pass file per run; its layer is the later photos when they share one
        det_file: dict[str, Any] = {
            "schema": "aio.detections/1",
            "source": "model",
            "producer": NAME,
            "createdAt": at,
            "run": {"id": run, "at": at, "model": NAME, "images": len(items), "detections": len(detections)},
            "detections": detections,
        }
        if len(layers_b) == 1:
            det_file["layer"] = next(iter(layers_b))
        elif not layers_b and items:
            det_file["layer"] = items[0]["b"]["layer"]
        atomic_write_bytes(
            ctx.stage(f"detections/{det_name}"),
            (json.dumps(det_file, indent=1, ensure_ascii=False) + "\n").encode("utf-8"),
        )

        stats = {
            "pairs": len(items),
            "changed": sum(1 for it in items if it["verdict"] == "changed"),
            "regions": regions_total,
            "skipped": int(cmp_.get("skipped", 0)),
        }
        cs = change_set(
            set_id,
            frm,
            to,
            NAME,
            items,
            stats=stats,
            run={"jobId": run, "at": at, "params": {k: v for k, v in ctx.params.items() if k != "pairs"}},
        )
        dest = ctx.out(f"change/{set_id}.json")
        merged = merge_reviews(cs, read_change_set(dest) if dest.exists() else None)
        atomic_write_bytes(ctx.stage(f"change/{set_id}.json"), dump_change_set(merged))

        moves = [(f"detections/{det_name}", f"detections/{det_name}")]
        moves += [(r["mask"]["staged"], r["mask"]["project"]) for r in cmp_.get("results", []) if "mask" in r]
        commit_files(ctx, moves)
        if dest.exists():
            shutil.copy2(dest, dest.with_name(dest.name + ".bak"))
        commit_files(ctx, [(f"change/{set_id}.json", f"change/{set_id}.json")])
        ctx.log(
            f"{stats['changed']} of {stats['pairs']} pairs changed, {regions_total} draft detections "
            f"in detections/{det_name}."
        )
        return {"changeSet": f"change/{set_id}.json", "detections": f"detections/{det_name}", **stats}
