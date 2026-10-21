"""The FLIR decoder checked against ExifTool, once per camera model in a run (design departure 5).

The shipped decoder (``flir.py``) parses the FFF record itself, so the bundled ExifTool is the
known value it is held to: ``exiftool -b -RawThermalImage`` gives the raw image as the camera
stored it (a TIFF that ExifTool wraps around plain words, a TIFF, or a 16-bit PNG whose words FLIR
wrote byte-swapped) and ``exiftool -j -n`` the camera constants. The raw values must match exactly
and the constants to float32 precision. Images are read here with Pillow, never with the decoder's
own parsers, so the two paths stay independent.
"""

from __future__ import annotations

import contextlib
import io
import json
import math
import os
import subprocess
import tempfile
from pathlib import Path

import numpy as np

from .flir import FlirRecord

TIMEOUT_S = 60
#: Relative tolerance for constants: FLIR stores them as float32 and ExifTool prints them in full.
CONST_RTOL = 1e-6


class CrosscheckError(RuntimeError):
    """ExifTool could not be run or gave nothing usable."""


def _run(exe: str, args: list[str]) -> bytes:
    """ExifTool's standard output for ``args`` (the last is always the photo).

    The arguments go through a UTF-8 argument file (``-@``) with ``-charset filename=utf8``:
    on Windows a command line reaches ExifTool in the system code page, which mangles a project
    path with characters outside it.
    """
    fd, argfile = tempfile.mkstemp(prefix="aio-exiftool-", suffix=".args")
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as f:
            f.write("\n".join(["-charset", "filename=utf8", *args]) + "\n")
        return _exec([exe, "-@", argfile])
    finally:
        with contextlib.suppress(OSError):
            os.unlink(argfile)


def _exec(cmd: list[str]) -> bytes:
    try:
        p = subprocess.run(
            cmd,
            capture_output=True,
            timeout=TIMEOUT_S,
            stdin=subprocess.DEVNULL,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0) if os.name == "nt" else 0,
        )
    except (OSError, subprocess.TimeoutExpired) as e:
        raise CrosscheckError(f"ExifTool could not be run: {e}") from e
    if p.returncode != 0:
        msg = p.stderr.decode("utf-8", "replace").strip()[:200]
        raise CrosscheckError(
            f"ExifTool stopped with exit code {p.returncode}" + (f": {msg}" if msg else ".")
        )
    return p.stdout


def raw_image(blob: bytes) -> np.ndarray:
    """The raw words of ExifTool's ``RawThermalImage`` output as uint16 (height x width)."""
    from PIL import Image

    if not blob:
        raise CrosscheckError("ExifTool found no raw thermal image in the photo.")
    try:
        with Image.open(io.BytesIO(blob)) as img:
            fmt = img.format
            a = np.array(img)
    except Exception as e:  # Pillow raises many kinds for a damaged image
        raise CrosscheckError(f"ExifTool's raw thermal image could not be read: {e}") from e
    if a.ndim != 2:
        raise CrosscheckError("ExifTool's raw thermal image is not a single-channel image.")
    a = a.astype(np.uint16)
    if fmt == "PNG":
        a = a.byteswap()  # FLIR writes the PNG's 16-bit words byte-swapped
    return a


def _num(v: object) -> float | None:
    """ExifTool's ``-n`` value as a number; it quotes some floats (``"0.00656899996101856"``)."""
    try:
        f = float(v)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None
    return f if math.isfinite(f) else None


def constants_of(doc: dict) -> dict[str, float | None]:
    return {
        "R1": _num(doc.get("PlanckR1")),
        "R2": _num(doc.get("PlanckR2")),
        "B": _num(doc.get("PlanckB")),
        "F": _num(doc.get("PlanckF")),
        "O": _num(doc.get("PlanckO")),
        "Alpha1": _num(doc.get("AtmosphericTransAlpha1")),
        "Alpha2": _num(doc.get("AtmosphericTransAlpha2")),
        "Beta1": _num(doc.get("AtmosphericTransBeta1")),
        "Beta2": _num(doc.get("AtmosphericTransBeta2")),
        "X": _num(doc.get("AtmosphericTransX")),
    }


def record_constants(rec: FlirRecord) -> dict[str, float]:
    """The decoder's constants, by the names the raster sidecar records them under."""
    p, a = rec.planck, rec.atmos
    return {
        "R1": p.r1,
        "R2": p.r2,
        "B": p.b,
        "F": p.f,
        "O": p.o,
        "Alpha1": a.alpha1,
        "Alpha2": a.alpha2,
        "Beta1": a.beta1,
        "Beta2": a.beta2,
        "X": a.x,
    }


def check(exe: str, path: Path, rec: FlirRecord) -> str | None:
    """None when ExifTool reads the same raw image and constants as the decoder, else why not.

    Raises ``CrosscheckError`` when ExifTool cannot be run or read.
    """
    blob = _run(exe, ["-b", "-RawThermalImage", str(path)])
    theirs = raw_image(blob)
    if theirs.shape != rec.raw.shape:
        return (
            f"ExifTool reads a {theirs.shape[1]} x {theirs.shape[0]} raw image, the decoder "
            f"{rec.raw.shape[1]} x {rec.raw.shape[0]}."
        )
    diff = int(np.count_nonzero(theirs != rec.raw))
    if diff:
        return f"ExifTool reads different raw values in {diff} pixels."
    try:
        docs = json.loads(_run(exe, ["-j", "-n", str(path)]).decode("utf-8", "replace"))
        doc = docs[0] if isinstance(docs, list) and docs and isinstance(docs[0], dict) else None
    except ValueError as e:
        raise CrosscheckError(f"ExifTool's tag list could not be read: {e}") from e
    if doc is None:
        raise CrosscheckError("ExifTool gave no tags for the photo.")
    ours = record_constants(rec)
    for name, v in constants_of(doc).items():
        if v is None:
            return f"ExifTool reads no {name} constant."
        if not math.isclose(v, ours[name], rel_tol=CONST_RTOL, abs_tol=1e-12):
            return f"ExifTool reads the {name} constant as {v:g}, the decoder as {ours[name]:g}."
    return None
