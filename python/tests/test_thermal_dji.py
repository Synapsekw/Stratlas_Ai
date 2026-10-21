"""DJI Thermal SDK binding: clamping, the ctypes call sequence (stubbed) and R-JPEG detection."""

from __future__ import annotations

import ctypes
import struct
from pathlib import Path

import numpy as np
import pytest

from aio_pipelines.thermal import dji_tsdk
from aio_pipelines.thermal.dji_tsdk import (
    TSDK_MODELS,
    Tsdk,
    TsdkError,
    clamp_for_tsdk,
    is_dji_rjpeg,
)
from aio_pipelines.thermal.physics import ThermalSettingsPy


def _settings(**kw) -> ThermalSettingsPy:
    base = dict(emissivity=0.95, distance_m=10.0, air_c=20.0, humidity_pct=50.0, reflected_c=None)
    base.update(kw)
    return ThermalSettingsPy(**base)


def test_clamp_far_distance():
    out, names = clamp_for_tsdk(_settings(distance_m=40.0))
    assert out.distance_m == 25.0
    assert names == ["distanceM"]


def test_clamp_inside_ranges_unchanged():
    s = _settings(reflected_c=30.0)
    out, names = clamp_for_tsdk(s)
    assert out == s
    assert names == []


def test_clamp_all_fields():
    s = _settings(emissivity=0.01, distance_m=0.2, humidity_pct=5.0, air_c=120.0, reflected_c=900.0)
    out, names = clamp_for_tsdk(s)
    assert (out.emissivity, out.distance_m, out.humidity_pct) == (0.10, 1.0, 20.0)
    assert (out.air_c, out.reflected_c) == (80.0, 500.0)
    assert set(names) == {"emissivity", "distanceM", "humidityPct", "airC", "reflectedC"}


def test_models_include_known():
    for m in ("H20T", "H20N", "H30T", "M30T", "M2EA", "M3T", "M3TD", "M4T"):
        assert m in TSDK_MODELS


class _FakeLib:
    """A ctypes-like stand-in recording the calls a real libdirp would get."""

    def __init__(self, fail: str | None = None, shape=(2, 3)):
        self.calls: list[str] = []
        self.fail = fail
        self.shape = shape
        self.params = None

    def _rc(self, name: str) -> int:
        self.calls.append(name)
        return -3 if self.fail == name else 0

    def dirp_create_from_rjpeg(self, data, size, ph):
        ph.contents.value = 1234
        return self._rc("create")

    def dirp_get_rjpeg_resolution(self, h, res):
        res.contents.height, res.contents.width = self.shape
        return self._rc("resolution")

    def dirp_set_measurement_params(self, h, p):
        c = p.contents
        self.params = (c.distance, c.humidity, c.emissivity, c.reflection, c.ambient_temp)
        return self._rc("params")

    def dirp_measure_ex(self, h, buf, size):
        n = size // 4
        arr = (ctypes.c_float * n).from_address(ctypes.addressof(buf.contents))
        for i in range(n):
            arr[i] = float(i)
        return self._rc("measure")

    def dirp_destroy(self, h):
        return self._rc("destroy")


def _tsdk_with(lib: _FakeLib, monkeypatch) -> Tsdk:
    monkeypatch.setattr(dji_tsdk, "_load", lambda dll_dir: lib)
    return Tsdk(Path("."))


def test_measure_passes_clamped_params(tmp_path, monkeypatch):
    f = tmp_path / "a.jpg"
    f.write_bytes(b"\xff\xd8fake")
    lib = _FakeLib()
    out = _tsdk_with(lib, monkeypatch).measure(f, _settings(distance_m=40.0, air_c=22.0))
    assert out.dtype == np.float32 and out.shape == (2, 3)
    assert out.ravel().tolist() == [0, 1, 2, 3, 4, 5]
    # reflected None means the air temperature
    assert lib.params == (25.0, 50.0, pytest.approx(0.95), 22.0, 22.0)
    assert lib.calls == ["create", "resolution", "params", "measure", "destroy"]


@pytest.mark.parametrize("stage", ["resolution", "params", "measure"])
def test_error_maps_to_tsdk_error_and_destroys(tmp_path, monkeypatch, stage):
    f = tmp_path / "a.jpg"
    f.write_bytes(b"\xff\xd8fake")
    lib = _FakeLib(fail=stage)
    with pytest.raises(TsdkError) as ei:
        _tsdk_with(lib, monkeypatch).measure(f, _settings())
    assert ei.value.code == -3
    assert lib.calls[-1] == "destroy"


def test_create_failure_has_no_handle_to_destroy(tmp_path, monkeypatch):
    f = tmp_path / "a.jpg"
    f.write_bytes(b"\xff\xd8fake")
    lib = _FakeLib(fail="create")
    with pytest.raises(TsdkError):
        _tsdk_with(lib, monkeypatch).measure(f, _settings())
    assert "destroy" not in lib.calls


