"""Stream G2's own small photogrammetry fixtures (synthetic only; G8's ``photo_synth.py`` is the
shared set and replaces these where it can).

- ``synthetic_jpeg``: a JPEG with EXIF (make, model, focal, GPS) and a DJI-style XMP packet (gimbal,
  altitudes, RTK flag and standard deviations), written with Pillow only.
- ``SceneTruth`` and ``make_scene``: a nadir grid of pinhole cameras with OPENCV distortion over a
  gently rolling ground with GCPs and tie points, the exact projections, and a ``SyntheticEngine``
  (the alignment engine adapter of ``photo/colmap_io.py``) that "reconstructs" it in an arbitrary
  frame with noise, so ``photo.align`` and ``photo.georef`` run end to end in CI without COLMAP.
- ``render_nadir_set``: real rendered images of a textured height field for alignment experiments
  with an actual SfM engine (used by the opt-in engine tests and the engine comparison).

Everything is seeded. The site is the fictional desert location of the other fixtures (UTM 39N);
``Make`` is "Stratlas Synthetic", ``Model`` "SYN-20", and there is no serial number.
"""

from __future__ import annotations

import io
import json
import math
import struct
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
from PIL import Image
from PIL.TiffImagePlugin import IFDRational

from aio_pipelines.photo import crs as C
from aio_pipelines.photo.model import Camera, SparseModel, project_points
from aio_pipelines.photo.model import Image as MImage

SITE_LON, SITE_LAT = 51.4321, 25.1234
MAKE, MODEL = "Stratlas Synthetic", "SYN-20"


def _rat(x, den=10000):
    return IFDRational(round(x * den), den)


def _dms(deg):
    deg = abs(deg)
    d = int(deg)
    m = int((deg - d) * 60)
    s = (deg - d - m / 60) * 3600
    return (IFDRational(d, 1), IFDRational(m, 1), _rat(s, 100000))


def synthetic_jpeg(
    path: Path,
    lat: float | None = SITE_LAT,
    lon: float | None = SITE_LON,
    alt: float | None = 60.0,
    rel: float | None = None,
    yaw: float | None = 0.0,
    pitch: float | None = -90.0,
    roll: float | None = 0.0,
    rtk_flag: int | None = None,
    rtk_std: tuple[float, float, float] | None = None,
    size: tuple[int, int] = (160, 120),
    focal_mm: float = 8.8,
    focal35: float = 24.0,
    make: str | None = MAKE,
    model: str | None = MODEL,
    pixels: np.ndarray | None = None,
    time: str = "2026:01:02 10:00:00",
    quality: int = 90,
    xmp_extra: str = "",
) -> Path:
    if pixels is None:
        rng = np.random.default_rng(abs(hash((lat, lon, alt, size))) % (2**32))
        pixels = rng.integers(0, 255, (size[1], size[0], 3), dtype=np.uint8)
    img = Image.fromarray(pixels)
    exif = Image.Exif()
    if make:
        exif[271] = make
    if model:
        exif[272] = model
    exif[306] = time
    sub = exif.get_ifd(0x8769)
    sub[36867] = time
    sub[41989] = int(focal35)
    sub[37386] = _rat(focal_mm)
    if lat is not None and lon is not None:
        gps = exif.get_ifd(0x8825)
        gps[1] = "N" if lat >= 0 else "S"
        gps[2] = _dms(lat)
        gps[3] = "E" if lon >= 0 else "W"
        gps[4] = _dms(lon)
        if alt is not None:
            gps[5] = 0 if alt >= 0 else 1
            gps[6] = _rat(abs(alt), 1000)
    buf = io.BytesIO()
    img.save(buf, "JPEG", exif=exif.tobytes(), quality=quality)
    data = buf.getvalue()
    attrs = []
    if yaw is not None:
        attrs.append(f'drone-dji:GimbalYawDegree="{yaw:+.2f}"')
    if pitch is not None:
        attrs.append(f'drone-dji:GimbalPitchDegree="{pitch:+.2f}"')
    if roll is not None:
        attrs.append(f'drone-dji:GimbalRollDegree="{roll:+.2f}"')
    if alt is not None:
        attrs.append(f'drone-dji:AbsoluteAltitude="{alt:+.3f}"')
    if rel is not None:
        attrs.append(f'drone-dji:RelativeAltitude="{rel:+.3f}"')
    if rtk_flag is not None:
        attrs.append(f'drone-dji:RtkFlag="{rtk_flag}"')
    if rtk_std is not None:
        attrs.append(
            f'drone-dji:RtkStdLon="{rtk_std[0]:.5f}" drone-dji:RtkStdLat="{rtk_std[1]:.5f}" '
            f'drone-dji:RtkStdHgt="{rtk_std[2]:.5f}"'
        )
    if attrs or xmp_extra:
        xmp = (
            '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">'
            f'<rdf:Description xmlns:drone-dji="http://www.dji.com/drone-dji/1.0/" '
            f'xmlns:GPano="http://ns.google.com/photos/1.0/panorama/" {" ".join(attrs)} {xmp_extra}/>'
            "</rdf:RDF></x:xmpmeta>"
        ).encode()
        payload = b"http://ns.adobe.com/xap/1.0/\x00" + xmp
        seg = b"\xff\xe1" + struct.pack(">H", len(payload) + 2) + payload
        data = data[:2] + seg + data[2:]
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return path


