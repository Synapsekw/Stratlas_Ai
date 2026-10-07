"""Photo metadata for photogrammetry: EXIF, DJI XMP (GPS, altitudes, gimbal, RTK) and a quick look.

Builds on ``aik/cameras.py`` ``read_meta`` (the one EXIF and XMP reader of the pack) and adds what
alignment needs: camera make and model, RTK flag and standard deviations, the panorama marker, a
decode check, a blur measure and a small perceptual hash. Photos are opened read only.

RTK (as DJI RTK aircraft write it, XMP ``drone-dji``): ``RtkFlag`` 50 is a fixed solution, 34 to
49 a float one, 16 a single-point one and 0 none; ``RtkStdLon``, ``RtkStdLat`` and ``RtkStdHgt``
are one-sigma metres. A PPK CSV (``image, lat, lon, h, sh, sv``) replaces the EXIF positions.
"""

from __future__ import annotations

import csv
import hashlib
import io
import math
import re
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import numpy as np
from PIL import Image

from ..aik.cameras import PHOTO_EXT, read_meta
from ..runtime import JobError

XMP_EXTRA = ("RtkFlag", "RtkStdLon", "RtkStdLat", "RtkStdHgt", "GPSXYAccuracy", "GPSZAccuracy")
XMP_TEXT = ("Make", "Model", "ProjectionType")

#: One-sigma GNSS accuracy (horizontal, vertical metres) by solution kind when the photo says nothing.
GNSS_SIGMA = {"fixed": (0.03, 0.05), "float": (0.5, 0.8), "standard": (2.5, 5.0)}
#: Below this share of the median Laplacian variance a photo is called blurred (warning only).
BLUR_RATIO = 0.25
PANORAMA_ASPECT = 1.9


@dataclass
class PhotoMeta:
    """What one photo says about itself. ``key`` is unique within a run (folder index plus path)."""

    key: str
    path: Path
    width: int = 0
    height: int = 0
    make: str | None = None
    model: str | None = None
    focal_mm: float | None = None
    focal35: float | None = None
    time: str | None = None
    lon: float | None = None
    lat: float | None = None
    gps_alt: float | None = None
    abs_alt: float | None = None
    rel_alt: float | None = None
    yaw: float | None = None
    pitch: float | None = None
    roll: float | None = None
    rtk_flag: int | None = None
    rtk_std: tuple[float, float, float] | None = None
    panorama: bool = False
    blur: float | None = None
    dhash: int | None = None
    sha1: str | None = None
    error: str | None = None
    ppk: bool = False
    extra: dict[str, Any] = field(default_factory=dict)

    @property
    def has_gps(self) -> bool:
        return self.lat is not None and self.lon is not None

    @property
    def altitude(self) -> float | None:
        """The absolute altitude (XMP ``AbsoluteAltitude``, else EXIF ``GPSAltitude``)."""
        return self.abs_alt if self.abs_alt is not None else self.gps_alt

    def gnss_kind(self) -> str:
        """``fixed``, ``float`` or ``standard`` from the RTK flag (``standard`` when there is none)."""
        if self.ppk:
            return "fixed"
        f = self.rtk_flag
        if f is None:
            return "standard"
        if f >= 50:
            return "fixed"
        if f >= 34:
            return "float"
        return "standard"

    def gnss_sigma(self, mode: str = "auto") -> tuple[float, float] | None:
        """One-sigma horizontal and vertical accuracy of the position prior, or None to ignore it."""
        if mode == "ignore" or not self.has_gps:
            return None
        if mode == "rtk":
            return GNSS_SIGMA["fixed"]
        if mode == "standard":
            return GNSS_SIGMA["standard"]
        kind = self.gnss_kind()
        if self.rtk_std and kind != "standard":
            sx, sy, sz = self.rtk_std
            return (max(math.hypot(sx, sy) / math.sqrt(2), 0.005), max(sz, 0.01))
        h = self.extra.get("GPSXYAccuracy")
        v = self.extra.get("GPSZAccuracy")
        if h and v and kind == "standard":
            return (float(h), float(v))
        return GNSS_SIGMA[kind]

    def camera_key(self) -> tuple:
        """Photos with the same key share one calibration (one body and lens at one image size)."""
        f = round(self.focal_mm, 2) if self.focal_mm else (round(self.focal35, 1) if self.focal35 else None)
        return (self.make or "", self.model or "", self.width, self.height, f)