def _head(model: str, app3: bool = True, make: str = "drone-dji") -> bytes:
    xmp = (
        f'<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:Description xmlns:{make}="http://www.dji.com/" '
        f'Model="{model}"/></x:xmpmeta>'
    ).encode()
    payload = b"http://ns.adobe.com/xap/1.0/\x00" + xmp
    out = b"\xff\xd8" + b"\xff\xe1" + struct.pack(">H", len(payload) + 2) + payload
    if app3:
        t = b"\x00" * 16
        out += b"\xff\xe3" + struct.pack(">H", len(t) + 2) + t
    return out + b"\xff\xdb\x00\x04\x00\x00"


def test_is_dji_rjpeg_m30t():
    assert is_dji_rjpeg(_head("M30T")) == ("DJI", "M30T")


def test_is_dji_rjpeg_rejects_xt2_and_missing_app3():
    assert is_dji_rjpeg(_head("XT2", make="FLIR")) is None
    assert is_dji_rjpeg(_head("XT2")) is None
    assert is_dji_rjpeg(_head("M30T", app3=False)) is None
    assert is_dji_rjpeg(b"not a jpeg") is None


def test_clamp_rejects_non_finite():
    for bad in (float("nan"), float("inf")):
        with pytest.raises(ValueError):
            clamp_for_tsdk(_settings(distance_m=bad))
        with pytest.raises(ValueError):
            clamp_for_tsdk(_settings(reflected_c=bad))


@pytest.mark.parametrize("shape", [(0, 3), (2, 0), (-1, 3)])
def test_bad_resolution_raises_and_destroys(tmp_path, monkeypatch, shape):
    f = tmp_path / "a.jpg"
    f.write_bytes(b"\xff\xd8fake")
    lib = _FakeLib(shape=shape)
    with pytest.raises(TsdkError):
        _tsdk_with(lib, monkeypatch).measure(f, _settings())
    assert lib.calls[-1] == "destroy"
    assert "measure" not in lib.calls


def test_camera_model_is_not_the_model():
    assert is_dji_rjpeg(_head("M30T").replace(b'Model="M30T"', b'CameraModel="M30T"')) is None


def test_is_dji_rjpeg_exif_model_only():
    for end in ("<", ">"):
        tiff = (b"II*\x00" if end == "<" else b"MM\x00*") + struct.pack(end + "I", 8)
        model = b"M3TD\x00"
        entry = struct.pack(end + "HHI", 0x0110, 2, len(model))
        entry += struct.pack(end + "I", 8 + 2 + 12 + 4)
        tiff += struct.pack(end + "H", 1) + entry + struct.pack(end + "I", 0) + model
        payload = b"Exif\x00\x00" + tiff
        head = b"\xff\xd8\xff\xe1" + struct.pack(">H", len(payload) + 2) + payload
        head += b"\xff\xe3\x00\x12" + b"\x00" * 16 + b"\xff\xdb\x00\x04\x00\x00"
        assert is_dji_rjpeg(head) == ("DJI", "M3TD")


def test_tsdk_samples_match_sdk():
    """Acceptance 2: our measure equals dji_irp.exe byte for byte on the SDK's own samples."""
    import os
    import subprocess
    import tempfile

    from aio_pipelines.photo.native import find_tool

    try:
        folder = find_tool("dji_tsdk")
    except KeyError:
        folder = None
    dataset = os.environ.get("QUADRION_DJI_TSDK_DATASET")
    if not folder or not dataset or not Path(dataset).is_dir():
        pytest.skip("DJI Thermal SDK or QUADRION_DJI_TSDK_DATASET not available")
    sdk = Path(folder)
    exe = next(sdk.rglob("dji_irp.exe"), None)
    if exe is None:
        pytest.skip("dji_irp.exe not in the SDK folder")
    samples = sorted(Path(dataset).rglob("*_R.JPG"))
    if not samples:
        pytest.skip("no sample R-JPEG in the dataset folder")
    tsdk = Tsdk(sdk)
    s = _settings(emissivity=0.9, distance_m=8.0, humidity_pct=60.0, air_c=21.0, reflected_c=19.0)
    args = ["--distance", "8", "--humidity", "60", "--emissivity", "0.9"]
    args += ["--reflection", "19", "--ambient", "21"]
    for p in samples:
        with tempfile.TemporaryDirectory() as td:
            ref = Path(td) / "ref.raw"
            cmd = [str(exe), "-s", str(p), "-a", "measure", "-o", str(ref)]
            subprocess.run([*cmd, "--measurefmt", "float32", *args], check=True, cwd=sdk)
            assert tsdk.measure(p, s).tobytes() == ref.read_bytes(), p