# ------------------------------------------------------------------------------- scene and truth


def ground_height(x, y):
    """The synthetic site's ground (ENU metres): gentle slopes, a stockpile and a pit."""
    x = np.asarray(x, dtype=np.float64)
    y = np.asarray(y, dtype=np.float64)
    h = 1.5 * np.sin(x / 37.0) + 1.2 * np.cos(y / 29.0) + 0.01 * x
    h += 6.0 * np.exp(-((x - 20) ** 2 + (y - 10) ** 2) / (2 * 12.0**2))
    h -= 3.0 * np.exp(-((x + 35) ** 2 + (y + 25) ** 2) / (2 * 8.0**2))
    return h


def look_down_rotation(yaw_deg: float) -> np.ndarray:
    """World(ENU)-to-camera rotation of a nadir camera whose image top points at ``yaw`` (0 north)."""
    y = math.radians(yaw_deg)
    right = np.array([math.cos(y), -math.sin(y), 0.0])  # image +x
    forward_img_up = np.array([math.sin(y), math.cos(y), 0.0])  # image top
    down = np.array([0.0, 0.0, -1.0])  # optical axis +z
    return np.stack([right, -forward_img_up, down])  # rows: cam x, cam y (image down), cam z


def tilt(r: np.ndarray, pitch_deg: float) -> np.ndarray:
    """Tilt a nadir rotation forward by ``90 + pitch`` degrees (pitch -90 is nadir)."""
    a = math.radians(90 + pitch_deg)
    rx = np.array([[1, 0, 0], [0, math.cos(a), -math.sin(a)], [0, math.sin(a), math.cos(a)]])
    return rx @ r


@dataclass
class GcpTruth:
    id: str
    role: str
    enu: np.ndarray
    stated_error: np.ndarray = field(default_factory=lambda: np.zeros(3))


@dataclass
class SceneTruth:
    enu: C.EnuFrame
    camera: Camera
    names: list[str]
    centres: np.ndarray  # (n, 3) ENU
    rotations: np.ndarray  # (n, 3, 3) world-to-camera
    points: np.ndarray  # (m, 3) ENU tie points
    gcps: list[GcpTruth]
    gnss: np.ndarray  # (n, 3) ENU positions as the photos log them (noise added)
    gnss_sigma: tuple[float, float]
    altitude: float

    def lonlat_h(self, enu: np.ndarray):
        return self.enu.to_geodetic(enu)

    def observations(self, rng, noise_px=0.3):
        """Per image: (point indices, pixel positions) of the visible tie points."""
        obs = []
        for i in range(len(self.names)):
            uv, z = project_points(self.camera, self.rotations[i], self.centres[i], self.points)
            ok = (z > 0) & (uv[:, 0] >= 0) & (uv[:, 0] < self.camera.width) & (uv[:, 1] >= 0)
            ok &= uv[:, 1] < self.camera.height
            idx = np.nonzero(ok)[0]
            obs.append((idx, uv[idx] + rng.normal(0, noise_px, (len(idx), 2))))
        return obs

    def marks(self, rng, noise_px=0.5):
        """GCP marks: {gcp id: [(image name, (x, y))]} for every image that sees the target."""
        out: dict[str, list[tuple[str, tuple[float, float]]]] = {}
        for g in self.gcps:
            for i, name in enumerate(self.names):
                uv, z = project_points(self.camera, self.rotations[i], self.centres[i], g.enu[None])
                x, y = uv[0]
                if z[0] > 0 and 20 <= x < self.camera.width - 20 and 20 <= y < self.camera.height - 20:
                    n = rng.normal(0, noise_px, 2)
                    out.setdefault(g.id, []).append((name, (float(x + n[0]), float(y + n[1]))))
        return out


