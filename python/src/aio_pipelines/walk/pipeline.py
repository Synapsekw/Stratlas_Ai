"""``walk.process``: levelled copy, orientation, raw path, sparse points and map stills of a walk.

Plan ``docs/plans/2026-10-12-walk-process-pipeline.md`` (task 7), spec decisions 5 to 12. Works on
``walks/<walk>/`` and writes only into it (never ``walk.json`` or the manifest). Steps:

1. ``read``: ``walk.json``; the original (``src``: name and size against ``walk.json``'s
   ``source``) or, without it, the playback copy; trailer, lens calibration, motion data, the
   orientation at every output frame and the decimated ``imu.bin``; the disk check.
2. ``frames``: one decode pass (``stitch.run_frames``): the levelled copy when there is motion
   data and ``stabilize`` is on, the SfM stills (half size) and the map stills (full size).
3. ``sfm``: ``sfm.run_sfm`` on the stills, or pins-only: ``sfm`` off, fewer than 20 stills
   ("Too short for a path"), under 60 % registered, or SfM raising (a warning, the job stays green).
4. ``finish``: raw path, orientation records, then everything moved into ``walks/<walk>/``
   together (the previous run's ``process.json`` removed first, files it had that this run did not
   write removed), ``process.json`` last.

Everything a later step needs is in the job's staging folder or the step outputs, so a cancelled
job resumes from its last finished step.
"""

from __future__ import annotations

import json
import math
import os
import re
import shutil
import time
from importlib.metadata import PackageNotFoundError
from importlib.metadata import version as pkg_version
from pathlib import Path
from typing import Any

import numpy as np

from .. import __version__
from ..params import known_keys, number
from ..photo.model import qvec_to_rotmat
from ..photo.native import check_disk
from ..runtime import (
    Cancelled,
    JobError,
    Step,
    StepContext,
    atomic_write_json,
    commit_files,
    commit_tree,
    now_iso,
)
from . import ffmpeg as ff
from . import motion, outputs, stills
from .calib import Lens, default_lenses, parse_offset
from .sfm import run_sfm, write_ply
from .stitch import MAX_WIDTH, FrameSink, output_fps, output_size, run_frames
from .trailer import read_trailer

WALK_ID = re.compile(r"^[a-z0-9][a-z0-9-]*$")
MAX_SRC = 20
MAX_PATH = 1024
MIN_SFM_STILLS = 20
MIN_REGISTERED = 0.6
MIN_IMU_SAMPLES = 10
TOO_SHORT = "Too short for a path: the walk can be placed by pins."
DEFAULTS = {
    "stillsPerS": 2.0,
    "maskBottom": 0.25,
    "strideM": 0.7,
    "stabilize": True,
    "sfm": True,
    "chunk": 300,
}
# Files of a run in the walk's folder, in the order they are moved into place (stills first).
RUN_FILES = (
    "sparse.ply",
    "imu.bin",
    "stabilized.mp4",
    "orientation.bin",
    "orientation.json",
    "raw-path.json",
)
OUTPUT_KEYS = {
    "raw-path.json": "rawPath",
    "orientation.json": "orientation",
    "imu.bin": "imu",
    "sparse.ply": "sparse",
    "stabilized.mp4": "stabilized",
}


def _refuse_original(name: str) -> JobError:
    return JobError(f"The original {name} was not found or has changed.")


def _same_name(a: str, b: str) -> bool:
    return a.casefold() == b.casefold() if os.name == "nt" else a == b


def check_src(src: list[str], source: dict[str, Any]) -> None:
    """The original against ``walk.json``'s ``source``: the first file's name and size (when
    recorded); later files are chapters of the same clip (same stem, ``_001``, ``_002``...)."""
    expected = str(source.get("file") or "")
    first = Path(src[0])
    if not expected or not _same_name(first.name, expected) or not first.is_file():
        raise _refuse_original(expected or first.name)
    size = source.get("bytes")
    if isinstance(size, int) and first.stat().st_size != size:
        raise _refuse_original(expected)
    m = re.match(r"^(.*)_(\d{3})$", Path(expected).stem)
    for raw in src[1:]:
        p = Path(raw)
        if not p.is_file():
            raise _refuse_original(p.name)
        chapter = m is not None and re.fullmatch(re.escape(m.group(1)) + r"_\d{3}", p.stem, re.IGNORECASE)
        if not chapter or not _same_name(p.suffix, first.suffix):
            raise JobError(f"{p.name} is not a chapter of {expected}.")


