"""Camera poses from drone photo metadata (EXIF GPS + DJI XMP gimbal angles), plus review copies.

Ported from Asset Inspection Kit ``kit/cameras.py``.

origin = the asset's base centre (WGS84) and the ground altitude in the same datum as the photo
altitudes. Model frame: X north, Y up (metres above the ground datum), Z east. Orientation:
GimbalYawDegree / GimbalPitchDegree / GimbalRollDegree from DJI XMP when present, else
FlightYawDegree, else EXIF GPSImgDirection, else the camera is aimed at the asset axis. The
target is the point on the view ray nearest the asset's vertical axis. FOV comes from
FocalLengthIn35mmFilm, else focal length + sensor width, else 70 degrees.
"""

from __future__ import annotations

import math
import re
from pathlib import Path
from typing import Any

from PIL import ExifTags, Image

GPS_TAGS = {v: k for k, v in ExifTags.GPSTAGS.items()}
PHOTO_EXT = re.compile(r"\.(jpe?g|tiff?|png)$", re.I)
XMP_KEYS = (
    "GimbalYawDegree",
    "GimbalPitchDegree",
    "GimbalRollDegree",
    "FlightYawDegree",
    "AbsoluteAltitude",
    "RelativeAltitude",
)


def _rat(v):
    try:
        return float(v)
    except TypeError:
        return v[0] / v[1]


def _dms(v, ref):
    d = _rat(v[0]) + _rat(v[1]) / 60 + _rat(v[2]) / 3600
    return -d if ref in ("S", "W") else d


def list_photos(folder: Path) -> list[Path]:
    """Photos under a folder, recursively, in a stable order (ids follow this order)."""
    return sorted(
        (p for p in folder.rglob("*") if p.is_file() and PHOTO_EXT.search(p.name)), key=lambda p: str(p)
    )


def read_meta(path) -> dict[str, Any]:
    with Image.open(path) as im:
        ex = im.getexif()
        out: dict[str, Any] = {"width": im.width, "height": im.height}
    sub = ex.get_ifd(0x8769)
    t = sub.get(36867) or ex.get(306)
    if t:
        out["time"] = str(t)
    fl = sub.get(37386)
    f35 = sub.get(41989)
    if fl:
        out["focal"] = _rat(fl)
    if f35:
        out["focal35"] = float(f35)
    g = ex.get_ifd(0x8825)
    if g:
        try:
            out["latitude"] = _dms(g[2], g.get(1, "N"))
            out["longitude"] = _dms(g[4], g.get(3, "E"))
            if 6 in g:
                out["altitude"] = _rat(g[6]) * (-1 if g.get(5) == 1 else 1)
            if 17 in g:
                out["img_direction"] = _rat(g[17])
        except (KeyError, ZeroDivisionError, TypeError, IndexError):
            pass
    with open(path, "rb") as f:
        raw = f.read(300000)
    m = re.search(rb"<x:xmpmeta.*?</x:xmpmeta>", raw, re.S)
    if m:
        x = m.group(0).decode("utf8", "ignore")
        for key in XMP_KEYS:
            mm = re.search(key + r'\s*=\s*"([+-]?[\d.]+)"', x) or re.search(
                "<[^>]*" + key + r">([+-]?[\d.]+)<", x
            )
            if mm:
                out[key] = float(mm.group(1))
    return out


def estimate_origin(metas: list[dict[str, Any]]) -> tuple[float, float, float]:
    """Mean photo position and the lowest photo altitude: a rough origin when none is given."""
    located = [m for m in metas if "latitude" in m]
    lat = sum(m["latitude"] for m in located) / len(located)
    lon = sum(m["longitude"] for m in located) / len(located)
    alts = [m.get("AbsoluteAltitude", m.get("altitude")) for m in located]
    alts = [a for a in alts if a is not None]
    return (lat, lon, min(alts) if alts else 0.0)