def make_scene(
    seed: int = 7,
    rows: int = 5,
    cols: int = 6,
    altitude: float = 60.0,
    overlap: tuple[float, float] = (0.8, 0.7),
    width: int = 800,
    height: int = 600,
    gnss_sigma: tuple[float, float] = (0.02, 0.03),
    points: int = 4000,
    bad_gcp: bool = False,
) -> SceneTruth:
    """A nadir grid over the synthetic ground, 20 MP-class geometry scaled to ``width`` pixels."""
    rng = np.random.default_rng(seed)
    f = 0.95 * width  # about 55 degrees horizontal field of view
    cam = Camera(
        1,
        "OPENCV",
        width,
        height,
        np.array([f, f * 1.0005, width / 2 + 3.1, height / 2 - 2.4, -0.06, 0.012, 0.0004, -0.0003]),
    )
    foot_w = altitude * width / f
    foot_h = altitude * height / f
    dx = foot_w * (1 - overlap[1])
    dy = foot_h * (1 - overlap[0])
    centres, rots, names = [], [], []
    for r in range(rows):
        for c in range(cols):
            x = (c - (cols - 1) / 2) * dx
            y = (r - (rows - 1) / 2) * dy
            yaw = 0.0 if r % 2 == 0 else 180.0
            z = altitude + float(ground_height(0, 0)) + rng.normal(0, 0.3)
            centres.append([x + rng.normal(0, 0.2), y + rng.normal(0, 0.2), z])
            rr = look_down_rotation(yaw + rng.normal(0, 1.0))
            rots.append(tilt(rr, -90 + rng.normal(0, 1.0)))
            names.append(f"IMG_{len(names) + 1:04d}.JPG")
    centres = np.array(centres)
    rots = np.array(rots)
    half_w = (cols - 1) / 2 * dx + foot_w / 2
    half_h = (rows - 1) / 2 * dy + foot_h / 2
    px = rng.uniform(-half_w, half_w, points)
    py = rng.uniform(-half_h, half_h, points)
    pts = np.stack([px, py, ground_height(px, py)], axis=1)
    gcp_xy = [
        ("GCP1", "control", -0.7, -0.7),
        ("GCP2", "control", 0.7, -0.7),
        ("GCP3", "control", 0.7, 0.7),
        ("GCP4", "control", -0.7, 0.7),
        ("GCP5", "control", 0.0, 0.05),
        ("CHK1", "check", -0.35, 0.0),
        ("CHK2", "check", 0.35, 0.0),
        ("CHK3", "check", 0.0, -0.45),
        ("CHK4", "check", 0.0, 0.45),
    ]
    if bad_gcp:
        gcp_xy.append(("GCP6", "control", 0.45, 0.4))
    gcps = []
    for gid, role, fx, fy in gcp_xy:
        x, y = fx * (half_w - foot_w / 2), fy * (half_h - foot_h / 2)
        g = GcpTruth(gid, role, np.array([x, y, float(ground_height(x, y))]))
        if gid == "GCP6":
            g.stated_error = np.array([0.6, -0.8, 0.0])  # the survey says 1 m off
        gcps.append(g)
    sig_h, sig_v = gnss_sigma
    gnss = centres + np.column_stack(
        [
            rng.normal(0, sig_h, len(centres)),
            rng.normal(0, sig_h, len(centres)),
            rng.normal(0, sig_v, len(centres)),
        ]
    )
    return SceneTruth(
        C.EnuFrame(SITE_LON, SITE_LAT, 0.0), cam, names, centres, rots, pts, gcps, gnss, gnss_sigma, altitude
    )


