"""Reading and writing the images of ``pano.stitch``.

Frames are read through ``np.fromfile`` + ``cv2.imdecode`` and written through ``cv2.imencode``,
never ``cv2.imread``/``cv2.imwrite``: those fail on Windows paths outside the ANSI code page.
Gimbal angles come from the DJI XMP packet, the 35 mm focal length and the exposure from EXIF.
"""

from __future__ import annotations

import math
import re
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

import cv2
import numpy as np
from PIL import Image

from .geometry import focal_px

#: Bytes of a frame searched for the XMP packet (it sits in the first segments).
HEAD_BYTES = 512 * 1024
JPEG_SUFFIXES = (".jpg", ".jpeg")
_EXIF_IFD = 0x8769
_FOCAL_35 = 0xA405
_EXPOSURE_TIME = 0x829A
_F_NUMBER = 0x829D
_ISO = 0x8827


class FrameError(Exception):
    """A frame that cannot be used; the message is the reason shown in ``stitch.json``."""


def _xmp_number(head: bytes, name: str) -> float | None:
    key = re.escape(name).encode()
    m = re.search(rb"drone-dji:" + key + rb'\s*=\s*"([^"]*)"|<drone-dji:' + key + rb">([^<]*)<", head)
    if not m:
        return None
    raw = (m.group(1) if m.group(1) is not None else m.group(2)).strip()
    try:
        return float(raw)
    except ValueError:
        return None


def read_gimbal(head: bytes) -> tuple[float, float, float] | None:
    """Gimbal yaw, pitch and roll from DJI XMP (roll 0 when absent), or None."""
    yaw = _xmp_number(head, "GimbalYawDegree")
    pitch = _xmp_number(head, "GimbalPitchDegree")
    if yaw is None or pitch is None:
        return None
    return yaw, pitch, _xmp_number(head, "GimbalRollDegree") or 0.0


@dataclass(frozen=True)
class FrameInfo:
    name: str
    width: int
    height: int
    focal35: float
    yaw: float
    pitch: float
    roll: float
    #: Exposure value at ISO 100 (log2 of N^2 / t * 100 / ISO); None when EXIF lacks it.
    ev: float | None = None

    @property
    def focal(self) -> float:
        return focal_px(self.focal35, self.width, self.height)

    def to_json(self) -> dict[str, Any]:
        return asdict(self)

    @staticmethod
    def from_json(d: dict[str, Any]) -> FrameInfo:
        return FrameInfo(**d)


def exposure_value(ifd: Any) -> float | None:
    """EV100 from an EXIF IFD, or None when the exposure time or f-number is missing or odd."""
    try:
        t = float(ifd.get(_EXPOSURE_TIME) or 0)
        n = float(ifd.get(_F_NUMBER) or 0)
        iso = ifd.get(_ISO) or 100
        iso = float(iso[0] if isinstance(iso, tuple | list) else iso)
    except (TypeError, ValueError, ZeroDivisionError):
        return None
    if t <= 0 or n <= 0 or iso <= 0:
        return None
    return round(math.log2(n * n / t * 100 / iso), 4)


def read_frame_info(path: Path) -> FrameInfo:
    try:
        with open(path, "rb") as fh:
            head = fh.read(HEAD_BYTES)
        with Image.open(path) as im:
            width, height = im.size
            ifd = im.getexif().get_ifd(_EXIF_IFD)
            focal35 = ifd.get(_FOCAL_35)
            ev = exposure_value(ifd)
    except (OSError, ValueError, SyntaxError) as e:
        raise FrameError("Could not be read") from e
    gimbal = read_gimbal(head)
    if gimbal is None:
        raise FrameError("No gimbal angles")
    if not focal35 or float(focal35) <= 0:
        raise FrameError("No 35 mm focal length")
    return FrameInfo(path.name, int(width), int(height), float(focal35), *gimbal, ev)


def list_frames(folder: Path) -> list[Path]:
    """The JPEGs of a frames folder, by name."""
    if not folder.is_dir():
        return []
    return sorted((p for p in folder.iterdir() if p.suffix.lower() in JPEG_SUFFIXES), key=lambda p: p.name)


def read_image(path: Path, scale: float = 1.0, gray: bool = False) -> np.ndarray:
    """Decode a JPEG (any path) and scale it with area averaging."""
    data = np.fromfile(str(path), dtype=np.uint8)
    flag = cv2.IMREAD_GRAYSCALE if gray else cv2.IMREAD_COLOR
    if scale <= 0.25:
        flag = cv2.IMREAD_REDUCED_GRAYSCALE_4 if gray else cv2.IMREAD_REDUCED_COLOR_4
    elif scale <= 0.5:
        flag = cv2.IMREAD_REDUCED_GRAYSCALE_2 if gray else cv2.IMREAD_REDUCED_COLOR_2
    img = cv2.imdecode(data, flag)
    if img is None:
        raise FrameError("Could not be read")
    with Image.open(path) as im:
        full_w, full_h = im.size
    size = (max(1, round(full_w * scale)), max(1, round(full_h * scale)))
    if (img.shape[1], img.shape[0]) != size:
        img = cv2.resize(img, size, interpolation=cv2.INTER_AREA)
    return img


def encode_jpeg(img: np.ndarray, quality: int) -> bytes:
    ok, buf = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, int(quality)])
    if not ok:
        raise FrameError("The image could not be encoded.")
    return buf.tobytes()
