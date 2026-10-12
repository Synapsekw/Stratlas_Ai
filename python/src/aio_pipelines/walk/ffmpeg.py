"""ffmpeg for walk.process: find it, probe a clip, and the decode and encode command lines.

ffmpeg ships in the pipeline pack at ``tools/ffmpeg/`` (conda-forge's build; decision 11) and is
found like the other native tools (``photo.native.find_tool``): ``QUADRION_FFMPEG``, then
``<pack>/tools/ffmpeg`` (``Library/bin`` where conda puts Windows binaries, then ``bin``), then the
PATH. Frames travel as raw ``bgr24`` on pipes: one decode process (the two lens streams of a
dual-stream clip side by side, or the single frame of the other layouts) and one encode process
for the playback copy's settings.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
from pathlib import Path

from ..photo import native

FFMPEG_MISSING = (
    "ffmpeg was not found: install pipeline pack 0.6.0 or newer, or set QUADRION_FFMPEG to an ffmpeg program."
)

KEYFRAME_S = 0.5
MAX_RATE = "16M"
BUF_SIZE = "32M"
LAYOUTS = ("insv-dual-stream", "dual-fisheye", "equirect")

_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)


def find_ffmpeg() -> str | None:
    """The ffmpeg program, or None (then fail with :data:`FFMPEG_MISSING`)."""
    return native.find_tool("ffmpeg")


def _num(text: str | None) -> float | None:
    if not text or text in ("N/A", "0/0"):
        return None
    try:
        if "/" in text:
            a, b = text.split("/", 1)
            return float(a) / float(b) if float(b) else None
        return float(text)
    except ValueError:
        return None


def _ffprobe(exe: str) -> str | None:
    p = Path(exe)
    cand = p.with_name("ffprobe" + p.suffix)
    return str(cand) if cand.is_file() else None


def _run(args: list[str], timeout: float = 60.0) -> subprocess.CompletedProcess:
    return subprocess.run(
        args, stdin=subprocess.DEVNULL, capture_output=True, timeout=timeout, creationflags=_NO_WINDOW
    )


def _probe_ffprobe(probe_exe: str, path: str) -> dict:
    res = _run([probe_exe, "-v", "error", "-show_streams", "-show_format", "-of", "json", path])
    if res.returncode != 0:
        lines = res.stderr.decode("utf-8", "replace").strip().splitlines()
        raise RuntimeError(lines[-1] if lines else f"ffprobe exit {res.returncode}")
    data = json.loads(res.stdout.decode("utf-8", "replace") or "{}")
    streams = []
    for st in data.get("streams", []):
        kind = st.get("codec_type")
        frames = st.get("nb_frames")
        streams.append(
            {
                "index": int(st.get("index", len(streams))),
                "type": kind,
                "codec": st.get("codec_name"),
                "width": st.get("width"),
                "height": st.get("height"),
                "fps": _num(st.get("avg_frame_rate")) or _num(st.get("r_frame_rate"))
                if kind == "video"
                else None,
                "frames": int(frames) if frames and str(frames).isdigit() else None,
                "duration": _num(st.get("duration")),
            }
        )
    return {"duration": _num(data.get("format", {}).get("duration")), "streams": streams}


_STREAM = re.compile(r"Stream #\d+:(\d+)[^:]*: (Video|Audio|Data|Subtitle): (\w+)(.*)")
_DURATION = re.compile(r"Duration: (\d+):(\d+):(\d+(?:\.\d+)?)")


def _probe_ffmpeg(exe: str, path: str) -> dict:
    res = _run([exe, "-hide_banner", "-nostdin", "-i", path])
    text = res.stderr.decode("utf-8", "replace")
    if "No such file" in text or "Invalid data" in text:
        lines = text.strip().splitlines()
        raise RuntimeError(lines[-1] if lines else "ffmpeg could not read the file")
    m = _DURATION.search(text)
    duration = int(m.group(1)) * 3600 + int(m.group(2)) * 60 + float(m.group(3)) if m else None
    streams = []
    for sm in _STREAM.finditer(text):
        kind, rest = sm.group(2).lower(), sm.group(4)
        size = re.search(r"(\d{2,5})x(\d{2,5})", rest) if kind == "video" else None
        fps = re.search(r"([\d.]+) fps", rest) if kind == "video" else None
        streams.append(
            {
                "index": int(sm.group(1)),
                "type": kind,
                "codec": sm.group(3),
                "width": int(size.group(1)) if size else None,
                "height": int(size.group(2)) if size else None,
                "fps": float(fps.group(1)) if fps else None,
                "frames": None,
                "duration": duration,
            }
        )
    return {"duration": duration, "streams": streams}


def probe(path: str) -> dict:
    """``streams`` (``index``, ``type`` video/audio/..., ``codec``, ``width``, ``height``, ``fps``,
    ``frames``, ``duration``), ``duration`` (s), and for the first video stream ``fps``, ``frames``,
    ``width``, ``height``; ``video_streams`` and ``audio`` (bool). Uses ffprobe beside ffmpeg, or
    parses ``ffmpeg -i``. Raises RuntimeError when ffmpeg is missing or cannot read the file."""
    exe = find_ffmpeg()
    if exe is None:
        raise RuntimeError(FFMPEG_MISSING)
    probe_exe = _ffprobe(exe)
    info = _probe_ffprobe(probe_exe, path) if probe_exe else _probe_ffmpeg(exe, path)
    video = [s for s in info["streams"] if s["type"] == "video"]
    first = video[0] if video else {}
    info.update(
        fps=first.get("fps"),
        frames=first.get("frames"),
        width=first.get("width"),
        height=first.get("height"),
        video_streams=len(video),
        audio=any(s["type"] == "audio" for s in info["streams"]),
    )
    if info["duration"] is None and first.get("duration"):
        info["duration"] = first["duration"]
    return info


def _fmt(x: float) -> str:
    return f"{x:.6f}".rstrip("0").rstrip(".")


def decode_args(src: str, layout: str, fps: float, limit_s: float | None) -> list[str]:
    """ffmpeg arguments (without the program) that decode ``src`` at ``fps`` to raw ``bgr24``
    frames on stdout: the two lens streams side by side (lens 0 left) for ``insv-dual-stream``,
    the single frame otherwise. ``limit_s`` stops after that many seconds of the source."""
    if layout not in LAYOUTS:
        raise ValueError(f"unknown walk layout {layout!r}")
    args = ["-hide_banner", "-loglevel", "error", "-nostdin"]
    if limit_s is not None and limit_s > 0:
        args += ["-t", _fmt(limit_s)]
    args += ["-i", src]
    rate = f"fps={_fmt(fps)}" if fps and fps > 0 else "null"
    if layout == "insv-dual-stream":
        graph = f"[0:v:0]{rate}[l];[0:v:1]{rate}[r];[l][r]hstack=inputs=2,format=bgr24[v]"
        args += ["-filter_complex", graph, "-map", "[v]"]
    else:
        args += ["-map", "0:v:0", "-vf", f"{rate},format=bgr24"]
    args += ["-an", "-sn", "-dn", "-f", "rawvideo", "-pix_fmt", "bgr24", "pipe:1"]
    return args


def encode_args(out: str, w: int, h: int, fps: float, audio_src: str | None) -> list[str]:
    """ffmpeg arguments (without the program) that encode raw ``bgr24`` frames from stdin to the
    playback copy: H.264 (libx264, veryfast, CRF 23 capped at 16 Mbit/s), yuv420p, a keyframe every
    0.5 s, moov first (faststart). With ``audio_src`` its first audio stream (if any) becomes AAC
    stereo, padded or cut to the video's length."""
    gop = str(max(1, round(fps * KEYFRAME_S)))
    args = ["-hide_banner", "-loglevel", "error", "-nostdin", "-y"]
    args += ["-f", "rawvideo", "-pix_fmt", "bgr24", "-s", f"{w}x{h}", "-r", _fmt(fps), "-i", "pipe:0"]
    if audio_src:
        args += ["-i", audio_src, "-map", "0:v:0", "-map", "1:a:0?"]
    args += [
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
        "-maxrate", MAX_RATE, "-bufsize", BUF_SIZE,
        "-pix_fmt", "yuv420p", "-g", gop, "-keyint_min", gop, "-sc_threshold", "0",
    ]  # fmt: skip
    if audio_src:
        args += ["-c:a", "aac", "-ac", "2", "-b:a", "128k", "-af", "apad", "-shortest"]
    args += ["-movflags", "+faststart", out]
    return args


def version(exe: str) -> str:
    """The version ffmpeg reports (``ffmpeg -version``), or ``unknown``."""
    try:
        res = _run([exe, "-hide_banner", "-version"], timeout=30.0)
    except (OSError, subprocess.SubprocessError):
        return "unknown"
    first = res.stdout.decode("utf-8", "replace").strip().splitlines()
    m = re.match(r"\S+ version (\S+)", first[0]) if first else None
    return m.group(1) if m else "unknown"


def popen_kwargs() -> dict:
    """No console window on Windows; a new process group elsewhere (for the tree kill)."""
    return {"creationflags": _NO_WINDOW} if os.name == "nt" else {"start_new_session": True}