def _load_walk(path: Path, wid: str) -> dict[str, Any]:
    try:
        if path.stat().st_size > 256 * 1024:
            raise JobError(f"The description of walk {wid} is too large to read.")
        walk = json.loads(path.read_text("utf-8"))
    except FileNotFoundError:
        raise JobError(f"The walk {wid} was not found in this project.") from None
    except (OSError, ValueError) as e:
        raise JobError(f"The description of walk {wid} could not be read: {e}") from e
    src = walk.get("source") if isinstance(walk, dict) else None
    if (
        not isinstance(src, dict)
        or not isinstance(src.get("file"), str)
        or src.get("layout") not in ff.LAYOUTS
        or walk.get("id") != wid
    ):
        raise JobError(f"The description of walk {wid} is not a walk this version reads.")
    return walk


def _lens_doc(lens: Lens) -> dict[str, float]:
    return {
        "cx": round(lens.cx, 3),
        "cy": round(lens.cy, 3),
        "radius": round(lens.radius, 3),
        "fovDeg": round(lens.fov_deg, 3),
        "yawDeg": round(lens.yaw_deg, 4),
        "pitchDeg": round(lens.pitch_deg, 4),
        "rollDeg": round(lens.roll_deg, 4),
    }


def _lens_from(d: dict[str, float]) -> Lens:
    return Lens(d["cx"], d["cy"], d["radius"], d["fovDeg"], d["yawDeg"], d["pitchDeg"], d["rollDeg"])


def _pycolmap_version() -> str | None:
    try:
        return pkg_version("pycolmap")[:40]
    except PackageNotFoundError:
        return None


