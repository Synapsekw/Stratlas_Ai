"""BlocksExchange 3.x, the AT export of Bentley iTwin Capture Modeler (formerly ContextCapture).

What is read (data-conventions section 35): the SRS list and the block's ``SRSId``; per
photogroup the image size, the focal length (``FocalLengthPixels``, else ``FocalLength`` in mm
over ``SensorSize``, the sensor's largest side in mm), the principal point (pixels from the
top-left corner), the distortion ``K1 K2 K3 P1 P2`` as written, ``AspectRatio`` and ``Skew``;
per photo its ``ImagePath``, the adjusted pose (``Pose/Rotation`` ``M_ij``, world to camera with
x right, y down, z forward, and ``Pose/Center`` in the block SRS) and ``ExifData/DateTimeOriginal``.
``Pose/Metadata`` is the GNSS prior in another SRS and is never read. A photo without a rotation
or a centre is not aligned. Tie points and control points are not read.

Python's expat refuses entity expansion attacks and ElementTree resolves no external entities.
"""

from __future__ import annotations

import xml.etree.ElementTree as ET
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from ..runtime import JobError

MARKER = b"<BlocksExchange"
#: A block of tens of thousands of photos is a few hundred MB of XML.
MAX_XML_BYTES = 1024**3
ORIENTATION = "XRightYDown"
ANGLE_TAGS = ("Omega", "Phi", "Kappa", "Yaw", "Pitch", "Roll", "Heading")


@dataclass
class Srs:
    id: str
    name: str
    definition: str


@dataclass
class Photogroup:
    index: int
    name: str
    width: int
    height: int
    focal_px: float
    cx: float
    cy: float
    k: tuple[float, float, float]
    p: tuple[float, float]
    aspect: float
    skew: float


@dataclass
class BlockPhoto:
    id: str
    image_path: str
    group: int
    rotation: np.ndarray | None
    centre: np.ndarray | None
    taken: str | None


@dataclass
class Block:
    version: str
    name: str
    srs: Srs | None
    groups: list[Photogroup]
    photos: list[BlockPhoto]

    def aligned(self) -> list[BlockPhoto]:
        return [p for p in self.photos if p.rotation is not None and p.centre is not None]

    def unaligned(self) -> list[BlockPhoto]:
        return [p for p in self.photos if p.rotation is None or p.centre is None]


def is_blocks_exchange(path: Path) -> bool:
    try:
        with open(path, "rb") as f:
            return MARKER in f.read(4096)
    except OSError:
        return False


def _num(el: ET.Element, tag: str, what: str, default: float | None = None) -> float:
    v = el.findtext(tag)
    if v is None or not v.strip():
        if default is not None:
            return default
        raise JobError(f"{what} has no {tag}.")
    try:
        return float(v)
    except ValueError:
        raise JobError(f"{what}: {tag} is not a number ({v[:40]}).") from None


def _group(i: int, g: ET.Element) -> Photogroup:
    name = (g.findtext("Name") or f"Photogroup {i + 1}").strip()
    what = f'The photogroup "{name}"'
    orientation = (g.findtext("CameraOrientation") or ORIENTATION).strip()
    if orientation != ORIENTATION:
        raise JobError(f"{what} uses the camera orientation {orientation}; only {ORIENTATION} is read.")
    dims = g.find("ImageDimensions")
    if dims is None:
        raise JobError(f"{what} has no image size.")
    w, h = int(_num(dims, "Width", what)), int(_num(dims, "Height", what))
    if g.findtext("FocalLengthPixels"):
        focal = _num(g, "FocalLengthPixels", what)
    else:
        mm = _num(g, "FocalLength", what)
        if not (g.findtext("SensorSize") or "").strip():
            raise JobError(f"{what} gives its focal length in mm but no sensor size.")
        focal = mm * max(w, h) / _num(g, "SensorSize", what)
    pp = g.find("PrincipalPoint")
    cx = _num(pp, "x", what) if pp is not None else w / 2
    cy = _num(pp, "y", what) if pp is not None else h / 2
    d = g.find("Distortion")
    k = tuple(_num(d, t, what, 0.0) for t in ("K1", "K2", "K3")) if d is not None else (0.0, 0.0, 0.0)
    p = tuple(_num(d, t, what, 0.0) for t in ("P1", "P2")) if d is not None else (0.0, 0.0)
    aspect, skew = _num(g, "AspectRatio", what, 1.0), _num(g, "Skew", what, 0.0)
    if abs(aspect - 1) > 1e-6 or abs(skew) > 1e-6:
        raise JobError(f"{what} has an aspect ratio of {aspect} and a skew of {skew}; only 1 and 0 are read.")
    return Photogroup(i, name, w, h, focal, cx, cy, k, p, aspect, skew)  # type: ignore[arg-type]


def _pose(photo: ET.Element, label: str) -> tuple[np.ndarray | None, np.ndarray | None]:
    pose = photo.find("Pose")
    if pose is None:
        return None, None
    rot, cen = pose.find("Rotation"), pose.find("Center")  # direct children: never Metadata's
    R = None
    if rot is not None:
        if any(rot.find(t) is not None for t in ANGLE_TAGS):
            raise JobError(
                f"{label} gives its rotation as angles; export the block again with rotation matrices."
            )
        R = np.array([[_num(rot, f"M_{i}{j}", label) for j in range(3)] for i in range(3)])
        if not np.allclose(R @ R.T, np.eye(3), atol=1e-4) or abs(np.linalg.det(R) - 1) > 1e-4:
            raise JobError(f"{label}: its rotation matrix is not a rotation.")
    C = np.array([_num(cen, a, label) for a in "xyz"]) if cen is not None else None
    return R, C


def read_block(path: Path) -> Block:
    if path.stat().st_size > MAX_XML_BYTES:
        raise JobError(f"{path.name} is larger than 1 GB; it is not read.")
    try:
        root = ET.parse(path).getroot()
    except ET.ParseError as e:
        raise JobError(f"{path.name} is not well-formed XML: {e}") from None
    if root.tag != "BlocksExchange":
        raise JobError(
            f"{path.name} is not a BlocksExchange file (an AT export of Bentley iTwin Capture Modeler)."
        )
    version = root.get("version") or ""
    if version.split(".")[0] != "3":
        raise JobError(
            f"{path.name} is BlocksExchange version {version or 'unknown'}; only version 3 is read."
        )
    srs_list = {
        (s.findtext("Id") or "").strip(): Srs(
            (s.findtext("Id") or "").strip(),
            (s.findtext("Name") or "").strip(),
            (s.findtext("Definition") or "").strip(),
        )
        for s in root.findall("SpatialReferenceSystems/SRS")
    }
    blocks = root.findall("Block")
    if not blocks:
        raise JobError(f"{path.name} holds no block.")
    block = blocks[0]
    srs = srs_list.get((block.findtext("SRSId") or "").strip())
    groups: list[Photogroup] = []
    photos: list[BlockPhoto] = []
    for i, g in enumerate(block.findall("Photogroups/Photogroup")):
        group = _group(i, g)
        groups.append(group)
        for ph in g.findall("Photo"):
            image = (ph.findtext("ImagePath") or "").strip()
            pid = (ph.findtext("Id") or "").strip() or str(len(photos))
            R, C = _pose(ph, f"The photo {image.replace(chr(92), '/').rsplit('/', 1)[-1] or pid}")
            taken = (ph.findtext("ExifData/DateTimeOriginal") or "").strip() or None
            photos.append(BlockPhoto(pid, image, i, R, C, taken))
    return Block(version, (block.findtext("Name") or path.stem).strip(), srs, groups, photos)
