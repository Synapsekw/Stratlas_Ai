"""Synthetic drone sphere panoramas: a procedural equirect scene cut into perspective frames.

No imagery is committed: every frame is rendered here from a seeded scene. Frames are JPEGs with
the EXIF (``Make``, ``DateTimeOriginal``, ``FocalLengthIn35mmFilm``) and DJI XMP (GPS, altitudes,
gimbal and flight yaw) the importer and the pipeline read.

Two capture patterns, as on the two reference sites of the spec (names withheld):

- ``rows``: rows at pitch 0, -35 and -70, 8 yaws each, row after row, then a nadir frame (25);
- ``bursts``: 7 yaws, a burst of 3 pitches (+20, -17, -55) per yaw, then a nadir frame (22).

The gimbal angles written are the true ones turned by a small world-frame rotation (zero mean over
the sphere), so a stitch that recovers the truth within 0.2 degrees has fixed the metadata error.
Run as a script for the e2e folder: ``python pano_synth.py <out> --spheres 3 --strays 4``.
"""

from __future__ import annotations

import argparse
import io
import json
import math
from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path

import cv2
import numpy as np
from PIL import Image

from aio_pipelines.pano.geometry import (
    gimbal_from_rot,
    principal,
    rot_from_gimbal,
    rotvecs_to_matrices,
)

SCENE_W = 4096
#: Generic synthetic coordinates (no real site).
LAT, LON = 46.5, 7.5
M_PER_DEG = 111_195.0
#: Capture start of the synthetic flight: local camera time, as EXIF keeps it.
START = datetime.fromisoformat("2026-09-10T10:00:00")

ROWS = [(float(y), float(p)) for p in (0, -35, -70) for y in range(-180, 180, 45)] + [(0.0, -90.0)]
BURSTS = [(round(-180 + k * 360 / 7, 1), float(p)) for k in range(7) for p in (20, -17, -55)] + [(0.0, -90.0)]
PATTERNS = {"rows": ROWS, "bursts": BURSTS}


