"""One decode pass of a walk: stitch (and level) each frame, encode the playback copy, feed the sinks.

``run_frames`` runs one ffmpeg that decodes the source to raw ``bgr24`` frames on a pipe (the two
lens streams side by side, or the single frame), maps each frame to an equirect with ``cv2.remap``
(the dual fisheye map of ``lens.py``, cached when there is no per-frame rotation, else computed per
frame at ``1 / map_scale`` size and upsampled), blends the two lenses over the feathered seam,
writes the result to a second ffmpeg that encodes the playback copy, and hands every frame to the
sinks (the still pickers). Chapter files are decoded in turn into one output with continuous
times. On cancel (``check`` raising) both ffmpeg process trees are killed, like
``photo.native.run_tool``.
"""

from __future__ import annotations

import contextlib
import math
import subprocess
import tempfile
import time
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np

from ..photo.native import _kill_tree
from ..runtime import JobError
from . import ffmpeg as ff
from . import lens as lensmap
from .calib import Lens, default_lenses

MAX_FPS = 30.0
MAX_WIDTH = 3840


@dataclass
class FrameSink:
    """Called per output frame with its index ``i``, its time ``t`` (s from the first frame) and the
    stitched BGR frame (``(h, w, 3)`` uint8; the sink must copy it to keep it)."""

    on_frame: Callable[[int, float, np.ndarray], None]


def output_size(lens: Lens) -> tuple[int, int]:
    """Equirect size that keeps the lens's resolution at the picture centre (``2 pi f`` pixels
    round), a multiple of 32 wide, at most 3840 x 1920."""
    f = lens.radius / math.radians(lens.fov_deg / 2.0)
    w = round(2.0 * math.pi * f / 32.0) * 32
    w = max(64, min(MAX_WIDTH, w))
    return w, w // 2


def output_fps(fps: float, src_fps: float | None) -> float:
    """The output frame rate: the source's divided by a whole number (every k-th frame, no
    doubled frames), the highest such rate at or below ``fps`` (the source's when 0) and 30 fps.
    A 59.94 fps source at ``fps`` 30 gives 29.97."""
    target = min(fps if fps and fps > 0 else MAX_FPS, MAX_FPS)
    if not src_fps or src_fps <= 0:
        return target
    return src_fps / max(1, math.ceil(src_fps / target - 1e-6))


class Stitcher:
    """Maps one decoded frame to the output equirect, with an optional per-frame rotation."""

    def __init__(
        self,
        layout: str,
        lenses: tuple[Lens, Lens] | None,
        lens_size: int,
        out_w: int,
        out_h: int,
        map_scale: int = 4,
    ) -> None:
        self.layout = layout
        self.fisheye = layout != "equirect"
        self.lenses = lenses or default_lenses(lens_size, lens_size)
        self.lens_size = lens_size
        self.out_w, self.out_h = out_w, out_h
        self.map_scale = map_scale
        self._cached: tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray] | None = None

    def _blend(self, frame: np.ndarray, p0: np.ndarray, p1: np.ndarray, w0: np.ndarray, w1: np.ndarray):
        a = cv2.remap(frame, p0, None, cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT)
        b = cv2.remap(frame, p1, None, cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT)
        return cv2.blendLinear(a, b, w0, w1)

    def apply(self, frame: np.ndarray, rotation: np.ndarray | None = None) -> np.ndarray:
        if not self.fisheye:
            if frame.shape[1] != self.out_w or frame.shape[0] != self.out_h:
                frame = cv2.resize(frame, (self.out_w, self.out_h), interpolation=cv2.INTER_AREA)
            if rotation is None:
                return frame.copy()
            xy = lensmap.equirect_rotate_pairs(self.out_w, self.out_h, rotation, self.map_scale)
            return cv2.remap(frame, xy, None, cv2.INTER_LINEAR, borderMode=cv2.BORDER_WRAP)
        if rotation is None:
            if self._cached is None:
                self._cached = lensmap.stitch_maps(
                    self.lenses, self.lens_size, self.out_w, self.out_h, None, 1
                )
            return self._blend(frame, *self._cached)
        maps = lensmap.stitch_maps(
            self.lenses, self.lens_size, self.out_w, self.out_h, rotation, self.map_scale
        )
        return self._blend(frame, *maps)


def _frame_geometry(info: dict, layout: str) -> tuple[int, int, int]:
    """Decoded frame width, height and the lens size (0 for an equirect)."""
    video = [s for s in info["streams"] if s["type"] == "video" and s.get("width") and s.get("height")]
    if not video:
        raise JobError("The walk's video has no picture stream ffmpeg can read.")
    w, h = int(video[0]["width"]), int(video[0]["height"])
    if layout == "insv-dual-stream":
        if len(video) < 2:
            raise JobError("The walk's video has one picture stream; a dual-stream clip needs two.")
        return 2 * w, h, h
    if layout == "dual-fisheye":
        return w, h, h
    return w, h, 0


def _last_line(f) -> str:
    try:
        f.seek(0)
        lines = f.read().decode("utf-8", "replace").strip().splitlines()
    except (OSError, ValueError):
        return ""
    return lines[-1] if lines else ""


def _read_frame(stream, buf: bytearray) -> bool:
    view = memoryview(buf)
    got = 0
    while got < len(buf):
        n = stream.readinto(view[got:])
        if not n:
            return False
        got += n
    return True


