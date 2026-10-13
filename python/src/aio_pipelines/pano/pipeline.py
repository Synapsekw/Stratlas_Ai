"""``pano.stitch``: the frames of one drone sphere into a level, north-up equirect.

Plan ``docs/plans/2026-10-13-drone-panoramas-p1.md`` (task 6), spec section 2. Reads
``panoramas/<layer>/<pano>/frames/`` and writes ``pano.jpg``, ``thumb.jpg`` and, last,
``stitch.json`` beside it; never the manifest (the app files the outcome). Steps, weighted by the
P0 timings: ``read`` (frame metadata, disk check), ``seed`` (rotations from the gimbal angles),
``match`` (features between overlapping frames), ``adjust`` (bundle adjustment or the seeds),
``compose`` (warp, exposure, seams, blend), ``fill`` (sky fill or wide crop, JPEGs), ``write``
(run record, files moved into place together). Everything a later step needs is in the job's
staging folder or the step outputs, so a cancelled job resumes from its last finished step, and
the old ``pano.jpg`` stays until a new one is complete.
"""

from __future__ import annotations

import os
import re
import time
from pathlib import Path
from typing import Any

import cv2
import numpy as np

from .. import __version__
from ..params import known_keys
from ..photo.native import check_disk
from ..runtime import (
    AtomicPath,
    JobError,
    Step,
    StepContext,
    atomic_write_bytes,
    atomic_write_json,
    commit_files,
    now_iso,
)
from . import align, compose
from .frames import FrameError, FrameInfo, encode_jpeg, list_frames, read_frame_info, read_image
from .geometry import rot_from_gimbal
from .record import MAX_FRAMES, SCHEMA, check_record

PANO_ID = re.compile(r"^[a-z0-9][a-z0-9-]*$")
WIDTHS = {"standard": 8192, "high": 16384}
#: Test-only output width (e2e and pytest): 512 to 16384 pixels.
WIDTH_ENV = "QUADRION_PANO_WIDTH"
MIN_FRAMES = 8
THUMB_QUALITY = 85
JPEG_QUALITY = 90
#: Disk the job needs per output pixel: the staged canvas and mask, the JPEGs and headroom.
DISK_BYTES_PER_PIXEL = 8
FRAMES_MISSING = "The frames of this panorama are missing."
#: Step weights: seconds per step at 8K on 24 cores, measured by P0.
WEIGHTS = {"read": 0.2, "seed": 0.1, "match": 5.7, "adjust": 6.0, "compose": 10.5, "fill": 2.4, "write": 1.0}


def out_width(quality: str) -> int:
    raw = os.environ.get(WIDTH_ENV)
    if not raw:
        return WIDTHS[quality]
    try:
        width = int(raw)
    except ValueError:
        raise JobError(f"{WIDTH_ENV} must be a whole number of pixels.") from None
    if not 512 <= width <= 16384:
        raise JobError(f"{WIDTH_ENV} must be 512 to 16384.")
    return width // 2 * 2


def _png(img: np.ndarray) -> bytes:
    ok, buf = cv2.imencode(".png", img, [cv2.IMWRITE_PNG_COMPRESSION, 1])
    if not ok:
        raise JobError("The stitched image could not be staged.")
    return buf.tobytes()


def _unpng(path: Path, flag: int) -> np.ndarray:
    img = cv2.imdecode(np.fromfile(str(path), dtype=np.uint8), flag)
    if img is None:
        raise JobError("The staged image is missing; start the stitch again.")
    return img


def _thumb(img: np.ndarray, wide: bool) -> np.ndarray:
    if not wide:
        return compose.thumbnail(img)
    h, w = img.shape[:2]
    size = (compose.THUMB_SIZE[0], max(1, round(compose.THUMB_SIZE[0] * h / w)))
    return cv2.resize(img, size, interpolation=cv2.INTER_AREA)