def make_scene(width: int = SCENE_W, seed: int = 7, textureless: bool = False) -> np.ndarray:
    """An equirect scene (H, W, 3) uint8: value noise of several octaves and dark blobs, so every
    direction has features; or, ``textureless``, a smooth sky to ground gradient."""
    h = width // 2
    rows = np.linspace(0.0, 1.0, h, dtype=np.float32)[:, None, None]
    sky = np.array([200, 160, 120], np.float32)  # BGR
    ground = np.array([70, 110, 120], np.float32)
    base = sky * (1 - rows) + ground * rows
    if textureless:
        return np.broadcast_to(base, (h, width, 3)).astype(np.uint8)
    rng = np.random.default_rng(seed)
    tex = np.zeros((h, width), np.float32)
    amp = 1.0
    for cells in (8, 32, 128, 512, 1024):
        g = rng.random((cells // 2 + 1, cells + 1)).astype(np.float32)
        tex += amp * cv2.resize(g, (width, h), interpolation=cv2.INTER_LINEAR)
        amp *= 0.8
    tex = (tex - tex.min()) / (np.ptp(tex) + 1e-6)
    img = base * (0.4 + 0.8 * tex[..., None])
    # random quadrilaterals of their own colour: corners and edges SIFT finds at every scale
    for _ in range(width * 2):
        cx, cy = rng.uniform(0, width), rng.uniform(0, h)
        r = rng.uniform(2, 18) * width / SCENE_W
        ang = np.sort(rng.uniform(0, 2 * np.pi, 4))
        pts = np.stack([cx + r * np.cos(ang), cy + r * rng.uniform(0.5, 1.0, 4) * np.sin(ang)], axis=1)
        cv2.fillPoly(img, [np.round(pts).astype(np.int32)], rng.uniform(20, 235, 3).tolist())
    return np.clip(img, 0, 255).astype(np.uint8)


def render_frame(scene: np.ndarray, rot: np.ndarray, width: int, height: int, f: float) -> np.ndarray:
    """The perspective view of the scene from a camera with this camera-to-world rotation."""
    cx, cy = principal(width, height)
    xs, ys = np.meshgrid(np.arange(width, dtype=np.float32), np.arange(height, dtype=np.float32))
    rays = np.stack([(xs - cx) / f, (ys - cy) / f, np.ones_like(xs)], axis=-1)
    w = rays @ rot.T.astype(np.float32)
    w /= np.linalg.norm(w, axis=-1, keepdims=True)
    sh, sw = scene.shape[:2]
    lon = np.arctan2(w[..., 0], w[..., 1])
    lat = np.arcsin(np.clip(w[..., 2], -1, 1))
    u = ((lon + np.pi) / (2 * np.pi) * sw - 0.5).astype(np.float32)
    v = ((np.pi / 2 - lat) / np.pi * sh - 0.5).astype(np.float32)
    return cv2.remap(scene, u, v, cv2.INTER_LINEAR, borderMode=cv2.BORDER_WRAP)


def xmp_packet(fields: dict[str, float]) -> bytes:
    attrs = "\n".join(f'   drone-dji:{k}="{v:+.6f}"' for k, v in fields.items())
    xml = (
        '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">'
        '<rdf:Description rdf:about="DJI Meta Data" xmlns:drone-dji="http://www.dji.com/drone-dji/1.0/"\n'
        f"{attrs}>\n</rdf:Description></rdf:RDF></x:xmpmeta>"
    )
    return b"http://ns.adobe.com/xap/1.0/\x00" + xml.encode()


def write_frame(
    path: Path,
    img: np.ndarray,
    *,
    gimbal: tuple[float, float, float],
    focal35: float,
    lat: float,
    lon: float,
    abs_alt: float,
    rel_alt: float,
    taken_at: datetime,
) -> None:
    """A JPEG with DJI-like EXIF and XMP."""
    exif = Image.Exif()
    exif[0x010F] = "DJI"
    ifd = exif.get_ifd(0x8769)
    ifd[0x9003] = taken_at.strftime("%Y:%m:%d %H:%M:%S")
    ifd[0xA405] = round(focal35)
    pil = Image.fromarray(cv2.cvtColor(img, cv2.COLOR_BGR2RGB))
    buf = io.BytesIO()
    pil.save(buf, "JPEG", quality=92, exif=exif.tobytes())
    data = buf.getvalue()
    xmp = xmp_packet(
        {
            "GpsLatitude": lat,
            "GpsLongitude": lon,
            "AbsoluteAltitude": abs_alt,
            "RelativeAltitude": rel_alt,
            "GimbalYawDegree": gimbal[0],
            "GimbalPitchDegree": gimbal[1],
            "GimbalRollDegree": gimbal[2],
            "FlightYawDegree": gimbal[0],
        }
    )
    seg = b"\xff\xe1" + (len(xmp) + 2).to_bytes(2, "big") + xmp
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data[:2] + seg + data[2:])


@dataclass(frozen=True)
class SynthFrame:
    path: Path
    truth: np.ndarray
    gimbal: tuple[float, float, float]


def perturbations(n: int, max_deg: float, seed: int) -> np.ndarray:
    """World-frame rotation vectors (radians), uniform within +-max_deg per axis, zero mean."""
    rng = np.random.default_rng(seed)
    eps = rng.uniform(-max_deg, max_deg, (n, 3))
    eps -= eps.mean(axis=0)
    return np.radians(eps)


def frame_size(frame_w: int, aspect: tuple[int, int]) -> tuple[int, int]:
    return frame_w, round(frame_w * aspect[1] / aspect[0])


def make_sphere(
    folder: Path,
    pattern: str = "rows",
    *,
    scene: np.ndarray | None = None,
    frame_w: int = 640,
    focal35: float | None = None,
    perturb_deg: float = 1.5,
    seed: int = 1,
    start: datetime = START,
    east_m: float = 0.0,
    north_m: float = 0.0,
    first_no: int = 1,
    shots: list[tuple[float, float]] | None = None,
    focal_error: float = 0.0,
    blank: tuple[int, ...] = (),
    origin: tuple[float, float] = (LAT, LON),
) -> list[SynthFrame]:
    """Render one sphere into ``folder`` as ``SYN_<no>.JPG`` (numbers wrap after 0999)."""
    scene = make_scene() if scene is None else scene
    shots = PATTERNS[pattern] if shots is None else shots
    focal35 = focal35 if focal35 is not None else (28.0 if pattern == "rows" else 24.0)
    width, height = frame_size(frame_w, (3, 2) if pattern == "rows" else (4, 3))
    f = focal35 / 43.2666 * math.hypot(width, height)
    eps = rotvecs_to_matrices(perturbations(len(shots), perturb_deg, seed))
    rng = np.random.default_rng(seed + 1000)
    lat0 = origin[0] + north_m / M_PER_DEG
    lon0 = origin[1] + east_m / (M_PER_DEG * math.cos(math.radians(origin[0])))
    out: list[SynthFrame] = []
    t = 0.0
    for k, (yaw, pitch) in enumerate(shots):
        truth = rot_from_gimbal(yaw, pitch, 0.0)
        seeded = eps[k] @ truth
        g = gimbal_from_rot(seeded)
        no = (first_no + k - 1) % 999 + 1
        path = folder / f"SYN_{no:04d}.JPG"
        write_frame(
            path,
            (
                np.full((height, width, 3), 128, np.uint8)
                if k in blank
                else render_frame(scene, truth, width, height, f * (1 + focal_error))
            ),
            gimbal=g,
            focal35=focal35,
            lat=lat0 + rng.uniform(-0.5, 0.5) / M_PER_DEG,
            lon=lon0 + rng.uniform(-0.5, 0.5) / M_PER_DEG,
            abs_alt=620.0 + rng.uniform(-0.5, 0.5),
            rel_alt=70.0 + rng.uniform(-0.5, 0.5),
            taken_at=start + timedelta(seconds=t),
        )
        out.append(SynthFrame(path, truth, g))
        t += 6 if pattern == "rows" else (5 if k % 3 == 2 else 1)
    return out


def make_strays(
    folder: Path,
    n: int,
    *,
    start: datetime,
    first_no: int,
    frame_w: int = 320,
    origin: tuple[float, float] = (LAT, LON),
) -> list[Path]:
    """Mapping photos: nadir, 20 m apart, 2 s apart, one flight yaw, 300 m north of `origin`."""
    scene = make_scene(1024, seed=99)
    width, height = frame_size(frame_w, (3, 2))
    f = 28 / 43.2666 * math.hypot(width, height)
    m_per_deg_lon = M_PER_DEG * math.cos(math.radians(origin[0]))
    paths = []
    for i in range(n):
        path = folder / f"SYN_{(first_no + i - 1) % 999 + 1:04d}.JPG"
        rot = rot_from_gimbal(92.0, -90.0, 0.0)
        write_frame(
            path,
            render_frame(scene, rot, width, height, f),
            gimbal=(92.0, -90.0, 0.0),
            focal35=28,
            lat=origin[0] + 300 / M_PER_DEG,
            lon=origin[1] + (i * 20) / m_per_deg_lon,
            abs_alt=650.0,
            rel_alt=100.0,
            taken_at=start + timedelta(seconds=2 * i),
        )
        paths.append(path)
    return paths


def make_folder(
    out: Path,
    spheres: int = 3,
    strays: int = 4,
    frame_w: int = 320,
    origin: tuple[float, float] = (LAT, LON),
) -> dict:
    """The e2e card folder: spheres 150 m apart (east of `origin`), 4 minutes apart, alternating
    patterns, then a short mapping run; one folder, file numbers continuing (and wrapping)."""
    scene = make_scene(2048)
    no = 960
    t = START
    counts = []
    for s in range(spheres):
        pattern = "rows" if s % 2 == 0 else "bursts"
        frames = make_sphere(
            out,
            pattern,
            scene=scene,
            frame_w=frame_w,
            seed=s + 1,
            start=t,
            east_m=150.0 * s,
            first_no=no,
            origin=origin,
        )
        counts.append(len(frames))
        no += len(frames)
        t += timedelta(minutes=4)
    make_strays(out, strays, start=t, first_no=no, origin=origin)
    return {"folder": str(out), "spheres": counts, "strays": strays}


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("out")
    ap.add_argument("--spheres", type=int, default=3)
    ap.add_argument("--strays", type=int, default=4)
    ap.add_argument("--frame-width", type=int, default=320)
    ap.add_argument("--lat", type=float, default=LAT)
    ap.add_argument("--lon", type=float, default=LON)
    a = ap.parse_args(argv)
    print(json.dumps(make_folder(Path(a.out), a.spheres, a.strays, a.frame_width, (a.lat, a.lon))))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