def pose(meta, origin, sensor_w=None, asset_height=None):
    lat0, lon0, alt0 = origin
    Re = 6378137.0
    x = math.radians(meta["latitude"] - lat0) * Re
    z = math.radians(meta["longitude"] - lon0) * Re * math.cos(math.radians(lat0))
    alt = meta.get("AbsoluteAltitude", meta.get("altitude", alt0))
    y = alt - alt0
    W, H = meta["width"], meta["height"]
    if meta.get("focal35"):
        hf = 2 * math.degrees(math.atan(36 / (2 * meta["focal35"])))
    elif meta.get("focal") and sensor_w:
        hf = 2 * math.degrees(math.atan(sensor_w / (2 * meta["focal"])))
    else:
        hf = 70.0
    vf = 2 * math.degrees(math.atan(math.tan(math.radians(hf / 2)) * H / W))
    yaw = meta.get("GimbalYawDegree", meta.get("FlightYawDegree", meta.get("img_direction")))
    pitch = meta.get("GimbalPitchDegree")
    P = [x, y, z]
    if yaw is None:  # aim at the asset axis at the camera height (clamped to the asset)
        ty = min(max(y, 0), asset_height or y)
        d = [-x, ty - y, -z]
    else:
        pr = math.radians(pitch if pitch is not None else 0)
        yr = math.radians(yaw)
        d = [math.cos(pr) * math.cos(yr), math.sin(pr), math.cos(pr) * math.sin(yr)]
    n = math.sqrt(sum(v * v for v in d)) or 1.0
    d = [v / n for v in d]
    hz = d[0] ** 2 + d[2] ** 2
    t = -(x * d[0] + z * d[2]) / hz if hz > 1e-6 else math.hypot(x, z) or 10
    if t <= 0:
        t = math.sqrt(x * x + z * z) or 10
    T = [P[i] + d[i] * t for i in range(3)]
    up = [0, 1, 0]
    roll = meta.get("GimbalRollDegree")
    if roll and abs(roll) > 0.5:  # rotate world-up about the view direction (Rodrigues)
        r = math.radians(roll)
        c, s = math.cos(r), math.sin(r)
        k = d
        v = up
        kv = sum(k[i] * v[i] for i in range(3))
        cr = [k[1] * v[2] - k[2] * v[1], k[2] * v[0] - k[0] * v[2], k[0] * v[1] - k[1] * v[0]]
        up = [v[i] * c + cr[i] * s + k[i] * kv * (1 - c) for i in range(3)]
    return {
        "position": [round(v, 4) for v in P],
        "target": [round(v, 4) for v in T],
        "up": [round(v, 5) for v in up],
        "hfov": round(hf, 4),
        "vfov": round(vf, 4),
    }


def orientation_source(meta) -> str:
    if "GimbalYawDegree" in meta:
        return "gimbal XMP"
    if "FlightYawDegree" in meta:
        return "flight yaw"
    if "img_direction" in meta:
        return "image direction"
    return "aimed at asset axis"


def camera_record(pid, src: Path, root: Path, meta, poses, file_rel: str, sequence: str) -> dict[str, Any]:
    return {
        "id": pid,
        "name": src.name,
        "source_name": src.relative_to(root).as_posix(),
        "file": file_rel,
        "sequence": sequence,
        "subject": "",
        "context": False,
        "latitude": meta["latitude"],
        "longitude": meta["longitude"],
        "altitude": meta.get("AbsoluteAltitude", meta.get("altitude")),
        "focal": meta.get("focal"),
        "width": meta["width"],
        "height": meta["height"],
        "time": meta.get("time"),
        **poses,
        "orientation_source": orientation_source(meta),
    }


def review_copy(src: Path, dest: Path, long_edge: int = 2560) -> tuple[int, int]:
    """Write a JPEG review copy with the long edge at most ``long_edge`` px (EXIF is not kept)."""
    with Image.open(src) as im:
        full = im.size
        target = min(1.0, long_edge / max(full))
        if target < 1 and im.format == "JPEG":
            # decode at a reduced scale first (DCT scaling), then resample exactly
            im.draft("RGB", (math.ceil(full[0] * target), math.ceil(full[1] * target)))
        rgb = im.convert("RGB")
    w, h = round(full[0] * target), round(full[1] * target)
    if (rgb.width, rgb.height) != (w, h):
        rgb = rgb.resize((w, h), Image.LANCZOS)
    rgb.save(dest, "JPEG", quality=86, optimize=True, progressive=True)
    return w, h