def list_folder_photos(folders: list[Path]) -> list[tuple[str, Path]]:
    """``(key, path)`` for every photo under the folders, keyed by folder and relative path.

    One flight is often split over camera folders whose file names repeat (``100MEDIA/DJI_0001``
    and ``101MEDIA/DJI_0001``), so a key is never a bare file name. With one folder the key is the
    path relative to it; with several, the folder's own name comes first (its index when two
    folders share a name).
    """
    names = [f.name or f"folder{i}" for i, f in enumerate(folders)]
    dup = {n for n, c in Counter(names).items() if c > 1}
    out: list[tuple[str, Path]] = []
    for i, folder in enumerate(folders):
        if not folder.is_dir():
            raise JobError(f'The photo folder "{folder}" does not exist.')
        prefix = "" if len(folders) == 1 else (f"{i}-{names[i]}/" if names[i] in dup else f"{names[i]}/")
        for p in sorted((p for p in folder.rglob("*") if p.is_file() and PHOTO_EXT.search(p.name)), key=str):
            if p.name.startswith("."):
                continue
            out.append((prefix + p.relative_to(folder).as_posix(), p))
    return out


def _xmp(raw: bytes) -> str | None:
    m = re.search(rb"<x:xmpmeta.*?</x:xmpmeta>", raw, re.S)
    return m.group(0).decode("utf8", "ignore") if m else None


def _xmp_number(x: str, key: str) -> float | None:
    m = re.search(r"[:\s]" + key + r'\s*=\s*"([+-]?[\d.eE+-]+)"', x) or re.search(
        r"<[^>]*:" + key + r">\s*([+-]?[\d.eE+-]+)\s*<", x
    )
    if not m:
        return None
    try:
        return float(m.group(1))
    except ValueError:
        return None


def _xmp_text(x: str, key: str) -> str | None:
    m = re.search(r"[:\s]" + key + r'\s*=\s*"([^"]{1,200})"', x) or re.search(
        r"<[^>]*:" + key + r">([^<]{1,200})<", x
    )
    return m.group(1).strip() if m else None


def _laplacian_variance(gray: np.ndarray) -> float:
    g = gray.astype(np.float32)
    lap = g[1:-1, 2:] + g[1:-1, :-2] + g[2:, 1:-1] + g[:-2, 1:-1] - 4 * g[1:-1, 1:-1]
    return float(lap.var())


def _dhash(gray: Image.Image) -> int:
    small = np.asarray(gray.resize((9, 8), Image.BILINEAR), dtype=np.int16)
    bits = (small[:, 1:] > small[:, :-1]).ravel()
    return int("".join("1" if b else "0" for b in bits), 2)


