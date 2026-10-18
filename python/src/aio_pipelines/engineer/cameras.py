"""Calibrated source-photo crops. Only explicitly selected originals can be opened."""

from __future__ import annotations

import hashlib
import itertools
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from PIL import Image


@dataclass
class Camera:
    path: str
    centre: np.ndarray
    rotation: np.ndarray
    width: int
    height: int
    fx: float
    fy: float
    cx: float
    cy: float
    distortion: list[float]

    def project(self, points: np.ndarray) -> np.ndarray:
        camera = (points - self.centre) @ self.rotation.T
        usable = camera[:, 2] > 1e-6
        safe = np.where(usable, camera[:, 2], 1)
        x, y = camera[:, 0] / safe, camera[:, 1] / safe
        r2 = x * x + y * y
        k1, k2, k3, p1, p2 = self.distortion
        radial = 1 + k1 * r2 + k2 * r2 * r2 + k3 * r2 * r2 * r2
        xd = x * radial + 2 * p1 * x * y + p2 * (r2 + 2 * x * x)
        yd = y * radial + p1 * (r2 + 2 * y * y) + 2 * p2 * x * y
        result = np.column_stack([self.fx * xd + self.cx, self.fy * yd + self.cy])
        result[~usable] = np.nan
        return result


def read_cameras(path: Path, photos: list[Path], origin, height_offset_m: float, crs: dict) -> list[Camera]:
    if path.stat().st_size > 50 * 1024 * 1024:
        raise ValueError("Camera export exceeds 50 MB.")
    try:
        root = ET.parse(path).getroot()
    except ET.ParseError as error:
        raise ValueError("Camera export is not valid XML.") from error
    systems = {
        s.findtext("Id"): s.findtext("Definition") for s in root.findall(".//SpatialReferenceSystems/SRS")
    }
    block = root.find("Block")
    if block is None or systems.get(block.findtext("SRSId")) != f"EPSG:{crs.get('epsg')}":
        raise ValueError("Camera export and point cloud must use the same coordinate system.")
    names = {}
    for p in photos:
        key = p.name.casefold()
        if key in names and names[key] != p:
            raise ValueError("Selected photos have duplicate names; camera associations are ambiguous.")
        names[key] = p
    cameras = []
    # Delta local [east,up,south] -> delta source [east,north,height].
    local_to_enh = np.array([[1, 0, 0], [0, 0, -1], [0, 1, 0]])
    for group in block.findall(".//Photogroup"):
        width = int(group.findtext("ImageDimensions/Width", "0"))
        height = int(group.findtext("ImageDimensions/Height", "0"))
        focal = float(group.findtext("FocalLength", "0"))
        sensor = float(group.findtext("SensorSize", "0"))
        if min(width, height, focal, sensor) <= 0:
            continue
        fx = focal * width / sensor
        fy = fx * float(group.findtext("AspectRatio", "1"))
        cx = float(group.findtext("PrincipalPoint/x", str(width / 2)))
        cy = float(group.findtext("PrincipalPoint/y", str(height / 2)))
        distortion = [float(group.findtext("Distortion/" + k, "0")) for k in ("K1", "K2", "K3", "P1", "P2")]
        for photo in group.findall("Photo"):
            name = photo.findtext("ImagePath", "").replace("\\", "/").rsplit("/", 1)[-1].casefold()
            if name not in names:
                continue
            centre = np.array([float(photo.findtext("Pose/Center/" + k)) for k in ("x", "y", "z")])
            rotation = np.array(
                [[float(photo.findtext(f"Pose/Rotation/M_{i}{j}")) for j in range(3)] for i in range(3)]
            )
            if (
                not np.isfinite(centre).all()
                or not np.isfinite(rotation).all()
                or not np.allclose(rotation @ rotation.T, np.eye(3), atol=0.01)
            ):
                raise ValueError("Camera export contains an invalid pose.")
            centre = np.array(
                [centre[0] - origin[0], centre[2] - origin[2] + height_offset_m, origin[1] - centre[1]]
            )
            cameras.append(
                Camera(
                    str(names[name]),
                    centre,
                    rotation @ local_to_enh,
                    width,
                    height,
                    fx,
                    fy,
                    cx,
                    cy,
                    distortion,
                )
            )
            if len(cameras) > 2000:
                raise ValueError("Camera export has more than 2000 selected poses.")
    return cameras


def component_crops(
    cameras: list[Camera], observations: list[dict], out_dir: Path, budget: int, max_px: int, check=None
):
    """Choose well-framed, front-facing component photographs; preserve exact source associations."""
    from .components import directions

    out_dir.mkdir(parents=True, exist_ok=True)
    candidates = []
    for o in observations:
        if o["kind"] not in ("panel", "rru", "equipment-box"):
            continue
        centre = np.array(o["centre"])
        w, h, d = o["size"]
        right, front = directions(o["azimuthDeg"])
        corners = np.array(
            [
                centre + right * x * w / 2 + np.array([0, 1, 0]) * y * h / 2 + front * z * d / 2
                for x, y, z in itertools.product((-1, 1), repeat=3)
            ]
        )
        best = None
        for camera in cameras:
            to_camera = camera.centre - centre
            facing = float(to_camera @ front / max(np.linalg.norm(to_camera), 1e-6))
            if facing < 0.1:
                continue
            pixels = camera.project(corners)
            if not np.isfinite(pixels).all():
                continue
            lo, hi = pixels.min(axis=0), pixels.max(axis=0)
            if min(lo) < 0 or hi[0] > camera.width or hi[1] > camera.height:
                continue
            extent = hi - lo
            if min(extent) < 35:
                continue
            score = float(min(extent) * facing)
            if best is None or score > best[0]:
                best = (score, camera, lo, hi, o)
        if best:
            candidates.append(best)
    # Round-robin kinds and plan quadrants prevents large panels consuming every detail slot.
    chosen = []
    groups = {}
    for item in sorted(candidates, key=lambda v: -v[0]):
        o = item[4]
        key = (o["kind"], int(o["azimuthDeg"] // 90))
        groups.setdefault(key, []).append(item)
    while groups and len(chosen) < budget:
        for key in list(groups):
            if len(chosen) >= budget:
                break
            chosen.append(groups[key].pop(0))
            if not groups[key]:
                del groups[key]
    images = []
    for _, camera, lo, hi, o in chosen:
        if check:
            check()
        pad = (hi - lo) * 0.18
        box = (
            max(0, int(lo[0] - pad[0])),
            max(0, int(lo[1] - pad[1])),
            min(camera.width, int(hi[0] + pad[0]) + 1),
            min(camera.height, int(hi[1] + pad[1]) + 1),
        )
        ident = "img-part-" + hashlib.sha1(o["id"].encode()).hexdigest()[:12]
        dest = out_dir / (ident + ".jpg")
        with Image.open(camera.path) as original:
            if original.size != (camera.width, camera.height):
                continue
            crop = original.crop(box).convert("RGB")
            crop.thumbnail((max_px, max_px))
            crop.save(dest, "JPEG", quality=90)  # No EXIF/GPS in the outbound copy.
            width, height = crop.size
        data = dest.read_bytes()
        images.append(
            {
                "id": ident,
                "file": "img/" + dest.name,
                "kind": "photo",
                "view": o["id"][:40],
                "w": width,
                "h": height,
                "bytes": len(data),
                "sha1": hashlib.sha1(data).hexdigest(),
            }
        )
        o["sources"].append({"kind": "photo", "ref": ident})
    return images
