"""Photo ingestion for the evidence pack.

Pixels used as evidence are upright (EXIF orientation applied to a bounded review copy); the
original file is never changed and is linked by path. A photo's id is the sha1 of its bytes.
Byte-identical copies and near duplicates (dhash within 4 bits) are removed from the evidence set
and recorded with `dupOf`. The only metadata that leaves a photo is the camera position
(`gpsCamera`, never a position of the asset); EXIF text, thumbnails and GPS are not copied into
the review copies or the pack.

Memory is bounded by one photo at a time: each is decoded, turned upright, cut down to the review
size and written out before the next is opened, so 400 twenty-megapixel photos never sit in memory
together. Only small signatures stay.

Quality gate: a photo under 320 px on its long side, or with no detail at all (blur score under
0.5 at 512 px), is rejected with the reason on its item.

Identity: photos whose colour make-up has nothing in common with the others, or whose camera
position is implausibly far from the asset, are flagged, not blended (`identity` in the result,
`review` on the photo), so the run can stop and the user can drop them.
"""

from __future__ import annotations

import hashlib
import math
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import numpy as np
from PIL import Image, ImageOps

from ..photo.exif import _dhash, _laplacian_variance, file_sha1, read_photo
from ..runtime import replace_over

NEAR_DUPLICATE_BITS = 4
#: Histogram intersection under which two photos share no colour make-up (same place and light: 0.6+).
IDENTITY_MIN_SIMILARITY = 0.3
SIGNATURE_PX = 96
BLUR_PX = 512
MIN_LONG_SIDE_PX = 320
#: Laplacian variance of the 512 px grey image under which a photo has no usable detail.
MIN_BLUR_SCORE = 0.5
#: A camera this far from the asset (metres) is not a photo of it.
CAMERA_FAR_M = 5000.0


@dataclass
class IngestResult:
    items: list[dict[str, Any]] = field(default_factory=list)  # PhotoItem dicts, kept and dropped
    kept: list[str] = field(default_factory=list)  # ids of the photos used as evidence
    copies: dict[str, Path] = field(default_factory=dict)  # id -> review copy
    identity: dict[str, Any] = field(default_factory=lambda: {"sameAsset": True, "conflicts": []})
    rejected: list[dict[str, str]] = field(default_factory=list)  # unusable files, with reasons


def _hamming(a: int, b: int) -> int:
    return (a ^ b).bit_count()


