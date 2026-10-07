"""Synthetic fixtures only: no client data is ever committed."""

from __future__ import annotations

import io
import math
import struct
import threading
from pathlib import Path

import numpy as np
import pytest
from PIL import Image
from PIL.TiffImagePlugin import IFDRational

from aio_pipelines.runtime import Job
from photo_synth import photo_mini, photo_set, photo_set_factory, photo_set_rtk  # noqa: F401  (M10 fixtures)

RE = 6378137.0


class Recorder:
    def __init__(self):
        self.messages = []

    def __call__(self, method, params):
        self.messages.append((method, params))

    def of(self, method):
        return [p for m, p in self.messages if m == method]


def run_job(pipeline, project, params, job_id="j1", cancel=None):
    rec = Recorder()
    job = Job(job_id, pipeline, project, params, rec, cancel or threading.Event())
    return job.run(), rec


def _rational(x, den=10000):
    return IFDRational(round(x * den), den)


def _dms(deg):
    d = int(deg)
    m = int((deg - d) * 60)
    s = (deg - d - m / 60) * 3600
    return (IFDRational(d, 1), IFDRational(m, 1), _rational(s))


def drone_jpeg(
    path: Path,
    lat: float,
    lon: float,
    alt: float,
    yaw: float | None = None,
    pitch: float | None = None,
    roll: float | None = None,
    size=(4000, 3000),
    focal35: float = 24,
    rel: float | None = None,
):
    """A JPEG with EXIF GPS and focal length and, optionally, a DJI XMP packet with gimbal angles."""
    img = Image.new("RGB", size, (90, 110, 130))
    exif = Image.Exif()
    exif[306] = "2026:01:02 10:00:00"
    sub = exif.get_ifd(0x8769)
    sub[41989] = int(focal35)
    sub[37386] = _rational(8.8)
    gps = exif.get_ifd(0x8825)
    gps[1] = "N" if lat >= 0 else "S"
    gps[2] = _dms(abs(lat))
    gps[3] = "E" if lon >= 0 else "W"
    gps[4] = _dms(abs(lon))
    gps[5] = 0
    gps[6] = _rational(alt, 100)
    buf = io.BytesIO()
    img.save(buf, "JPEG", exif=exif.tobytes(), quality=70)
    data = buf.getvalue()
    if yaw is not None:
        attrs = f'drone-dji:GimbalYawDegree="{yaw:+.1f}" drone-dji:GimbalPitchDegree="{(pitch or 0):+.1f}"'
        attrs += f' drone-dji:GimbalRollDegree="{(roll or 0):+.1f}" drone-dji:AbsoluteAltitude="{alt:+.2f}"'
        if rel is not None:
            attrs += f' drone-dji:RelativeAltitude="{rel:+.2f}"'
        xmp = (
            '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">'
            f'<rdf:Description xmlns:drone-dji="http://www.dji.com/drone-dji/1.0/" {attrs}/></rdf:RDF></x:xmpmeta>'
        ).encode()
        payload = b"http://ns.adobe.com/xap/1.0/\x00" + xmp
        seg = b"\xff\xe1" + struct.pack(">H", len(payload) + 2) + payload
        data = data[:2] + seg + data[2:]
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return path


def offset_latlon(lat0, lon0, north_m, east_m):
    return lat0 + math.degrees(north_m / RE), lon0 + math.degrees(
        east_m / (RE * math.cos(math.radians(lat0)))
    )


@pytest.fixture
def project(tmp_path):
    p = tmp_path / "project"
    p.mkdir()
    return p


def cylinder_glb(path: Path, radius=2.0, height=20.0):
    """A closed cylinder standing on the ground at the origin, Y up (the kit's model frame)."""
    import trimesh

    m = trimesh.creation.cylinder(radius=radius, height=height, sections=48)
    # trimesh cylinders run along Z and are centred: stand it up on Y with its base at y=0
    m.apply_transform(trimesh.transformations.rotation_matrix(-math.pi / 2, [1, 0, 0]))
    m.apply_translation([0, height / 2, 0])
    scene = trimesh.Scene()
    scene.add_geometry(m, node_name="stack_shell", geom_name="stack_shell")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(scene.export(file_type="glb"))
    return path


def write_dsm(path: Path, z: np.ndarray, x0: float, y1: float, res: float, nodata=-10000.0):
    import rasterio
    from rasterio.transform import from_origin

    path.parent.mkdir(parents=True, exist_ok=True)
    with rasterio.open(
        path,
        "w",
        driver="GTiff",
        height=z.shape[0],
        width=z.shape[1],
        count=1,
        dtype="float32",
        crs="EPSG:32639",
        transform=from_origin(x0, y1, res, res),
        nodata=nodata,
    ) as d:
        d.write(np.where(np.isnan(z), nodata, z).astype(np.float32), 1)
    return path