def read_photo(key: str, path: Path, look: bool = True) -> PhotoMeta:
    """Read one photo's metadata; with ``look``, decode a small version (corruption, blur, hash).

    Never raises for a bad photo: ``error`` says what is wrong ("cannot be read", "has no size").
    """
    meta = PhotoMeta(key=key, path=path)
    try:
        base = read_meta(path)
    except Exception as e:  # PIL raises many kinds for broken files
        meta.error = f"cannot be read ({type(e).__name__})"
        return meta
    meta.width, meta.height = int(base.get("width") or 0), int(base.get("height") or 0)
    meta.focal_mm = base.get("focal")
    meta.focal35 = base.get("focal35")
    meta.time = base.get("time")
    meta.lat, meta.lon = base.get("latitude"), base.get("longitude")
    if meta.lat is not None and not (-90 <= meta.lat <= 90 and -180 <= (meta.lon or 0) <= 180):
        meta.lat = meta.lon = None
    if meta.lat == 0 and meta.lon == 0:  # an empty GPS block, not a photo in the Gulf of Guinea
        meta.lat = meta.lon = None
    meta.gps_alt = base.get("altitude")
    meta.abs_alt = base.get("AbsoluteAltitude")
    meta.rel_alt = base.get("RelativeAltitude")
    meta.yaw = base.get("GimbalYawDegree", base.get("FlightYawDegree"))
    meta.pitch = base.get("GimbalPitchDegree")
    meta.roll = base.get("GimbalRollDegree")
    try:
        with open(path, "rb") as f:
            head = f.read(300_000)
        with Image.open(io.BytesIO(head)) as im:
            ex = im.getexif()
            make, model = ex.get(271), ex.get(272)
            meta.make = str(make).strip("\x00 ").strip() or None if make else None
            meta.model = str(model).strip("\x00 ").strip() or None if model else None
    except Exception:
        head = b""
    x = _xmp(head) if head else None
    if x:
        for k in XMP_EXTRA:
            v = _xmp_number(x, k)
            if v is not None:
                meta.extra[k] = v
        meta.make = meta.make or _xmp_text(x, "Make")
        meta.model = meta.model or _xmp_text(x, "Model")
        if (_xmp_text(x, "ProjectionType") or "").lower() == "equirectangular":
            meta.panorama = True
    if "RtkFlag" in meta.extra:
        meta.rtk_flag = int(meta.extra["RtkFlag"])
    stds = [meta.extra.get(k) for k in ("RtkStdLon", "RtkStdLat", "RtkStdHgt")]
    if all(s is not None and s > 0 for s in stds):
        meta.rtk_std = (float(stds[0]), float(stds[1]), float(stds[2]))  # type: ignore[arg-type]
    if meta.width <= 0 or meta.height <= 0:
        meta.error = "has no image size"
        return meta
    if max(meta.width, meta.height) / min(meta.width, meta.height) >= PANORAMA_ASPECT:
        meta.panorama = True
    if look:
        try:
            with Image.open(path) as im:
                im.draft("L", (max(64, im.width // 8), max(64, im.height // 8)))
                gray = im.convert("L")
                gray.load()
            meta.blur = _laplacian_variance(np.asarray(gray))
            meta.dhash = _dhash(gray)
        except Exception as e:
            meta.error = f"cannot be decoded ({type(e).__name__}: {str(e)[:80]})"
    return meta


def file_sha1(path: Path) -> str:
    h = hashlib.sha1()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


@dataclass
class Inspection:
    """The ``inspect`` stage's verdict: usable photos, rejected ones with reasons, warnings."""

    photos: list[PhotoMeta]
    rejected: list[dict[str, str]]
    warnings: list[str]


def inspect_photos(metas: list[PhotoMeta]) -> Inspection:
    """Reject what cannot be used and warn about what may hurt (plan: inspect).

    Rejected: unreadable or undecodable files, no image size, panoramas, byte-identical copies.
    Warned: photos without GPS, mixed cameras, likely motion blur, near duplicates.
    """
    rejected: list[dict[str, str]] = []
    warnings: list[str] = []
    ok: list[PhotoMeta] = []
    for m in metas:
        if m.error:
            rejected.append({"name": m.key, "reason": f"The photo {m.error}."})
        elif m.panorama:
            rejected.append({"name": m.key, "reason": "A panorama, not a frame photo."})
        else:
            ok.append(m)
    # byte-identical duplicates: compare full hashes only among photos of equal size and hash
    by_quick: dict[tuple, list[PhotoMeta]] = {}
    for m in ok:
        by_quick.setdefault((m.path.stat().st_size, m.dhash, m.time), []).append(m)
    dupes: set[str] = set()
    for group in by_quick.values():
        if len(group) < 2:
            continue
        seen: dict[str, PhotoMeta] = {}
        for m in group:
            m.sha1 = m.sha1 or file_sha1(m.path)
            if m.sha1 in seen:
                dupes.add(m.key)
                rejected.append({"name": m.key, "reason": f"A copy of {seen[m.sha1].key}."})
            else:
                seen[m.sha1] = m
    ok = [m for m in ok if m.key not in dupes]
    no_gps = [m.key for m in ok if not m.has_gps]
    if no_gps:
        shown = ", ".join(no_gps[:5]) + (" and others" if len(no_gps) > 5 else "")
        warnings.append(f"{len(no_gps)} photos have no GPS position ({shown}); they are matched by sequence.")
    groups = Counter(m.camera_key() for m in ok)
    if len(groups) > 1:
        names = ", ".join(f"{k[1] or k[0] or 'unknown'} {k[2]}x{k[3]}" for k in groups)
        warnings.append(
            f"The photos come from {len(groups)} cameras ({names}); each is calibrated on its own."
        )
    blurs = [m.blur for m in ok if m.blur is not None]
    if len(blurs) >= 5:
        med = float(np.median(blurs))
        blurred = [m.key for m in ok if m.blur is not None and m.blur < BLUR_RATIO * med]
        if blurred:
            warnings.append(
                f"{len(blurred)} photos look blurred ({', '.join(blurred[:5])}"
                + (" and others" if len(blurred) > 5 else "")
                + "); they may not align."
            )
    hashes: dict[int, str] = {}
    near = 0
    for m in ok:
        if m.dhash is None:
            continue
        if m.dhash in hashes and m.time and hashes.get(m.dhash) != m.key:
            near += 1
        hashes.setdefault(m.dhash, m.key)
    if near:
        warnings.append(f"{near} photos look almost the same as another photo (hovering or repeated shots).")
    return Inspection(ok, rejected, warnings)


def read_ppk(path: Path) -> dict[str, tuple[float, float, float, float, float]]:
    """A PPK CSV: ``image, lat, lon, h, sh, sv`` (header optional; comma, semicolon or tab)."""
    try:
        text = path.read_text("utf-8-sig")
    except OSError as e:
        raise JobError(f'The PPK file "{path.name}" cannot be read: {e}') from e
    dialect = csv.Sniffer().sniff(text[:2000], delimiters=",;\t") if text.strip() else csv.excel
    out: dict[str, tuple[float, float, float, float, float]] = {}
    for i, row in enumerate(csv.reader(io.StringIO(text), dialect)):
        row = [c.strip() for c in row if c is not None]
        if not row or row[0].startswith("#"):
            continue
        try:
            lat, lon, h, sh, sv = (float(v) for v in row[1:6])
        except (ValueError, IndexError):
            if i == 0:
                continue  # a header
            raise JobError(f'Line {i + 1} of the PPK file needs "image, lat, lon, h, sh, sv".') from None
        if not (-90 <= lat <= 90 and -180 <= lon <= 180) or sh <= 0 or sv <= 0:
            raise JobError(f"Line {i + 1} of the PPK file has an impossible position or accuracy.")
        out[row[0].replace("\\", "/")] = (lat, lon, h, sh, sv)
    if not out:
        raise JobError("The PPK file has no positions.")
    return out


def apply_ppk(metas: list[PhotoMeta], ppk: dict[str, tuple[float, float, float, float, float]]) -> int:
    """Replace EXIF positions by PPK ones (matched by key, else by a unique file name)."""
    by_name = Counter(m.path.name for m in metas)
    n = 0
    for m in metas:
        rec = ppk.get(m.key)
        if rec is None and by_name[m.path.name] == 1:
            rec = ppk.get(m.path.name)
        if rec is None:
            continue
        m.lat, m.lon, m.abs_alt = rec[0], rec[1], rec[2]
        m.rtk_std = (rec[3], rec[3], rec[4])
        m.ppk = True
        n += 1
    return n
