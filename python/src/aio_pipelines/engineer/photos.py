"""Photo ingestion for the evidence pack.

Pixels used as evidence are upright (EXIF orientation applied to a bounded review copy); the
original file is never changed and is linked by path. A photo's id is the sha1 of its bytes.
Byte-identical copies and near duplicates (dhash within 4 bits) are removed from the evidence set
and recorded with `dupOf`. The only metadata that leaves a photo is the camera position
(`gpsCamera`, never a position of the asset); EXIF text, thumbnails and GPS are not copied into
the review copies or the pack.

Identity: photos whose colour make-up has nothing in common with the others are flagged, not
blended (`identity` in the result, `review` on the photo), so the run can stop and the user can drop
them.
"""

from __future__ import annotations

import hashlib
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import numpy as np
from PIL import Image, ImageOps

from ..photo.exif import _dhash, _laplacian_variance, file_sha1, read_photo

NEAR_DUPLICATE_BITS = 4
#: Histogram intersection under which two photos share no colour make-up (same place and light: 0.6+).
IDENTITY_MIN_SIMILARITY = 0.3
SIGNATURE_PX = 96
BLUR_PX = 512


@dataclass
class IngestResult:
    items: list[dict[str, Any]] = field(default_factory=list)  # PhotoItem dicts, kept and dropped
    kept: list[str] = field(default_factory=list)  # ids of the photos used as evidence
    copies: dict[str, Path] = field(default_factory=dict)  # id -> review copy
    identity: dict[str, Any] = field(default_factory=lambda: {"sameAsset": True, "conflicts": []})
    rejected: list[dict[str, str]] = field(default_factory=list)  # unreadable files, with reasons


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
    os.replace(tmp, path)


def ingest_photos(paths: list[Path], out_dir: Path, max_px: int, max_images: int) -> IngestResult:
    """Read, orient, de-duplicate and cap the photos; write review copies of those kept.

    Order of work: unreadable files are rejected; exact duplicates (same sha1) and near duplicates
    (dhash distance 4 or less, the sharper one kept) are dropped with `dupOf`; of the rest the
    `max_images` sharpest are kept. Dropped photos stay in `items` (`review` says why) so the run
    can show them.
    """
    result = IngestResult()
    loaded: list[dict[str, Any]] = []
    for i, p in enumerate(paths):
        p = Path(p)
        meta = read_photo(str(i), p, look=False)
        if meta.error:
            result.rejected.append({"path": str(p), "reason": f"{p.name} {meta.error}"})
            continue
        try:
            with Image.open(p) as raw:
                orientation = int(raw.getexif().get(0x0112, 1) or 1)
                up = ImageOps.exif_transpose(raw)
                up = up.convert("RGB") if up is not None else raw.convert("RGB")
                up.load()
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
            "w": up.width,
            "h": up.height,
            "orientationApplied": orientation != 1,
            "blur": _laplacian_variance(np.asarray(g)),
        }
        if meta.has_gps and meta.lat is not None and meta.lon is not None:
            item["gpsCamera"] = [float(meta.lon), float(meta.lat), float(meta.altitude or 0.0)]
        loaded.append({"item": item, "image": up, "dhash": _dhash(gray), "path": p})

    # exact duplicates: the first file keeps the id, a copy gets its own id and points at it
    by_sha: dict[str, dict[str, Any]] = {}
    unique: list[dict[str, Any]] = []
    for ph in loaded:
        it = ph["item"]
        first = by_sha.get(it["id"])
        if first is None:
            by_sha[it["id"]] = ph
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
    for ph in keepers[max(0, int(max_images)) :]:
        ph["item"]["review"] = "over the image limit, not used"
    used = keepers[: max(0, int(max_images))]

    for ph in used:
        im = ph["image"].copy()
        im.thumbnail((max_px, max_px), Image.LANCZOS)
        path = out_dir / f"{ph['item']['id'][:16]}.jpg"
        _write_jpeg(im, path)
        result.copies[ph["item"]["id"]] = path
        result.kept.append(ph["item"]["id"])
        ph["sig"] = _colour_signature(im)

    _flag_identity(used, result)
    result.items = [ph["item"] for ph in loaded]
    return result


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
        ids = [used[i]["item"]["id"] for i in g]
        for i in g:
            used[i]["item"]["review"] = "identity: colours differ from the other photos"
        result.identity["conflicts"].append(
            {
                "imageIds": ids[:40],
                "reason": "These photos share no colours with the rest; they may show another asset.",
            }
        )
    result.identity["sameAsset"] = False