def write_scene_photos(
    scene: SceneTruth, folder: Path, rtk: bool = True, alt_offset: float = 0.0
) -> list[Path]:
    """JPEGs carrying each camera's logged GNSS position (flat pixels), heights off by ``alt_offset``."""
    lon, lat, h = scene.lonlat_h(scene.gnss)
    h = h + alt_offset
    out = []
    for i, name in enumerate(scene.names):
        yaw = 0.0 if (i // 6) % 2 == 0 else 180.0
        out.append(
            synthetic_jpeg(
                folder / name,
                lat=float(lat[i]),
                lon=float(lon[i]),
                alt=float(h[i]),
                rel=float(h[i]) - 0.0,
                yaw=yaw,
                pitch=-90.0,
                rtk_flag=50 if rtk else 16,
                rtk_std=(0.012, 0.012, 0.025) if rtk else None,
                size=(scene.camera.width, scene.camera.height),
                pixels=np.full((scene.camera.height, scene.camera.width, 3), 120, np.uint8),
                time=f"2026:01:02 10:{i // 60:02d}:{i % 60:02d}",
            )
        )
    return out


class SyntheticEngine:
    """The engine adapter of ``photo/colmap_io.py`` over a known scene (no images are matched).

    ``map`` returns the true reconstruction seen through an arbitrary similarity (scale, rotation,
    offset: SfM has no datum) with small pose noise and noisy keypoints, as a COLMAP text model.
    It fails to register the names in ``unregistered``.
    """

    name = "synthetic"

    def __init__(self, scene: SceneTruth, seed: int = 3, pose_noise=(0.03, 0.05), unregistered=()):
        self.scene = scene
        self.seed = seed
        self.pose_noise = pose_noise
        self.unregistered = set(unregistered)
        self.calls: list[str] = []
        self.pairs: list[tuple[str, str]] = []
        #: A cancel event to set in the middle of matching (once).
        self.cancel_in_match = None

    def versions(self) -> dict[str, str]:
        return {"engine": "synthetic"}

    def features(self, job, progress) -> dict:
        self.calls.append("features")
        for k in range(len(job.images)):
            job.check()
            progress((k + 1) / len(job.images), None)
        return {"images": len(job.images), "seconds": 0.0}

    def match(self, job, pairs, progress) -> dict:
        self.calls.append("match")
        self.pairs = pairs
        if self.cancel_in_match is not None:
            ev, self.cancel_in_match = self.cancel_in_match, None
            ev.set()  # as a person pressing Cancel (or a kill) in the middle of matching
            job.check()
        progress(1.0, None)
        return {"pairs": len(pairs), "verified": len(pairs)}

    def map(self, job, mapper, progress) -> dict:
        self.calls.append(f"map:{mapper}")
        sc = self.scene
        rng = np.random.default_rng(self.seed)
        # an arbitrary SfM frame: X_sfm = s * Q @ X_enu + t
        s = 0.37
        q, _ = np.linalg.qr(rng.normal(size=(3, 3)))
        if np.linalg.det(q) < 0:
            q[:, 0] *= -1
        t = rng.normal(0, 5, 3)
        name_to_index = {n: i for i, n in enumerate(sc.names)}
        model = SparseModel()
        cam = Camera(1, "OPENCV", sc.camera.width, sc.camera.height, sc.camera.params.copy())
        cam.params[0] *= 1.01  # self-calibration is not perfect
        cam.params[1] *= 1.01
        model.cameras[1] = cam
        obs = sc.observations(rng)
        point_tracks: dict[int, list[tuple[int, int]]] = {}
        image_id = 0
        for img_in in job.images:
            key = getattr(img_in, "name", img_in.key)  # the engine's own name for the photo
            name = key.split("/")[-1]
            if name in self.unregistered or name not in name_to_index:
                continue
            i = name_to_index[name]
            image_id += 1
            rot = sc.rotations[i]
            dr = rng.normal(0, math.radians(self.pose_noise[1]), 3)
            rot = _rodrigues(dr) @ rot
            centre = sc.centres[i] + rng.normal(0, self.pose_noise[0], 3)
            r_sfm = rot @ q.T
            c_sfm = s * q @ centre + t
            idx, uv = obs[i]
            img = MImage(image_id, key, 1, r_sfm, -r_sfm @ c_sfm, uv.copy(), np.full(len(idx), -1, np.int64))
            model.images[image_id] = img
            for k, p in enumerate(idx):
                point_tracks.setdefault(int(p), []).append((image_id, k))
        for p, track in point_tracks.items():
            if len(track) < 2:
                continue
            pid = p + 1
            xyz = s * q @ (sc.points[p] + rng.normal(0, 0.01, 3)) + t
            model.add_point(pid, xyz, (128, 128, 128), 0.5, track)
        progress(1.0, None)
        out = job.work / "sfm" / "0"
        model.write_text(out)
        return {"models": [{"path": str(out), "images": len(model.images)}], "mapper": mapper}


class FakeJob:
    """The parts of ``EngineJob`` the synthetic engine reads (model tests)."""

    def __init__(self, work: Path, names: list[str]):
        self.work = work
        self.images = [type("I", (), {"key": n, "name": n})() for n in names]

    def check(self):
        pass


def _rodrigues(w: np.ndarray) -> np.ndarray:
    th = float(np.linalg.norm(w))
    if th < 1e-12:
        return np.eye(3)
    k = w / th
    kx = np.array([[0, -k[2], k[1]], [k[2], 0, -k[0]], [-k[1], k[0], 0]])
    return np.eye(3) + math.sin(th) * kx + (1 - math.cos(th)) * kx @ kx


def write_gcp_files(
    scene: SceneTruth, project: Path, run: str, seed: int = 11, noise_px: float = 0.5
) -> Path:
    """``gcp.json`` (aio.gcp/1) for the scene: surveyed in UTM 39N, marks confirmed by a person."""
    rng = np.random.default_rng(seed)
    marks = scene.marks(rng, noise_px)
    pts = []
    for g in scene.gcps:
        lon, lat, h = scene.lonlat_h((g.enu + g.stated_error)[None])
        e, n = C.geodetic_to_crs(32639, lon, lat)
        pts.append(
            {
                "id": g.id,
                "role": g.role,
                "xyz": [float(e[0]), float(n[0]), float(h[0])],
                "accuracy": {"horizontalM": 0.01, "verticalM": 0.02},
                "marks": [
                    {
                        "photo": name,
                        "px": [x, y],
                        "by": "person",
                        "at": "2026-10-07T09:00:00Z",
                        "state": "confirmed",
                    }
                    for name, (x, y) in marks.get(g.id, [])
                ],
            }
        )
    path = project / "photogrammetry" / run / "gcp.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"schema": "aio.gcp/1", "crs": {"epsg": 32639}, "points": pts}, indent=1))
    return path


# ------------------------------------------------------------------------------- rendered images


def _texture(rng, size=2048, metres=400.0):
    """Seeded multi-scale noise with sharp blobs: something SIFT can match, like real ground."""
    tex = np.zeros((size, size), np.float32)
    for octave, amp in ((8, 0.5), (32, 0.3), (128, 0.25), (512, 0.2)):
        small = rng.random((octave, octave)).astype(np.float32)
        img = Image.fromarray((small * 255).astype(np.uint8)).resize((size, size), Image.BICUBIC)
        tex += amp * (np.asarray(img, np.float32) / 255.0)
    # dots and strokes
    yy, xx = rng.integers(0, size, (2, 3000))
    rr = rng.integers(1, 5, 3000)
    for y, x, r in zip(yy, xx, rr, strict=True):
        tex[max(0, y - r) : y + r, max(0, x - r) : x + r] += rng.choice([-0.6, 0.6])
    tex -= tex.min()
    tex /= tex.max()
    rgb = np.stack([tex * 0.9 + 0.05, tex * 0.8 + 0.1, tex * 0.6 + 0.15], axis=-1)
    return (np.clip(rgb, 0, 1) * 255).astype(np.uint8), metres / size


def render_view(
    camera: Camera, rot: np.ndarray, centre: np.ndarray, tex: np.ndarray, m_per_px: float, ss: int = 2
):
    """Render the textured height field from one camera (inverse mapping with height iteration)."""
    from aio_pipelines.photo.model import undistort_pixels

    w, h = camera.width, camera.height
    xs = (np.arange(w * ss) + 0.5) / ss
    ys = (np.arange(h * ss) + 0.5) / ss
    gx, gy = np.meshgrid(xs, ys)
    uv = np.stack([gx.ravel(), gy.ravel()], axis=1)
    norm = undistort_pixels(camera, uv)
    rays_cam = np.column_stack([norm, np.ones(len(norm))])
    rays = rays_cam @ rot  # camera to world: R^T d
    zw = np.zeros(len(rays))
    for _ in range(12):  # fixed point: intersect with z = ground(x, y)
        t = (zw - centre[2]) / rays[:, 2]
        px = centre[0] + t * rays[:, 0]
        py = centre[1] + t * rays[:, 1]
        zw = ground_height(px, py)
    size = tex.shape[0]
    u = (px / m_per_px + size / 2) % size
    v = (-py / m_per_px + size / 2) % size
    u0 = np.floor(u).astype(int) % size
    v0 = np.floor(v).astype(int) % size
    fu = (u - np.floor(u))[:, None]
    fv = (v - np.floor(v))[:, None]
    u1 = (u0 + 1) % size
    v1 = (v0 + 1) % size
    col = (
        tex[v0, u0] * (1 - fu) * (1 - fv)
        + tex[v0, u1] * fu * (1 - fv)
        + tex[v1, u0] * (1 - fu) * fv
        + tex[v1, u1] * fu * fv
    )
    img = col.reshape(h * ss, w * ss, 3).reshape(h, ss, w, ss, 3).mean(axis=(1, 3))
    return np.clip(img, 0, 255).astype(np.uint8)


def render_nadir_set(scene: SceneTruth, folder: Path, seed: int = 5, rtk: bool = False) -> list[Path]:
    """Rendered JPEGs of the scene with EXIF and XMP; ``truth.json`` beside them."""
    rng = np.random.default_rng(seed)
    tex, mpp = _texture(rng)
    lon, lat, h = scene.lonlat_h(scene.gnss)
    paths = []
    focal35 = 36.0 * scene.camera.params[0] / scene.camera.width
    for i, name in enumerate(scene.names):
        img = render_view(scene.camera, scene.rotations[i], scene.centres[i], tex, mpp)
        yaw = 0.0 if (i // 6) % 2 == 0 else 180.0
        paths.append(
            synthetic_jpeg(
                folder / name,
                lat=float(lat[i]),
                lon=float(lon[i]),
                alt=float(h[i]),
                rel=float(h[i]),
                yaw=yaw,
                pitch=-90.0,
                rtk_flag=50 if rtk else None,
                rtk_std=(0.012, 0.012, 0.025) if rtk else None,
                size=(scene.camera.width, scene.camera.height),
                pixels=img,
                focal35=focal35,
                focal_mm=focal35 * 13.2 / 36.0,
                time=f"2026:01:02 10:{i // 60:02d}:{i % 60:02d}",
                quality=92,
            )
        )
    truth = {
        "enu": scene.enu.record(),
        "camera": {"model": scene.camera.model, "params": scene.camera.params.tolist()},
        "images": {
            n: {"centre": scene.centres[i].tolist(), "rotation": scene.rotations[i].tolist()}
            for i, n in enumerate(scene.names)
        },
        "gcps": {g.id: {"role": g.role, "enu": g.enu.tolist()} for g in scene.gcps},
    }
    (folder / "truth.json").write_text(json.dumps(truth))
    return paths