def _colour_signature(im: Image.Image) -> np.ndarray:
    """A normalised 4 x 4 x 4 colour histogram of the upright photo."""
    small = np.asarray(im.convert("RGB").resize((SIGNATURE_PX, SIGNATURE_PX), Image.BILINEAR))
    q = (small // 64).reshape(-1, 3).astype(np.int64)
    h = np.bincount(q[:, 0] * 16 + q[:, 1] * 4 + q[:, 2], minlength=64).astype(np.float64)
    return h / h.sum()


def _write_jpeg(im: Image.Image, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    im.save(tmp, format="JPEG", quality=85)  # no exif argument: nothing of the original's metadata
    replace_over(tmp, path)


def ingest_photos(
    paths: list[Path],
    out_dir: Path,
    max_px: int,
    max_images: int,
    check: Callable[[], None] | None = None,
) -> IngestResult:
    """Read, orient, gate, de-duplicate and cap the photos; write review copies of those kept.

    Unreadable photos and those failing the quality gate are rejected. Exact duplicates (same sha1)
    and near duplicates (dhash distance 4 or less, the sharper one kept) are dropped with `dupOf`;
    of the rest the `max_images` sharpest are kept. Dropped photos stay in `items` (`review` says
    why) so the run can show them. `check` is called between photos (cancellation).
    """
    result = IngestResult()
    loaded: list[dict[str, Any]] = []
    first_of: dict[str, dict[str, Any]] = {}
    for i, p in enumerate(paths):
        if check:
            check()
        p = Path(p)
        meta = read_photo(str(i), p, look=False)
        if meta.error:
            result.rejected.append({"path": str(p), "reason": f"{p.name} {meta.error}"})
            continue
        try:
            with Image.open(p) as raw:
                orientation = int(raw.getexif().get(0x0112, 1) or 1)
                full_w, full_h = (raw.height, raw.width) if orientation in (5, 6, 7, 8) else raw.size
                raw.draft("RGB", (max_px, max_px))  # JPEG: decode at a reduced scale when it suffices
                up = ImageOps.exif_transpose(raw)
                up = (up if up is not None else raw).convert("RGB")
            up.thumbnail((max_px, max_px), Image.LANCZOS)  # the full decode is gone after this
        except Exception as e:
            result.rejected.append(
                {"path": str(p), "reason": f"{p.name} cannot be decoded ({type(e).__name__})"}
            )
            continue
        gray = up.convert("L")
        scale = BLUR_PX / max(gray.size)
        g = gray.resize(
            (max(8, round(gray.width * scale)), max(8, round(gray.height * scale))), Image.BILINEAR
        )
        sha = file_sha1(p)
        item: dict[str, Any] = {
            "id": sha,
            "original": str(p),
            "w": full_w,
            "h": full_h,
            "orientationApplied": orientation != 1,
            "blur": _laplacian_variance(np.asarray(g)),
        }
        if meta.has_gps and meta.lat is not None and meta.lon is not None:
            item["gpsCamera"] = [float(meta.lon), float(meta.lat), float(meta.altitude or 0.0)]
        ph: dict[str, Any] = {"item": item, "dhash": _dhash(gray), "path": p}
        loaded.append(ph)
        if max(full_w, full_h) < MIN_LONG_SIDE_PX or item["blur"] < MIN_BLUR_SCORE:
            why = (
                f"too small ({full_w} x {full_h} px)"
                if max(full_w, full_h) < MIN_LONG_SIDE_PX
                else "no usable detail (out of focus or blank)"
            )
            item["review"] = f"rejected: {why}"
            result.rejected.append({"path": str(p), "reason": f"{p.name} rejected: {why}"[:300]})
            ph["gated"] = True
            continue
        if sha in first_of:
            continue  # an exact copy needs no copy of its own
        first_of[sha] = ph
        copy = out_dir / f"{sha[:16]}.jpg"
        _write_jpeg(up, copy)
        ph["copy"] = copy
        ph["sig"] = _colour_signature(up)

    # exact duplicates: the first file keeps the id, a copy gets its own id and points at it
    unique: list[dict[str, Any]] = []
    for ph in loaded:
        if ph.get("gated"):
            continue
        it = ph["item"]
        if first_of.get(it["id"]) is ph:
            unique.append(ph)
        else:
            it["dupOf"] = it["id"]
            it["id"] = hashlib.sha1(f"{ph['path']}\n{it['id']}".encode()).hexdigest()
            it["review"] = "identical file, not used"
    # near duplicates: sharpest first, each later photo within 4 bits of a kept one is dropped
    candidates = sorted(unique, key=lambda ph: (-ph["item"]["blur"], str(ph["path"])))
    keepers: list[dict[str, Any]] = []
    for ph in candidates:
        twin = next((k for k in keepers if _hamming(k["dhash"], ph["dhash"]) <= NEAR_DUPLICATE_BITS), None)
        if twin is not None:
            ph["item"]["dupOf"] = twin["item"]["id"]
            ph["item"]["review"] = "near duplicate, not used"
        else:
            keepers.append(ph)
    limit = max(0, int(max_images))
    for ph in keepers[limit:]:
        ph["item"]["review"] = "over the image limit, not used"
    used = keepers[:limit]
    used_ids = {ph["item"]["id"] for ph in used}
    for ph in unique:  # copies of photos that are not used are not kept
        if ph["item"]["id"] not in used_ids:
            ph["copy"].unlink(missing_ok=True)
    for ph in used:
        result.copies[ph["item"]["id"]] = ph["copy"]
        result.kept.append(ph["item"]["id"])
    _flag_identity(used, result)
    result.items = [ph["item"] for ph in loaded]
    return result


def _flag(result: IngestResult, ids: list[str], reason: str) -> None:
    result.identity["conflicts"].append({"imageIds": ids[:40], "reason": reason[:300]})
    result.identity["sameAsset"] = False


def _flag_identity(used: list[dict[str, Any]], result: IngestResult) -> None:
    """Groups of photos linked by shared colour make-up; every group but the biggest is flagged."""
    n = len(used)
    if n < 2:
        return
    parent = list(range(n))

    def find(a: int) -> int:
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a

    for a in range(n):
        for b in range(a + 1, n):
            if float(np.minimum(used[a]["sig"], used[b]["sig"]).sum()) >= IDENTITY_MIN_SIMILARITY:
                parent[find(a)] = find(b)
    groups: dict[int, list[int]] = {}
    for i in range(n):
        groups.setdefault(find(i), []).append(i)
    if len(groups) < 2:
        return
    main = max(groups.values(), key=len)
    for g in groups.values():
        if g is main:
            continue
        for i in g:
            used[i]["item"]["review"] = "identity: colours differ from the other photos"
        _flag(
            result,
            [used[i]["item"]["id"] for i in g],
            "These photos share no colours with the rest; they may show another asset.",
        )


def distance_m(lon1: float, lat1: float, lon2: float, lat2: float) -> float:
    """Great-circle distance in metres (haversine, a mean Earth radius)."""
    p1, p2 = math.radians(lat1), math.radians(lat2)
    a = (
        math.sin((p2 - p1) / 2) ** 2
        + math.cos(p1) * math.cos(p2) * math.sin(math.radians(lon2 - lon1) / 2) ** 2
    )
    return 2 * 6371008.8 * math.asin(min(1.0, math.sqrt(a)))


def flag_far_cameras(
    result: IngestResult, centre_lonlat: tuple[float, float], limit_m: float = CAMERA_FAR_M
) -> None:
    """Flag kept photos whose camera position is more than `limit_m` from the region centre. The
    position is the camera's, never a position of the asset; a photo without GPS is not judged."""
    by_id = {it["id"]: it for it in result.items}
    far: list[tuple[str, float]] = []
    for pid in result.kept:
        gps = by_id[pid].get("gpsCamera")
        if gps:
            d = distance_m(gps[0], gps[1], centre_lonlat[0], centre_lonlat[1])
            if d > limit_m:
                far.append((pid, d))
    for pid, d in far:
        by_id[pid]["review"] = f"identity: camera is {d / 1000:.0f} km from the asset"
    if far:
        _flag(
            result,
            [pid for pid, _ in far],
            f"These photos were taken more than {limit_m / 1000:.0f} km from the asset.",
        )
