"""DJI Thermal SDK (TSDK 1.9, Windows only) through a thin ``ctypes`` binding.

The SDK applies the measurement settings itself (``dirp_set_measurement_params``), so a DJI
R-JPEG needs no physics of ours. Names and value ranges come from ``dirp_api.h`` of the TSDK
release. The XT2 is not on DJI's list and always takes the FLIR route.
"""

from __future__ import annotations

import ctypes
import math
import os
import re
import struct
from dataclasses import replace
from pathlib import Path

import numpy as np

from .physics import ThermalSettingsPy

# Sources: DJI Thermal SDK v1.9 (20260526; a superset of 1.7, which is no longer downloadable),
# ``tsdk-core/api/dirp_api.h`` and ``History.txt``: H20T, XTS (1.0), M2EA (1.1), H20N, M30T (1.3),
# M3TD (1.5), M4T (1.7), M5T (1.9); M3T and H30T have dataset folders in the SDK. The "Z" forms
# are the EXIF spelling of the Zenmuse models.
TSDK_MODELS: frozenset[str] = frozenset(
    {
        "H20T",
        "H20N",
        "H30T",
        "M30T",
        "M2EA",
        "M3T",
        "M3TD",
        "M4T",
        "M4TD",
        "M5T",
        "XTS",
        "ZH20T",
        "ZH20N",
        "ZH30T",
    }
)

# (min, max) per setting: the ranges ``dji_irp.exe -h`` of v1.9 prints for its measure action
# (the header comments no longer state them); ``ambient_temp`` is the air temperature.
TSDK_RANGES: dict[str, tuple[float, float]] = {
    "distance_m": (1.0, 25.0),
    "humidity_pct": (20.0, 100.0),
    "emissivity": (0.10, 1.00),
    "reflected_c": (-40.0, 500.0),
    "air_c": (-40.0, 80.0),
}
_PUBLIC_NAME = {
    "distance_m": "distanceM",
    "humidity_pct": "humidityPct",
    "emissivity": "emissivity",
    "reflected_c": "reflectedC",
    "air_c": "airC",
}


class TsdkError(RuntimeError):
    def __init__(self, code: int, where: str = ""):
        super().__init__(f"DJI Thermal SDK error {code}" + (f" in {where}" if where else ""))
        self.code = code


def clamp_for_tsdk(s: ThermalSettingsPy) -> tuple[ThermalSettingsPy, list[str]]:
    """The settings pulled into the SDK's ranges, and the camelCase names that were changed."""
    changes: dict[str, float] = {}
    names: list[str] = []
    for field, (lo, hi) in TSDK_RANGES.items():
        v = getattr(s, field)
        if v is None:
            continue
        if not math.isfinite(v):
            raise ValueError(f"{field} must be finite, got {v!r}")
        c = min(max(float(v), lo), hi)
        if c != v:
            changes[field] = c
            names.append(_PUBLIC_NAME[field])
    return (replace(s, **changes) if changes else s), names


# ``Model=`` must follow whitespace or a namespace colon, so ``CameraModel=`` never matches.
_MODEL_RE = re.compile(rb'(?<=[\s:])Model\s*=\s*"([^"]+)"|<[\w-]*:?Model>([^<]+)</', re.I)


def _exif_model(seg: bytes) -> str | None:
    """IFD0 Model (tag 0x0110) of an Exif APP1 payload, or None."""
    if not seg.startswith(b"Exif\x00\x00") or len(seg) < 14:
        return None
    t = seg[6:]
    end = "<" if t[:2] == b"II" else ">" if t[:2] == b"MM" else None
    if end is None:
        return None
    try:
        (ifd,) = struct.unpack(end + "I", t[4:8])
        (n,) = struct.unpack(end + "H", t[ifd : ifd + 2])
        for i in range(n):
            e = t[ifd + 2 + 12 * i : ifd + 14 + 12 * i]
            tag, typ, count = struct.unpack(end + "HHI", e[:8])
            if tag != 0x0110 or typ != 2:
                continue
            off = ifd + 2 + 12 * i + 8 if count <= 4 else struct.unpack(end + "I", e[8:12])[0]
            return t[off : off + count].split(b"\x00")[0].decode("ascii", "ignore").strip()
    except (struct.error, IndexError):
        return None
    return None


