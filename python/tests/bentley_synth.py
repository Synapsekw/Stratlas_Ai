"""Synthetic Bentley iTwin Capture Modeler data (no client data): a fictional mast in UTM 39N.

- ``make_block``: a BlocksExchange 3.2 AT export (one photogroup, four photos, one of them not
  aligned) and three small JPEGs in two flight folders, the way Bentley writes such a block:
  rotations world to camera (x right, y down, z forward), centres in the block SRS, principal
  point in pixels, Brown distortion with Bentley's tangential order, and a ``Pose/Metadata``
  GNSS prior that must never be read as the pose.
- ``make_zpc``: a ``.zpc``, a ZIP of LAS tiles side by side (stored, as Bentley writes it).

``python bentley_synth.py <folder>`` writes both into ``<folder>`` (the e2e fixture) and prints
their paths as one JSON line.
"""

from __future__ import annotations

import datetime
import json
import struct
import sys
import zipfile
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

EPSG = 32639
ORIGIN = (500000.0, 3200000.0, 0.0)
W, H = 640, 480
FOCAL_MM, SENSOR_MM = 4.0, 6.4  # 400 px across the 640 px width
FOCAL_PX = FOCAL_MM * max(W, H) / SENSOR_MM
PP = (322.5, 238.0)
K = (0.01, -0.02, 0.005)
P_BENTLEY = (0.0004, -0.0003)  # Bentley's P1, P2 as written in the XML
TARGET = (500010.0, 3200020.0, 5.0)
#: Camera centres (E, N, H) around the target, and the photo files they belong to.
CENTRES = [(500000.0, 3200000.0, 30.0), (500025.0, 3200005.0, 28.0), (500030.0, 3200035.0, 32.0)]
FILES = ["flight-a/IMG_0001.JPG", "flight-a/img_0002.jpg", "flight-b/IMG_0003.JPG"]
TIMES = ["2026-03-04T10:00:05", "2026-03-04T10:00:01", "2026-03-04T10:00:09"]


def look_at(C, X) -> np.ndarray:
    """World-to-camera rotation (rows: image right, image down, forward) of a camera at C looking at X."""
    f = np.asarray(X, float) - np.asarray(C, float)
    f /= np.linalg.norm(f)
    right = np.cross(f, [0.0, 0.0, 1.0])
    right /= np.linalg.norm(right)
    down = np.cross(f, right)
    return np.vstack([right, down, f])


def bentley_project(R, C, X) -> np.ndarray:
    """Pixels of world points through the synthetic camera, by Bentley's own model."""
    cam = (np.asarray(X, float) - np.asarray(C, float)) @ np.asarray(R, float).T
    x, y = cam[:, 0] / cam[:, 2], cam[:, 1] / cam[:, 2]
    r2 = x * x + y * y
    radial = 1 + K[0] * r2 + K[1] * r2**2 + K[2] * r2**3
    P1, P2 = P_BENTLEY
    xd = x * radial + P1 * (r2 + 2 * x * x) + 2 * P2 * x * y
    yd = y * radial + P2 * (r2 + 2 * y * y) + 2 * P1 * x * y
    return np.column_stack([FOCAL_PX * xd + PP[0], FOCAL_PX * yd + PP[1]])


def make_project(root: Path) -> Path:
    root.mkdir(parents=True, exist_ok=True)
    manifest = {
        "schema": "aio.project/1",
        "id": root.name,
        "name": "Bentley test project",
        "crs": {"epsg": EPSG},
        "origin": list(ORIGIN),
        "captures": [],
        "layers": [],
        "severityModels": [],
        "classCatalogues": [],
    }
    (root / "manifest.json").write_text(json.dumps(manifest, indent=2), "utf-8")
    return root


def _matrix(tag: str, R: np.ndarray) -> str:
    # Plain floats: numpy 2 reprs (np.float64(0.5)) must never reach the XML.
    cells = "".join(f"<M_{i}{j}>{float(R[i, j])!r}</M_{i}{j}>" for i in range(3) for j in range(3))
    return f"<{tag}>{cells}<Accurate>true</Accurate></{tag}>"


def _photo(i: int, path: str, pose: tuple[np.ndarray, tuple] | None, taken: str) -> str:
    if pose is not None:
        R, C = pose
        prior = R @ np.array([[0.0, 1.0, 0.0], [-1.0, 0.0, 0.0], [0.0, 0.0, 1.0]])  # a decoy, 90 degrees off
        pose_xml = (
            f"<Pose>{_matrix('Rotation', R)}"
            f"<Center><x>{float(C[0])!r}</x><y>{float(C[1])!r}</y><z>{float(C[2])!r}</z>"
            "<Accurate>true</Accurate></Center>"
            f"<Metadata><SRSId>0</SRSId>{_matrix('Rotation', prior)}"
            "<Center><x>51.0</x><y>28.9</y><z>30.0</z></Center></Metadata></Pose>"
        )
    else:
        pose_xml = "<Pose><Metadata><SRSId>0</SRSId><Center><x>51.0</x><y>28.9</y><z>30.0</z></Center></Metadata></Pose>"
    return (
        f"<Photo><Id>{i}</Id><ImagePath>{path}</ImagePath><Component>1</Component>{pose_xml}"
        f"<ExifData><DateTimeOriginal>{taken}</DateTimeOriginal></ExifData></Photo>"
    )