class WalkProcess:
    name = "walk.process"
    title = "Process 360 walk"
    description = (
        "Levelled playback copy, camera orientation, path from the video, sparse points and map stills "
        "for a 360 walk."
    )
    keys = frozenset({"walk", "src", "stillsPerS", "maskBottom", "strideM", "stabilize", "sfm", "chunk"})
    required = frozenset({"walk"})

    # --- parameters (WalkProcessParams in packages/schema/src/jobs.ts) ---------------------------

    def validate(self, params: dict[str, Any]) -> dict[str, Any]:
        known_keys(params, set(self.keys), self.name)
        missing = sorted(k for k in self.required if params.get(k) is None)
        if missing:
            raise JobError(f"{self.name} needs: {', '.join(missing)}.")
        wid = params["walk"]
        if not isinstance(wid, str) or not 1 <= len(wid) <= 80 or not WALK_ID.match(wid):
            raise JobError("walk must be a walk id: lower-case letters, digits and dashes, at most 80.")
        src = params.get("src")
        if src is not None:
            if not isinstance(src, list) or not 1 <= len(src) <= MAX_SRC:
                raise JobError(f"src must be a list of 1 to {MAX_SRC} file paths.")
            for p in src:
                if not isinstance(p, str) or not 1 <= len(p) <= MAX_PATH:
                    raise JobError(f"src must hold file paths of 1 to {MAX_PATH} characters.")
                if not os.path.isabs(p):
                    raise JobError(f"src must hold absolute paths: {p}")
        number(params, "stillsPerS", lo=0.5, hi=4)
        number(params, "maskBottom", lo=0, hi=0.5)
        number(params, "strideM", lo=0.3, hi=1.5)
        number(params, "chunk", lo=50, hi=2000, integer=True)
        for key in ("stabilize", "sfm"):
            if params.get(key) is not None and not isinstance(params[key], bool):
                raise JobError(f"{key} must be true or false.")
        return dict(params)

    def inputs(self, params: dict[str, Any]) -> list[str]:
        wid = params["walk"]
        return [f"walks/{wid}/walk.json", f"walks/{wid}/playback.mp4", *(params.get("src") or [])]

    def plan(self, params: dict[str, Any]) -> list[Step]:
        opt = {k: (params[k] if params.get(k) is not None else v) for k, v in DEFAULTS.items()}
        wid: str = params["walk"]
        rel = f"walks/{wid}"
        src: list[str] | None = params.get("src")

        # --- read ---------------------------------------------------------------------------------
        def read(ctx: StepContext) -> dict[str, Any]:
            t0 = time.monotonic()
            folder = ctx.out(rel)
            walk = _load_walk(folder / "walk.json", wid)
            exe = ff.find_ffmpeg()
            if exe is None:
                raise JobError(ff.FFMPEG_MISSING)
            warnings: list[str] = []
            if src:
                check_src(src, walk["source"])
                files = [str(Path(p)) for p in src]
                layout = walk["source"]["layout"]
            else:
                playback = folder / "playback.mp4"
                if not playback.is_file():
                    raise JobError(f"The playback copy of walk {wid} is missing; import the video again.")
                files = [str(playback)]
                layout = "equirect"
            try:
                infos = [ff.probe(f) for f in files]
            except RuntimeError as e:
                raise JobError(f"ffmpeg could not read the walk's video: {e}") from e
            info = infos[0]
            src_fps = float(info.get("fps") or (walk.get("video") or {}).get("fps") or 30.0)
            fps = output_fps(src_fps, src_fps)
            duration = sum(float(i.get("duration") or 0.0) for i in infos)
            if duration <= 0:
                duration = float((walk.get("video") or {}).get("durationS") or 0.0)
            if duration <= 0:
                raise JobError("The walk's video has no length ffmpeg can read.")
            w, h = int(info.get("width") or 0), int(info.get("height") or 0)
            if w <= 0 or h <= 0:
                raise JobError("The walk's video has no picture stream ffmpeg can read.")

            lenses: tuple[Lens, Lens] | None = None
            calibration = "none"
            camera = None
            imu = None
            if layout != "equirect":
                tr = read_trailer(files[0])
                if tr is None and len(files) > 1:
                    tr = read_trailer(files[-1])
                if tr is None:
                    warnings.append(
                        "The original has no camera trailer: the default lens is used, "
                        "and without motion data there is no levelled copy."
                    )
                else:
                    warnings.extend(tr.warnings)
                    camera = tr.camera
                    imu = tr.imu
                lens_w, lens_h = (w // 2, h) if layout == "dual-fisheye" else (w, h)
                if tr is not None and tr.offset:
                    lenses = parse_offset(tr.offset, lens_w, lens_h, tr.window_crop)
                if lenses is not None:
                    calibration = "trailer"
                else:
                    if tr is not None and tr.offset:
                        warnings.append("The lens calibration could not be read: the default lens is used.")
                    lenses = default_lenses(lens_w, lens_h)
                    calibration = "default"
            if imu is not None and len(imu.t) < MIN_IMU_SAMPLES:
                warnings.append("Too few motion samples to use: no levelled copy.")
                imu = None

            out_w, out_h = (
                output_size(lenses[0]) if lenses else (min(MAX_WIDTH, w) // 2 * 2, min(MAX_WIDTH, w) // 4 * 2)
            )
            count = math.ceil(duration * fps - 1e-6) + 1
            standing: list[list[float]] = []
            has_imu = imu is not None
            if imu is not None:
                stretches = motion.standing_stretches(imu.t, imu.acc)
                standing = [[round(a, 4), round(b, 4)] for a, b in stretches]
                bias = motion.gyro_bias(imu.t, imu.gyro, stretches)
                q = motion.orientation(imu.t, imu.acc, imu.gyro - bias, np.arange(count) / fps)
                steps = motion.step_times(imu.t, imu.acc)
                np.savez(ctx.stage("read/motion.npz"), q=q, steps=steps)
                motion.write_rows(
                    ctx.stage("out/imu.bin"), motion.decimate(imu.t, imu.acc, imu.gyro, outputs.IMU_RATE_HZ)
                )
            levelled = has_imu and bool(opt["stabilize"]) and layout != "equirect"

            # Disk: the levelled copy at its rate cap, the SfM stills and the map stills.
            n_stills = math.ceil(duration * float(opt["stillsPerS"])) + 1
            sw, sh = stills.sfm_size(out_w, out_h)
            needed = int(
                (duration * 16e6 / 8 if levelled else 0)
                + n_stills * sw * sh * 0.5
                + (duration + 1) * out_w * out_h * 0.5
                + 64e6
            )
            check_disk(ctx.staging, needed)
            ctx.progress(1.0)
            return {
                "files": files,
                "layout": layout,
                "inputFile": Path(src[0]).name if src else None,
                "calibration": calibration,
                "lenses": [_lens_doc(x) for x in lenses] if lenses else None,
                "imu": has_imu,
                "camera": camera,
                "fps": fps,
                "durationS": duration,
                "width": out_w,
                "height": out_h,
                "standing": standing,
                "levelled": levelled,
                "ffmpeg": ff.version(exe)[:80],
                "warnings": warnings,
                "seconds": round(time.monotonic() - t0, 3),
            }

        # --- frames -------------------------------------------------------------------------------
        def frames(ctx: StepContext) -> dict[str, Any]:
            t0 = time.monotonic()
            r = ctx.outputs("read")
            fps = float(r["fps"])
            q = steps = None
            if r["imu"]:
                with np.load(ctx.stage("read/motion.npz")) as z:
                    q, steps = z["q"], z["steps"]
            times = stills.pick_sfm_times(r["durationS"], float(opt["stillsPerS"]), r["standing"])
            frame_ids = sorted({round(t * fps) for t in times})
            steps_at = stills.steps_counter(steps) if steps is not None else None
            picked = stills.pick_map_stills([n / fps for n in frame_ids], steps_at, float(opt["strideM"]))
            sfm_dir, map_dir = ctx.stage("sfm/stills"), ctx.stage("out/stills")
            for d in (sfm_dir, map_dir):
                shutil.rmtree(d, ignore_errors=True)
            out_w, out_h = int(r["width"]), int(r["height"])
            sfm_saver = stills.StillSaver(
                sfm_dir,
                {n: stills.still_name(k) for k, n in enumerate(frame_ids)},
                stills.SFM_QUALITY,
                stills.sfm_size(out_w, out_h),
            )
            map_saver = stills.StillSaver(
                map_dir, {frame_ids[i]: stills.map_name(frame_ids[i]) for i in picked}, stills.MAP_QUALITY
            )
            rotations = None
            if r["levelled"] and q is not None:
                ls = motion.level_rotation(q)
                rotations = lambda t: ls[min(len(ls) - 1, round(t * fps))]  # noqa: E731
            lenses = tuple(_lens_from(x) for x in r["lenses"]) if r["lenses"] else None
            out_mp4 = ctx.stage("out/stabilized.mp4") if rotations is not None else None
            res = run_frames(
                r["files"],
                r["layout"],
                lenses,
                fps,
                rotations,
                out_mp4,
                [FrameSink(sfm_saver), FrameSink(map_saver)],
                ctx.check,
                ctx.progress,
                out_size=(out_w, out_h),
            )
            saved = sorted(sfm_saver.saved.items())
            return {
                "stills": [[n, name] for n, name in saved],
                "map": sorted(n for n in map_saver.saved if n in sfm_saver.saved),
                "frames": res["frames"],
                "fps": res["fps"],
                "width": res["width"],
                "height": res["height"],
                "levelled": out_mp4 is not None,
                "warnings": res["warnings"],
                "timings": res["timings"],
                "seconds": round(time.monotonic() - t0, 3),
            }

        # --- sfm ----------------------------------------------------------------------------------
        def sfm(ctx: StepContext) -> dict[str, Any]:
            t0 = time.monotonic()
            r, f = ctx.outputs("read"), ctx.outputs("frames")
            found = f["stills"]
            warnings: list[str] = []
            out: dict[str, Any] = {"source": "pins-only", "registeredFraction": 0.0, "segments": 0}
            if not opt["sfm"]:
                pass
            elif len(found) < MIN_SFM_STILLS:
                warnings.append(TOO_SHORT)
            else:
                gravity = None
                if r["imu"]:
                    with np.load(ctx.stage("read/motion.npz")) as z:
                        q = z["q"]
                    rg = motion.quat_to_matrix(q)
                    ls = motion.level_rotation(q) if f["levelled"] else None
                    down = np.array([0.0, 0.0, -1.0])
                    gravity = []
                    for n, _ in found:
                        k = min(n, len(rg) - 1)
                        g = rg[k].T @ down  # gravity in the camera frame
                        gravity.append(ls[k] @ g if ls is not None else g)  # in the still's frame
                work = ctx.stage("sfm/work")
                shutil.rmtree(work, ignore_errors=True)
                try:
                    res = run_sfm(
                        [ctx.stage(f"sfm/stills/{name}") for _, name in found],
                        work,
                        mask_bottom=float(opt["maskBottom"]),
                        chunk=int(opt["chunk"]),
                        gravity=gravity,
                        check=ctx.check,
                        progress=ctx.progress,
                    )
                except Cancelled:
                    raise
                except Exception as e:  # SfM failing never fails the walk: pins carry the path
                    warnings.append(
                        f"The path could not be computed from the video ({e}); place the walk by pins."
                    )
                else:
                    out["registeredFraction"] = round(res.registered_fraction, 4)
                    if res.registered_fraction < MIN_REGISTERED:
                        warnings.append(
                            f"Only {res.registered_fraction:.0%} of the stills found their place, too few for a "
                            "path: place the walk by pins."
                        )
                    else:
                        poses = [
                            {"registered": p.registered, "pos": p.pos, "q": p.q, "segment": p.segment}
                            for p in res.poses
                        ]
                        atomic_write_json(ctx.stage("sfm/poses.json"), poses, indent=None)
                        write_ply(ctx.stage("out/sparse.ply"), res.points, res.colors)
                        out.update(source="sfm", segments=res.segments, up=res.up, sfmTimings=res.timings)
                        if res.segments > 1:
                            warnings.append(
                                f"The path is in {res.segments} pieces that did not join; each is placed on its own."
                            )
            out["warnings"] = warnings
            out["seconds"] = round(time.monotonic() - t0, 3)
            ctx.progress(1.0)
            return out

        # --- finish -------------------------------------------------------------------------------
        def finish(ctx: StepContext) -> dict[str, Any]:
            t0 = time.monotonic()
            r, f, s = ctx.outputs("read"), ctx.outputs("frames"), ctx.outputs("sfm")
            fps = float(f["fps"])
            nf = int(f["frames"])
            stage_out = ctx.stage("out/raw-path.json").parent
            warnings = [*r["warnings"], *f["warnings"], *s["warnings"]]

            rg = steps = ls = None
            if r["imu"]:
                with np.load(ctx.stage("read/motion.npz")) as z:
                    q, steps = z["q"][:nf], z["steps"]
                rg = motion.quat_to_matrix(q)
                if f["levelled"]:
                    ls = motion.level_rotation(q)
            steps_at = stills.steps_counter(steps) if steps is not None else (lambda t: 0.0)

            is_sfm = s["source"] == "sfm"
            poses = json.loads(ctx.stage("sfm/poses.json").read_text("utf-8")) if is_sfm else None
            rows: list[dict[str, Any]] = []
            pairs: tuple[list[np.ndarray], list[np.ndarray]] = ([], [])
            for k, (n, _) in enumerate(f["stills"]):
                t = n / fps
                row: dict[str, Any] = {"n": n, "t": t, "steps": steps_at(t)}
                p = poses[k] if poses is not None else None
                if p is not None and p["registered"]:
                    r_c = qvec_to_rotmat(p["q"])  # camera of the still image to the SfM frame
                    if ls is not None:
                        r_c = r_c @ ls[min(n, len(ls) - 1)]  # the still was levelled: back to the camera
                    row.update(pos=p["pos"], R=r_c, segment=p["segment"])
                    if rg is not None and p["segment"] == 0:
                        pairs[0].append(r_c)
                        pairs[1].append(rg[min(n, len(rg) - 1)])
                rows.append(row)

            # What this run writes follows from the steps' outputs (not from the staging folder, which
            # a resumed finish has partly moved already).
            written: dict[str, bool] = {
                "imu.bin": bool(r["imu"]),
                "sparse.ply": is_sfm,
                "stabilized.mp4": bool(f["levelled"]),
                "orientation.bin": False,
            }
            if rg is not None:
                to_raw = np.eye(3)
                if is_sfm and pairs[0]:
                    to_raw = outputs.gravity_to_raw(*pairs)
                if not is_sfm or pairs[0]:
                    outputs.write_orientation(stage_out, np.arange(len(rg)) / fps, to_raw @ rg, fps)
                    written["orientation.bin"] = True
                else:
                    warnings.append("No still of the main piece has motion data: no orientation records.")
            written["orientation.json"] = written["orientation.bin"]

            walking = None
            if steps is not None and len(steps) >= 2:
                walking = (float(steps[0]), float(steps[-1]))
            up = s.get("up") if is_sfm else None
            doc = outputs.raw_path_doc(
                wid,
                s["source"],
                rows,
                up=tuple(up) if up else None,
                walking=walking,
                kept=list(f["map"]),
            )
            atomic_write_json(stage_out / "raw-path.json", doc)
            written["raw-path.json"] = True

            # Move into place: the old record first out, the files, stale files out, the record last.
            dest = ctx.out(rel)
            old_record = dest / "process.json"
            if old_record.exists():
                old_record.unlink()
            map_names = {stills.map_name(n) for n in f["map"]}
            if map_names:
                commit_tree(ctx, "out/stills", f"{rel}/stills")
            commit_files(ctx, [(f"out/{name}", f"{rel}/{name}") for name in RUN_FILES if written.get(name)])
            for name in RUN_FILES:
                if not written.get(name) and (dest / name).exists():
                    (dest / name).unlink()
            old_stills = dest / "stills"
            if old_stills.is_dir():
                for p in old_stills.iterdir():
                    if p.is_file() and p.name not in map_names:
                        p.unlink()
                if not map_names and not any(old_stills.iterdir()):
                    old_stills.rmdir()

            out_paths = {OUTPUT_KEYS[name]: f"{rel}/{name}" for name in OUTPUT_KEYS if written.get(name)}
            if map_names:
                out_paths["stills"] = f"{rel}/stills"
            engine: dict[str, Any] = {"version": str(__version__)[:40]}
            if (pc := _pycolmap_version()) is not None:
                engine["pycolmap"] = pc
            if r.get("ffmpeg"):
                engine["ffmpeg"] = r["ffmpeg"]
            inp: dict[str, Any] = {}
            if r.get("inputFile"):
                inp["file"] = r["inputFile"]
            inp.update(layout=r["layout"], calibration=r["calibration"])
            if r.get("lenses"):
                inp["lenses"] = r["lenses"]
            inp["imu"] = bool(r["imu"])
            if r.get("camera"):
                inp["camera"] = str(r["camera"])[:80]
            record = {
                "schema": outputs.WALK_PROCESS_SCHEMA,
                "walk": wid,
                "createdAt": now_iso(),
                "engine": engine,
                "input": inp,
                "outputs": out_paths,
                "stabilize": {"levelled": bool(written["stabilized.mp4"]), "keptYaw": True},
                "stills": {"sfm": len(rows), "map": len(map_names)},
                "path": {
                    "source": s["source"],
                    "registeredFraction": float(s["registeredFraction"]),
                    "segments": int(s["segments"]),
                },
                "timings": {
                    "read": float(r["seconds"]),
                    "frames": float(f["seconds"]),
                    "sfm": float(s["seconds"]),
                    "finish": round(time.monotonic() - t0, 3),
                },
                "warnings": outputs.clean_warnings(warnings),
            }
            outputs.write_process(dest / "process.json", record)
            ctx.artifact(f"{rel}/process.json")
            return {"process": f"{rel}/process.json", "source": s["source"]}

        return [
            Step("read", "Read the walk", read, 0.05),
            Step("frames", "Level and pick stills", frames, 0.45),
            Step("sfm", "Find the path", sfm, 0.45),
            Step("finish", "Write the walk files", finish, 0.05),
        ]