def is_dji_rjpeg(head: bytes) -> tuple[str, str] | None:
    """("DJI", model) when the head has DJI's thermal APP3 segments and a TSDK-listed model."""
    if head[:2] != b"\xff\xd8":
        return None
    pos, has_app3, xmp, exif = 2, False, b"", None
    while pos + 4 <= len(head) and head[pos] == 0xFF:
        marker = head[pos + 1]
        if marker in (0xDA, 0xD9):
            break
        (length,) = struct.unpack(">H", head[pos + 2 : pos + 4])
        if marker == 0xE3:
            has_app3 = True
        elif marker == 0xE1:
            seg = head[pos + 4 : pos + 2 + length]
            if exif is None:
                exif = _exif_model(seg)
            if seg.startswith(b"http://ns.adobe.com/xap/1.0/"):
                xmp += seg
        pos += 2 + length
    if not has_app3:
        return None
    m = _MODEL_RE.search(xmp) if b"drone-dji" in xmp else None
    if m:
        model = (m.group(1) or m.group(2)).decode("ascii", "ignore").strip().upper()
    elif exif:
        model = exif.upper()
    else:
        return None
    return ("DJI", model) if model in TSDK_MODELS else None


class _Resolution(ctypes.Structure):
    _fields_ = [("width", ctypes.c_int32), ("height", ctypes.c_int32)]


class _MeasurementParams(ctypes.Structure):
    _fields_ = [
        ("distance", ctypes.c_float),
        ("humidity", ctypes.c_float),
        ("emissivity", ctypes.c_float),
        ("reflection", ctypes.c_float),
        ("ambient_temp", ctypes.c_float),
    ]


_DLL_DIRS: list = []


def _load(dll_dir: Path):
    """Load libdirp from the SDK folder (``find_tool("dji_tsdk")``) and declare its entry points."""
    dll_dir = Path(dll_dir)
    # The handle is kept for the process lifetime on purpose: libdirp loads its libv_* sub
    # libraries lazily (on dirp_create), and they are only found while the folder stays registered.
    _DLL_DIRS.append(os.add_dll_directory(str(dll_dir)))
    lib = ctypes.CDLL(str(dll_dir / "libdirp.dll"))
    lib.dirp_create_from_rjpeg.argtypes = [
        ctypes.c_char_p,
        ctypes.c_int32,
        ctypes.POINTER(ctypes.c_void_p),
    ]
    lib.dirp_get_rjpeg_resolution.argtypes = [ctypes.c_void_p, ctypes.POINTER(_Resolution)]
    lib.dirp_set_measurement_params.argtypes = [
        ctypes.c_void_p,
        ctypes.POINTER(_MeasurementParams),
    ]
    lib.dirp_measure_ex.argtypes = [
        ctypes.c_void_p,
        ctypes.POINTER(ctypes.c_float),
        ctypes.c_int32,
    ]
    lib.dirp_destroy.argtypes = [ctypes.c_void_p]
    for name in (
        "dirp_create_from_rjpeg",
        "dirp_get_rjpeg_resolution",
        "dirp_set_measurement_params",
        "dirp_measure_ex",
        "dirp_destroy",
    ):
        getattr(lib, name).restype = ctypes.c_int32
    return lib


def _check(rc: int, where: str) -> None:
    if rc != 0:
        raise TsdkError(rc, where)


class Tsdk:
    def __init__(self, dll_dir: Path):
        self._lib = _load(dll_dir)

    def measure(self, path: Path, settings: ThermalSettingsPy) -> np.ndarray:
        """Per-pixel temperatures in deg C (float32, height x width) as the SDK computes them."""
        s, _ = clamp_for_tsdk(settings)
        data = Path(path).read_bytes()
        lib = self._lib
        h = ctypes.c_void_p()
        _check(
            lib.dirp_create_from_rjpeg(data, len(data), ctypes.pointer(h)),
            "dirp_create_from_rjpeg",
        )
        try:
            res = _Resolution()
            _check(lib.dirp_get_rjpeg_resolution(h, ctypes.pointer(res)), "resolution")
            if res.width <= 0 or res.height <= 0:
                raise TsdkError(-3, f"resolution {res.width}x{res.height}")
            params = _MeasurementParams(
                s.distance_m,
                s.humidity_pct,
                s.emissivity,
                s.air_c if s.reflected_c is None else s.reflected_c,
                s.air_c,
            )
            _check(lib.dirp_set_measurement_params(h, ctypes.pointer(params)), "params")
            out = np.zeros((res.height, res.width), dtype=np.float32)
            buf = out.ctypes.data_as(ctypes.POINTER(ctypes.c_float))
            _check(lib.dirp_measure_ex(h, buf, out.nbytes), "dirp_measure_ex")
            return out
        finally:
            lib.dirp_destroy(h)