def make_block(
    folder: Path, *, srs: str = f"EPSG:{EPSG}", version: str = "3.2", orientation: str = "XRightYDown"
) -> dict:
    folder.mkdir(parents=True, exist_ok=True)
    photos = folder / "photos"
    poses: dict[str, tuple[np.ndarray, tuple]] = {}
    xml_photos = []
    for i, (rel, C, taken) in enumerate(zip(FILES, CENTRES, TIMES, strict=True)):
        R = look_at(C, TARGET)
        poses[str(i)] = (R, C)
        xml_photos.append(_photo(i, f"R:/survey/{rel}", (R, C), taken))
        f = photos / rel
        f.parent.mkdir(parents=True, exist_ok=True)
        img = Image.new("RGB", (W, H), (90 + 40 * i, 120, 160))
        uv = bentley_project(R, C, np.array([TARGET]))[0]
        ImageDraw.Draw(img).ellipse([uv[0] - 6, uv[1] - 6, uv[0] + 6, uv[1] + 6], fill=(255, 0, 0))
        img.save(f, "JPEG", quality=85)
    xml_photos.append(_photo(3, "R:/survey/flight-b/IMG_0004.JPG", None, "2026-03-04T10:00:12"))
    P1, P2 = P_BENTLEY
    xml = f"""<?xml version="1.0" encoding="utf-8"?>
<BlocksExchange version="{version}">
  <SpatialReferenceSystems>
    <SRS><Id>0</Id><Name>WGS 84</Name><Definition>WGS84</Definition></SRS>
    <SRS><Id>1</Id><Name>Synthetic block SRS</Name><Definition>{srs}</Definition></SRS>
  </SpatialReferenceSystems>
  <Block>
    <Name>Synthetic mast - AT</Name>
    <SRSId>1</SRSId>
    <Photogroups>
      <Photogroup>
        <Name>Photogroup 1</Name>
        <ImageDimensions><Width>{W}</Width><Height>{H}</Height></ImageDimensions>
        <CameraModelType>Perspective</CameraModelType>
        <FocalLength>{FOCAL_MM!r}</FocalLength>
        <SensorSize>{SENSOR_MM!r}</SensorSize>
        <CameraOrientation>{orientation}</CameraOrientation>
        <PrincipalPoint><x>{PP[0]!r}</x><y>{PP[1]!r}</y></PrincipalPoint>
        <Distortion><K1>{K[0]!r}</K1><K2>{K[1]!r}</K2><K3>{K[2]!r}</K3><P1>{P1!r}</P1><P2>{P2!r}</P2></Distortion>
        <AspectRatio>1</AspectRatio>
        <Skew>0</Skew>
        {"".join(xml_photos)}
      </Photogroup>
    </Photogroups>
  </Block>
</BlocksExchange>
"""
    (folder / "at.xml").write_text(xml, "utf-8")
    return {
        "xml": str(folder / "at.xml"),
        "photos": str(photos),
        "poses": poses,
        "names": dict(enumerate(FILES)),
    }


def make_zpc(
    path: Path,
    tiles: int = 2,
    points: int = 500,
    extra: dict[str, bytes] | None = None,
    created: tuple[int, int] = (2026, 285),
) -> dict:
    """A ``.zpc`` of ``tiles`` LAS tiles; ``created`` = (year, day of year) is patched into each LAS header."""
    from aio_pipelines.change.las import write_las

    path.parent.mkdir(parents=True, exist_ok=True)
    work = path.parent / f".{path.stem}-tiles"
    work.mkdir(exist_ok=True)
    rng = np.random.default_rng(11)
    lo = np.array([TARGET[0], TARGET[1]])
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_STORED) as z:
        for t in range(tiles):
            xy = lo + np.array([t * 10.0, 0.0]) + rng.uniform(0, 10, (points, 2))
            xyz = np.column_stack([xy, rng.uniform(0, 10, points)])
            rgb = rng.integers(0, 65535, (points, 3)).astype(np.uint16)
            tile = work / f"Tile_{t + 1}.las"
            write_las(tile, xyz, pdrf=7, rgb=rgb)
            data = bytearray(tile.read_bytes())
            # LAS header: file creation day of year (u16) at 90, year (u16) at 92.
            struct.pack_into("<HH", data, 90, created[1], created[0])
            z.writestr(tile.name, bytes(data))
        for name, data in (extra or {}).items():
            z.writestr(name, data)
    for f in work.iterdir():
        f.unlink()
    work.rmdir()
    header_day = datetime.date(created[0], 1, 1) + datetime.timedelta(days=created[1] - 1)
    return {
        "zpc": str(path),
        "points": tiles * points,
        "bounds": (float(lo[0]), float(lo[1]), float(lo[0]) + 10.0 * tiles, float(lo[1]) + 10.0),
        "headerDay": header_day.isoformat(),
    }


if __name__ == "__main__":
    out = Path(sys.argv[1])
    block = make_block(out)
    z = make_zpc(out / "synthetic.zpc")
    print(
        json.dumps(
            {
                "xml": block["xml"],
                "photos": block["photos"],
                "zpc": z["zpc"],
                "points": z["points"],
                "headerDay": z["headerDay"],
                # the camera centres' raw heights in the block, before any correction
                "centreHeights": [c[2] for c in CENTRES],
            }
        )
    )