def _load(path: Path, scale: float, gray: bool = False) -> np.ndarray:
    """A frame read for matching or composing; one deleted since the read step is a missing frame."""
    try:
        return read_image(path, scale, gray=gray)
    except (OSError, FrameError):
        raise JobError(FRAMES_MISSING) from None


class PanoStitch:
    name = "pano.stitch"
    title = "Stitch drone panorama"
    description = (
        "One level, north-up 360 panorama from the frames of a drone sphere, aligned from its gimbal angles "
        "and features."
    )
    keys = frozenset({"layer", "pano", "quality", "shape"})
    required = frozenset({"layer", "pano"})

    # --- parameters (PanoStitchParams in packages/schema/src/jobs.ts) ----------------------------

    def validate(self, params: dict[str, Any]) -> dict[str, Any]:
        known_keys(params, set(self.keys), self.name)
        missing = sorted(k for k in self.required if params.get(k) is None)
        if missing:
            raise JobError(f"{self.name} needs: {', '.join(missing)}.")
        for key in ("layer", "pano"):
            v = params[key]
            if not isinstance(v, str) or not 1 <= len(v) <= 80 or not PANO_ID.match(v):
                raise JobError(f"{key} must be lower-case letters, digits and dashes, at most 80.")
        if params.get("quality") is not None and params["quality"] not in WIDTHS:
            raise JobError("quality must be standard or high.")
        if params.get("shape") is not None and params["shape"] not in ("sphere", "wide"):
            raise JobError("shape must be sphere or wide.")
        return dict(params)

    def inputs(self, params: dict[str, Any]) -> list[str]:
        return [f"panoramas/{params['layer']}/{params['pano']}/frames"]

    def plan(self, params: dict[str, Any]) -> list[Step]:
        layer: str = params["layer"]
        pano: str = params["pano"]
        quality: str = params.get("quality") or "standard"
        #: The import's classification; None decides from the real-pixel coverage.
        want: str | None = params.get("shape")
        rel = f"panoramas/{layer}/{pano}"

        def frames_dir(ctx: StepContext) -> Path:
            return ctx.out(f"{rel}/frames")

        def infos(ctx: StepContext) -> list[FrameInfo]:
            return [FrameInfo.from_json(d) for d in ctx.outputs("read")["frames"]]

        def seeds(ctx: StepContext) -> list[np.ndarray]:
            return [np.array(s, float) for s in ctx.outputs("seed")["seeds"]]

        # --- read --------------------------------------------------------------------------------
        def read(ctx: StepContext) -> dict[str, Any]:
            t0 = time.monotonic()
            width = out_width(quality)
            paths = list_frames(frames_dir(ctx))
            if not paths:
                raise JobError(FRAMES_MISSING)
            if len(paths) > MAX_FRAMES:
                raise JobError(
                    f"This panorama has {len(paths)} frames; at most {MAX_FRAMES} can be stitched. "
                    "It is probably several spheres taken close together."
                )
            used: list[FrameInfo] = []
            dropped: list[dict[str, str]] = []
            for p in paths:
                ctx.check()
                try:
                    used.append(read_frame_info(p))
                except FrameError as e:
                    dropped.append({"file": p.name, "reason": str(e)})
            if len(used) < MIN_FRAMES:
                raise JobError(
                    f"Only {len(used)} of the frames can be used; a panorama needs at least {MIN_FRAMES}."
                    if len(paths) >= MIN_FRAMES
                    else FRAMES_MISSING
                )
            sizes = {(f.width, f.height) for f in used}
            if len(sizes) > 1:
                raise JobError("The frames of this panorama are not all the same size.")
            check_disk(ctx.project, width * (width // 2) * DISK_BYTES_PER_PIXEL)
            return {
                "frames": [f.to_json() for f in used],
                "dropped": dropped,
                "width": width,
                "seconds": time.monotonic() - t0,
            }

        # --- seed --------------------------------------------------------------------------------
        def seed(ctx: StepContext) -> dict[str, Any]:
            t0 = time.monotonic()
            rots = [rot_from_gimbal(f.yaw, f.pitch, f.roll).tolist() for f in infos(ctx)]
            return {"seeds": rots, "seconds": time.monotonic() - t0}

        # --- match -------------------------------------------------------------------------------
        def match(ctx: StepContext) -> dict[str, Any]:
            t0 = time.monotonic()
            fs = infos(ctx)
            scale = align.work_scale(fs[0].width)
            grays = []
            for n, f in enumerate(fs):
                ctx.check()
                grays.append(_load(frames_dir(ctx) / f.name, scale, gray=True))
                ctx.progress(0.3 * (n + 1) / len(fs))
            focal = fs[0].focal * scale
            found = align.match_frames(
                grays, seeds(ctx), focal, ctx.check, lambda x: ctx.progress(0.3 + 0.7 * x)
            )
            size = [int(grays[0].shape[1]), int(grays[0].shape[0])]
            staged = ctx.stage("match.npz")
            empty = np.zeros((0, 2), np.float32)
            with AtomicPath(staged) as tmp:
                np.savez(
                    tmp,
                    i=np.array([m.i for m in found], np.int32),
                    j=np.array([m.j for m in found], np.int32),
                    n=np.array([len(m.a) for m in found], np.int32),
                    a=np.concatenate([m.a for m in found]) if found else empty,
                    b=np.concatenate([m.b for m in found]) if found else empty,
                )
            return {
                "pairs": len(found),
                "focalWork": focal,
                "workSize": size,
                "seconds": time.monotonic() - t0,
            }

        # --- adjust ------------------------------------------------------------------------------
        def adjust(ctx: StepContext) -> dict[str, Any]:
            t0 = time.monotonic()
            m = ctx.outputs("match")
            with np.load(ctx.stage("match.npz")) as z:
                bounds = np.concatenate([[0], np.cumsum(z["n"])])
                found = [
                    align.PairMatch(int(i), int(j), z["a"][s:e], z["b"][s:e])
                    for i, j, s, e in zip(z["i"], z["j"], bounds[:-1], bounds[1:], strict=True)
                ]
            result = align.align(seeds(ctx), found, float(m["focalWork"]), tuple(m["workSize"]))
            if result.reason:
                ctx.log(f"Aligned from the gimbal angles only: {result.reason}", "warn")
            return {
                "rotations": [r.tolist() for r in result.rotations],
                "aligned": result.aligned,
                "focalScale": result.focal_scale,
                "residualPx": result.residual_px,
                "maxDriftDeg": result.max_drift_deg,
                "unmatched": result.unmatched,
                "reason": result.reason,
                "seconds": time.monotonic() - t0,
            }

        # --- compose -----------------------------------------------------------------------------
        def compose_step(ctx: StepContext) -> dict[str, Any]:
            t0 = time.monotonic()
            width = int(ctx.outputs("read")["width"])
            height = width // 2
            adj = ctx.outputs("adjust")
            fs = infos(ctx)
            pieces: list[compose.Piece] = []
            for n, (f, rot) in enumerate(zip(fs, adj["rotations"], strict=True)):
                ctx.check()
                focal = f.focal * float(adj["focalScale"])
                scale = compose.frame_scale(focal, width)
                img = _load(frames_dir(ctx) / f.name, scale)
                pieces += compose.warp(img, np.array(rot, float), focal * scale, width, height)
                ctx.progress(0.6 * (n + 1) / len(fs))
            canvas, covered = compose.blend(pieces, width, height, ctx.check)
            del pieces
            atomic_write_bytes(ctx.stage("canvas.png"), _png(canvas))
            atomic_write_bytes(ctx.stage("covered.png"), _png(covered))
            return {"seconds": time.monotonic() - t0}

        # --- fill --------------------------------------------------------------------------------
        def fill(ctx: StepContext) -> dict[str, Any]:
            t0 = time.monotonic()
            canvas = _unpng(ctx.stage("canvas.png"), cv2.IMREAD_COLOR)
            covered = _unpng(ctx.stage("covered.png"), cv2.IMREAD_GRAYSCALE)
            h, w = covered.shape
            # a "wide" hint on a canvas covered all round still yields a sphere
            crop = None if want == "sphere" else compose.wide_crop(covered)
            if crop is None:
                top, bottom = compose.coverage_deg(covered)
                coverage: dict[str, float] = {"topDeg": top, "bottomDeg": bottom}
                compose.fill_sky(canvas, covered)
                out = canvas
            else:
                out = compose.apply_wide_crop(canvas, crop)
                compose.fill_wide(out, compose.apply_wide_crop(covered, crop))
                top, bottom = compose.lat_range_deg(crop, h)
                left, right = compose.yaw_range_deg(crop, w)
                coverage = {"topDeg": top, "bottomDeg": bottom, "leftDeg": left, "rightDeg": right}
            ctx.check()
            atomic_write_bytes(ctx.stage("pano.jpg"), encode_jpeg(out, JPEG_QUALITY))
            atomic_write_bytes(
                ctx.stage("thumb.jpg"), encode_jpeg(_thumb(out, crop is not None), THUMB_QUALITY)
            )
            return {
                "shape": "sphere" if crop is None else "wide",
                "coverage": coverage,
                "size": {"width": int(out.shape[1]), "height": int(out.shape[0])},
                "seconds": time.monotonic() - t0,
            }

        # --- write -------------------------------------------------------------------------------
        def write(ctx: StepContext) -> dict[str, Any]:
            t0 = time.monotonic()
            rd, adj, fl = ctx.outputs("read"), ctx.outputs("adjust"), ctx.outputs("fill")
            timings = {
                s: round(float(ctx.outputs(s).get("seconds", 0.0)), 3) for s in WEIGHTS if s != "write"
            }
            warnings = [f"Aligned from the gimbal angles only: {adj['reason']}"] if adj.get("reason") else []
            if adj.get("unmatched") and adj["aligned"] == "features":
                warnings.append(
                    f"{len(adj['unmatched'])} frames had no matching features and keep their gimbal angles."
                )
            doc = {
                "schema": SCHEMA,
                "run": ctx.job.job_id,
                "layer": layer,
                "pano": pano,
                "createdAt": now_iso(),
                "engine": {"version": __version__, "opencv": cv2.__version__},
                "quality": quality,
                "shape": fl["shape"],
                "size": fl["size"],
                "frames": {"used": [f["name"] for f in rd["frames"]], "dropped": rd["dropped"]},
                "aligned": adj["aligned"],
                "residualPx": adj["residualPx"],
                "maxDriftDeg": adj["maxDriftDeg"],
                "focalScale": round(float(adj["focalScale"]), 5),
                "coverage": fl["coverage"],
                "timings": {**timings, "write": round(time.monotonic() - t0, 3)},
                "warnings": warnings,
            }
            check_record(doc)
            atomic_write_json(ctx.stage("stitch.json"), doc)
            # the images first, the record last: a reader never sees a record of images not there
            commit_files(
                ctx,
                [
                    ("pano.jpg", f"{rel}/pano.jpg"),
                    ("thumb.jpg", f"{rel}/thumb.jpg"),
                    ("stitch.json", f"{rel}/stitch.json"),
                ],
            )
            return {"seconds": time.monotonic() - t0}

        return [
            Step("read", "Read the frames", read, WEIGHTS["read"]),
            Step("seed", "Start from the gimbal angles", seed, WEIGHTS["seed"]),
            Step("match", "Match features", match, WEIGHTS["match"]),
            Step("adjust", "Align the frames", adjust, WEIGHTS["adjust"]),
            Step("compose", "Compose the panorama", compose_step, WEIGHTS["compose"]),
            Step("fill", "Fill the sky", fill, WEIGHTS["fill"]),
            Step("write", "Write the panorama", write, WEIGHTS["write"]),
        ]
