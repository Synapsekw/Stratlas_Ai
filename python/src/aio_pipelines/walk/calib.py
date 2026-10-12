"""Per-lens fisheye calibration for a dual-lens 360 clip.

The Insta360 ``offset`` string (metadata field 5) reads, verified on an X4 clip::

    N _ (radius _ cx _ cy _ yaw _ pitch _ roll) * N _ sensor_w _ sensor_h [_ extra ...]

in sensor pixels, with the N lenses side by side across ``sensor_w`` (an X4: 2 lenses on a
16000 x 6000 sensor, each lens 8000 x 6000). The recorded lens stream is a centred window crop of
one lens (an X4: 5760 x 5760, metadata ``window_crop_info``) scaled down to the stream size (an
X4: 2880 x 2880). The angles are passed through as written (an X4 writes a roll near 90 degrees,
the sensor sits sideways in the body); ``walk.lens`` applies only the part past the nearest quarter turn, as the streams are already
upright.

The radius stands for a field of view of 193.5 degrees (``CALIBRATED_FOV_DEG``) under the
equidistant model, not the 195 degrees assumed without a calibration: fitted on an X4 clip's seam
(12 Oct 2026, SIFT matches between the lenses' overlap; a polynomial term did not improve it).
"""

from __future__ import annotations

import math
from dataclasses import dataclass

DEFAULT_FOV_DEG = 195.0
CALIBRATED_FOV_DEG = 193.5  # the field of view the offset string's radius stands for (X4, fitted)


@dataclass(frozen=True)
class Lens:
    """One fisheye lens in the pixels of its own lens image (one stream of a dual-stream clip,
    or one half of a side-by-side frame)."""

    cx: float
    cy: float
    radius: float  # pixels in the lens stream
    fov_deg: float  # full field of view
    yaw_deg: float = 0.0
    pitch_deg: float = 0.0
    roll_deg: float = 0.0


def default_lenses(width: int, height: int) -> tuple[Lens, Lens]:
    """Centred, 195 degrees, no rotation: what the import assumes without a calibration."""
    lens = Lens(cx=width / 2.0, cy=height / 2.0, radius=min(width, height) / 2.0, fov_deg=DEFAULT_FOV_DEG)
    return lens, lens


def parse_offset(
    text: str, width: int, height: int, crop: tuple[int, int] | None = None
) -> tuple[Lens, Lens] | None:
    """The two lenses of an ``offset`` string in the pixels of a ``width`` x ``height`` lens image.

    ``crop`` is the window crop (width, height) in sensor pixels the stream was cut from, centred
    on each lens (``Trailer.window_crop``). Without it the largest centred crop with the lens
    image's aspect is assumed. Answers None for anything that does not parse as two lenses.
    """
    if not isinstance(text, str) or width <= 0 or height <= 0:
        return None
    try:
        tokens = [float(tok) for tok in text.strip().split("_")]
    except ValueError:
        return None
    if not tokens or not all(math.isfinite(v) for v in tokens):
        return None
    n = tokens[0]
    if n != 2:
        return None
    if len(tokens) < 1 + 6 * 2 + 2:
        return None
    sensor_w, sensor_h = tokens[13], tokens[14]
    if sensor_w <= 0 or sensor_h <= 0:
        return None
    lens_w, lens_h = sensor_w / 2.0, sensor_h
    if crop is not None and crop[0] > 0 and crop[1] > 0:
        crop_w, crop_h = float(min(crop[0], lens_w)), float(min(crop[1], lens_h))
    else:
        aspect = width / height
        crop_w = min(lens_w, lens_h * aspect)
        crop_h = crop_w / aspect
    sx, sy = width / crop_w, height / crop_h
    x0, y0 = (lens_w - crop_w) / 2.0, (lens_h - crop_h) / 2.0
    lenses = []
    for i in range(2):
        radius, cx, cy, yaw, pitch, roll = tokens[1 + 6 * i : 7 + 6 * i]
        cx -= i * lens_w
        if radius <= 0 or not (0 <= cx <= lens_w) or not (0 <= cy <= lens_h):
            return None
        lenses.append(
            Lens(
                cx=(cx - x0) * sx,
                cy=(cy - y0) * sy,
                radius=radius * math.sqrt(sx * sy),
                fov_deg=CALIBRATED_FOV_DEG,
                yaw_deg=yaw,
                pitch_deg=pitch,
                roll_deg=roll,
            )
        )
    return lenses[0], lenses[1]