def run_frames(
    src: list[str],
    layout: str,
    lenses: tuple[Lens, Lens] | None,
    fps: float,
    rotations: Callable[[float], np.ndarray] | None,
    out_mp4: Path | None,
    sinks: list[FrameSink],
    check: Callable[[], None],
    progress: Callable[[float], None],
    *,
    limit_s: float | None = None,
    out_size: tuple[int, int] | None = None,
    map_scale: int = 4,
) -> dict:
    """Decode ``src`` (one file, or chapter files of one clip in order), stitch and level each frame
    and feed ``out_mp4`` and ``sinks``. ``rotations(t)`` answers the ``(3, 3)`` levelling rotation
    (``motion.level_rotation``) at time ``t``; None keeps the camera's own orientation (one cached
    map). Returns ``frames``, ``fps``, ``width``, ``height``, ``duration_s``, ``warnings`` and
    ``timings`` (s)."""
    if not src:
        raise JobError("No source file to decode.")
    exe = ff.find_ffmpeg()
    if exe is None:
        raise JobError(ff.FFMPEG_MISSING)
    try:
        infos = [ff.probe(s) for s in src]
    except RuntimeError as e:
        raise JobError(f"ffmpeg could not read the walk's video: {e}") from e
    in_w, in_h, lens_size = _frame_geometry(infos[0], layout)
    out_fps = output_fps(fps, infos[0].get("fps"))
    src_fps = infos[0].get("fps") or out_fps
    dec_fps = out_fps if out_fps < src_fps * 0.999 else 0.0
    if out_size is not None:
        out_w, out_h = out_size
    elif lens_size:
        out_w, out_h = output_size((lenses or default_lenses(lens_size, lens_size))[0])
    else:
        out_w = min(MAX_WIDTH, in_w) // 2 * 2
        out_h = out_w // 2
    stitcher = Stitcher(layout, lenses, lens_size, out_w, out_h, map_scale)

    total_s = sum(float(i.get("duration") or 0.0) for i in infos)
    if limit_s is not None:
        total_s = min(total_s, limit_s) if total_s else limit_s
    expected = max(1, round(total_s * out_fps))

    audio = src[0] if len(src) == 1 and infos[0].get("audio") else None
    warnings: list[str] = []
    timings = {"decode": 0.0, "stitch": 0.0, "encode": 0.0, "sinks": 0.0}
    n = 0
    enc = dec = None
    buf = bytearray(in_w * in_h * 3)
    with tempfile.TemporaryFile() as enc_err, tempfile.TemporaryFile() as dec_err:
        try:
            if out_mp4 is not None:
                Path(out_mp4).parent.mkdir(parents=True, exist_ok=True)
                enc = subprocess.Popen(
                    [exe, *ff.encode_args(str(out_mp4), out_w, out_h, out_fps, audio)],
                    stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=enc_err, **ff.popen_kwargs(),
                )  # fmt: skip
            for path in src:
                left = None if limit_s is None else limit_s - n / out_fps
                if left is not None and left <= 0:
                    break
                check()
                dec_err.seek(0)
                dec_err.truncate()
                dec = subprocess.Popen(
                    [exe, *ff.decode_args(path, layout, dec_fps, left)],
                    stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=dec_err, **ff.popen_kwargs(),
                )  # fmt: skip
                got = 0
                while True:
                    check()
                    t0 = time.perf_counter()
                    if not _read_frame(dec.stdout, buf):
                        break
                    t1 = time.perf_counter()
                    frame = np.frombuffer(buf, dtype=np.uint8).reshape(in_h, in_w, 3)
                    t = n / out_fps
                    out = stitcher.apply(frame, rotations(t) if rotations is not None else None)
                    t2 = time.perf_counter()
                    if enc is not None:
                        try:
                            enc.stdin.write(memoryview(out).cast("B"))
                        except (BrokenPipeError, OSError) as e:
                            enc.wait()
                            raise JobError(
                                f"Encoding the levelled copy failed: {_last_line(enc_err) or e}"
                            ) from e
                    t3 = time.perf_counter()
                    for sink in sinks:
                        sink.on_frame(n, t, out)
                    t4 = time.perf_counter()
                    timings["decode"] += t1 - t0
                    timings["stitch"] += t2 - t1
                    timings["encode"] += t3 - t2
                    timings["sinks"] += t4 - t3
                    n += 1
                    got += 1
                    progress(min(1.0, n / expected))
                dec.stdout.close()
                code = dec.wait()
                if code != 0:
                    msg = _last_line(dec_err) or f"exit {code}"
                    if got == 0:
                        raise JobError(f"ffmpeg could not decode {Path(path).name}: {msg}")
                    warnings.append(f"Decoding {Path(path).name} stopped early: {msg}")
                dec = None
            if enc is not None:
                enc.stdin.close()
                while enc.poll() is None:
                    check()
                    time.sleep(0.05)
                if enc.returncode != 0:
                    raise JobError(
                        f"Encoding the levelled copy failed: {_last_line(enc_err) or enc.returncode}"
                    )
                enc = None
        except BaseException:
            for proc in (dec, enc):
                if proc is not None:
                    if proc.poll() is None:
                        _kill_tree(proc)
                    for pipe in (proc.stdin, proc.stdout):
                        if pipe is not None:
                            with contextlib.suppress(OSError):
                                pipe.close()
            raise
    if n == 0:
        raise JobError("The walk's video gave no frames.")
    progress(1.0)
    return {
        "frames": n,
        "fps": out_fps,
        "width": out_w,
        "height": out_h,
        "duration_s": n / out_fps,
        "warnings": warnings,
        "timings": {k: round(v, 3) for k, v in timings.items()},
    }
