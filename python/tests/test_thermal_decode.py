"""``thermal.decode``: radiometric photos of a layer to temperature rasters (thermal analysis M1).

Every photo is synthetic (``thermal_fixtures``); the DJI Thermal SDK is stubbed and ExifTool is
faked, except in the one test that runs the bundled ExifTool when it is present.
"""

from __future__ import annotations

import hashlib
import json
import os
import stat
import struct
from pathlib import Path
from typing import ClassVar

import numpy as np
import pytest

import thermal_fixtures as F
from aio_pipelines.pipelines import all_pipelines
from aio_pipelines.runtime import JobError
from aio_pipelines.thermal import crosscheck, raster
from aio_pipelines.thermal import pipeline as tp
from aio_pipelines.thermal.flir import read_flir
from aio_pipelines.thermal.pipeline import ThermalDecode
from conftest import run_job

LAYER = "lay-thermal"
RASTERS = Path("thermal") / "rasters" / LAYER
KEYS = {"decoded", "skipped", "unsupported", "unverified", "implausible"}
META_KEYS = {
    "schema",
    "width",
    "height",
    "family",
    "camera",
    "settings",
    "clamped",
    "minC",
    "maxC",
    "medianC",
    "decoder",
    "settingsKey",
}
SETTINGS_KEYS = {"emissivity", "distanceM", "airC", "humidityPct", "reflectedC"}


# ---------------------------------------------------------------------------- fixtures


def _settings(**kw) -> dict:
    s = {"emissivity": 0.95, "distanceM": 18.0, "airC": 25.0, "humidityPct": 50.0, "reflectedC": None}
    s.update(kw)
    return s


def _xmp(rel_alt: float) -> bytes:
    body = (
        '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">'
        '<rdf:Description xmlns:drone-dji="http://www.dji.com/drone-dji/1.0/" '
        f'drone-dji:RelativeAltitude="+{rel_alt:.2f}" drone-dji:AbsoluteAltitude="+512.40"/>'
        "</rdf:RDF></x:xmpmeta>"
    )
    return b"http://ns.adobe.com/xap/1.0/\x00" + body.encode()


def _with_xmp(path: Path, rel_alt: float) -> None:
    path.write_bytes(F.jpeg_with_app1(path.read_bytes(), [_xmp(rel_alt)]))


def _dji_jpeg(path: Path, model: str = "M3T") -> None:
    base = F.plain_jpeg(32, 24, "DJI", model)
    app3 = b"\xff\xe3" + struct.pack(">H", 18) + b"\x00" * 16
    path.write_bytes(base[:2] + app3 + base[2:])


class Project:
    def __init__(self, root: Path):
        self.root = root
        self.items: list[dict] = []
        (root / "photos").mkdir(parents=True, exist_ok=True)

    def photo(self, pid: str, **item) -> Path:
        self.items.append({"id": pid, "src": {"path": f"photos/{pid}.jpg"}, **item})
        return self.root / "photos" / f"{pid}.jpg"

    def flir(self, pid: str, temps=None, model: str = "XT2", **item) -> np.ndarray:
        t = F.field(16, 12, 0.0, 40.0) if temps is None else temps
        return F.make_flir_jpeg(self.photo(pid, **item), t, model=model)

    def save(self) -> Path:
        manifest = {
            "schema": "aio.project/1",
            "layers": [{"id": LAYER, "kind": "photos", "name": "Thermal", "items": self.items}],
        }
        (self.root / "manifest.json").write_text(json.dumps(manifest), "utf-8")
        return self.root

    def sidecar(self, defaults: dict | None = None, photos: dict | None = None) -> None:
        doc = {
            "schema": "aio.thermal/1",
            "photos": {f"{LAYER}/{k}": {"settings": v} for k, v in (photos or {}).items()},
            "readings": [],
            "hotspots": [],
        }
        if defaults is not None:
            doc["defaults"] = defaults
        (self.root / "thermal").mkdir(exist_ok=True)
        (self.root / "thermal" / "thermal.json").write_text(json.dumps(doc), "utf-8")


@pytest.fixture
def tools(monkeypatch):
    """The native tools the job sees: none unless a test names them."""
    found: dict[str, str | None] = {"exiftool": None, "dji_tsdk": None}
    monkeypatch.setattr(tp, "find_tool", lambda name: found.get(name))
    return found


def decode(root: Path, job_id: str = "j1", **params):
    result, rec = run_job(ThermalDecode(), root, {"layerId": LAYER, **params}, job_id=job_id)
    assert result["status"] == "done"
    return result["outputs"]["decode"], rec


def index(root: Path) -> dict:
    return json.loads((root / RASTERS / "index.json").read_text("utf-8"))


def meta(root: Path, pid: str) -> dict:
    return json.loads((root / RASTERS / f"{pid}.json").read_text("utf-8"))


def temps(root: Path, pid: str) -> np.ndarray:
    m = meta(root, pid)
    data = np.fromfile(root / RASTERS / f"{pid}.f32", dtype="<f4")
    assert data.size == m["width"] * m["height"]
    return data.reshape(m["height"], m["width"])


def assert_meta_shape(m: dict) -> None:
    """The fields of ``ThermalRasterMeta`` in packages/schema/src/thermal.ts."""
    assert set(m) - {"constants"} == META_KEYS
    assert m["schema"] == "aio.thermalRaster/1"
    assert isinstance(m["width"], int) and m["width"] > 0
    assert isinstance(m["height"], int) and m["height"] > 0
    assert m["family"] in ("flir", "dji-tsdk")
    assert set(m["settings"]) == SETTINGS_KEYS
    assert all(isinstance(c, str) for c in m["clamped"])
    assert len(m["settingsKey"]) == 64 and all(c in "0123456789abcdef" for c in m["settingsKey"])
    assert m["minC"] <= m["medianC"] <= m["maxC"]
    for v in (m.get("constants") or {}).values():
        assert isinstance(v, float | int)


def counts(out: dict) -> dict:
    return {k: out[k] for k in KEYS}


# ---------------------------------------------------------------------------- registration


def test_the_pack_lists_thermal_decode():
    p = all_pipelines()["thermal.decode"]
    assert isinstance(p, ThermalDecode)
    assert p.title == "Decoding thermal photos"


def test_params_follow_thermal_decode_params():
    p = ThermalDecode()
    assert p.validate({"layerId": "lay-1"}) == {"layerId": "lay-1"}
    full = {"layerId": "lay-1", "photos": ["p1", "p2"], "force": True}
    assert p.validate(full) == full
    for bad in (
        {},
        {"layerId": ""},
        {"layerId": 3},
        {"layerId": "a/b"},
        {"layerId": "lay-1", "bogus": 1},
        {"layerId": "lay-1", "photos": "p1"},
        {"layerId": "lay-1", "photos": [""]},
        {"layerId": "lay-1", "photos": ["../x"]},
        {"layerId": "lay-1", "force": "yes"},
    ):
        with pytest.raises(JobError):
            p.validate(bad)


# ---------------------------------------------------------------------------- FLIR decode


def test_flir_photos_decode_to_rasters_with_their_settings(tmp_path, tools):
    pj = Project(tmp_path)
    pj.flir("p1")
    pj.flir("p2")
    root = pj.save()
    own = _settings(emissivity=0.9, distanceM=18.0)
    defaults = _settings()
    pj.sidecar(defaults=defaults, photos={"p1": own})

    out, rec = decode(root)
    assert counts(out) == {"decoded": 2, "skipped": 0, "unsupported": 0, "unverified": 0, "implausible": 0}

    for pid, s in (("p1", own), ("p2", defaults)):
        f32 = root / RASTERS / f"{pid}.f32"
        assert f32.stat().st_size == 16 * 12 * 4
        m = meta(root, pid)
        assert_meta_shape(m)
        assert (m["width"], m["height"], m["family"], m["camera"]) == (16, 12, "flir", "FLIR XT2")
        assert m["settings"] == s and m["clamped"] == []
        assert {"R1", "R2", "B", "F", "O"} <= set(m["constants"])
        src = root / "photos" / f"{pid}.jpg"
        st = src.stat()
        canonical = json.dumps(s, sort_keys=True, separators=(",", ":"))
        blob = f"{canonical}\n{m['decoder']}\n{st.st_size}\n{st.st_mtime_ns}"
        assert m["settingsKey"] == hashlib.sha256(blob.encode()).hexdigest()

    # the fixture was written with the default settings: they give the field back
    t2 = temps(root, "p2")
    assert np.allclose(t2, F.field(16, 12, 0.0, 40.0), atol=0.05)
    assert meta(root, "p2")["minC"] == pytest.approx(float(t2.min()))
    assert meta(root, "p2")["medianC"] == pytest.approx(float(np.median(t2)))
    # p1 was decoded with its own (lower) emissivity, so it reads differently
    assert abs(float(temps(root, "p1").mean()) - float(t2.mean())) > 0.2

    idx = index(root)
    assert idx["schema"] == "aio.thermalRaster/1"
    assert idx["photos"]["p1"]["status"] == "ok" and idx["photos"]["p2"]["status"] == "ok"
    assert idx["crosscheck"] == "skipped"  # no ExifTool in this run
    assert any(a["path"] == RASTERS.as_posix() for a in rec.of("artifact"))
    assert not (root / "jobs" / "j1" / "staging" / "rasters" / "p1.f32").exists()


def test_design_defaults_take_the_distance_from_the_height_above_take_off(tmp_path, tools):
    pj = Project(tmp_path)
    pj.flir("xmp")
    pj.flir("item", dji={"relAlt": 42.5})
    pj.flir("none", pos=[1.0, 60.0, 2.0])  # a height, but no take-off height to subtract
    _with_xmp(tmp_path / "photos" / "xmp.jpg", 35.2)
    root = pj.save()
    decode(root)
    base = {"emissivity": 0.95, "airC": 25.0, "humidityPct": 50.0, "reflectedC": None}
    assert meta(root, "xmp")["settings"] == {**base, "distanceM": 35.2}
    assert meta(root, "item")["settings"] == {**base, "distanceM": 42.5}
    assert meta(root, "none")["settings"] == {**base, "distanceM": 10.0}


def test_file_defaults_win_over_the_design_defaults(tmp_path, tools):
    pj = Project(tmp_path)
    pj.flir("p1")
    _with_xmp(tmp_path / "photos" / "p1.jpg", 35.2)
    root = pj.save()
    pj.sidecar(defaults=_settings(distanceM=7.0, airC=30.0))
    decode(root)
    assert meta(root, "p1")["settings"] == _settings(distanceM=7.0, airC=30.0)


def test_unchanged_photos_are_skipped_and_changed_ones_decoded_again(tmp_path, tools):
    pj = Project(tmp_path)
    for pid in ("p1", "p2", "p3"):
        pj.flir(pid)
    root = pj.save()
    pj.sidecar(defaults=_settings())
    decode(root, "j1")
    before = {pid: (root / RASTERS / f"{pid}.f32").stat().st_mtime_ns for pid in ("p1", "p2", "p3")}

    out, _ = decode(root, "j2")
    assert counts(out) == {"decoded": 0, "skipped": 3, "unsupported": 0, "unverified": 0, "implausible": 0}
    for pid, t in before.items():
        assert (root / RASTERS / f"{pid}.f32").stat().st_mtime_ns == t

    pj.sidecar(defaults=_settings(), photos={"p2": _settings(emissivity=0.8)})
    out, _ = decode(root, "j3")
    assert (out["decoded"], out["skipped"]) == (1, 2)
    assert meta(root, "p2")["settings"]["emissivity"] == 0.8
    assert (root / RASTERS / "p1.f32").stat().st_mtime_ns == before["p1"]
    assert set(index(root)["photos"]) == {"p1", "p2", "p3"}

    out, _ = decode(root, "j4", force=True)
    assert (out["decoded"], out["skipped"]) == (3, 0)


def test_a_photo_list_decodes_only_those_photos(tmp_path, tools):
    pj = Project(tmp_path)
    for pid in ("p1", "p2"):
        pj.flir(pid)
    root = pj.save()
    out, _ = decode(root, photos=["p2"])
    assert out["decoded"] == 1
    assert not (root / RASTERS / "p1.f32").exists()
    assert set(index(root)["photos"]) == {"p2"}
    with pytest.raises(JobError, match="p9"):
        run_job(ThermalDecode(), root, {"layerId": LAYER, "photos": ["p9"]}, job_id="j2")


def test_visual_and_non_thermal_photos_are_unsupported(tmp_path, tools):
    pj = Project(tmp_path)
    pj.photo("visual").write_bytes(F.plain_jpeg(64, 48, "FLIR", "XT2"))
    pj.photo("camera").write_bytes(F.plain_jpeg(64, 48, "Canon", "EOS"))
    pj.flir("ok")
    root = pj.save()
    out, _ = decode(root)
    assert counts(out) == {"decoded": 1, "skipped": 0, "unsupported": 2, "unverified": 0, "implausible": 0}
    photos = index(root)["photos"]
    for pid in ("visual", "camera"):
        assert photos[pid]["status"] == "unsupported"
        assert photos[pid]["reason"]
        assert not (root / RASTERS / f"{pid}.f32").exists()
        assert not (root / RASTERS / f"{pid}.json").exists()
    # unsupported photos are remembered too, so a second run skips them
    out, _ = decode(root, "j2")
    assert out["skipped"] == 3


def test_an_unknown_layer_fails_the_job(tmp_path, tools):
    root = Project(tmp_path).save()
    with pytest.raises(JobError, match="lay-x"):
        run_job(ThermalDecode(), root, {"layerId": "lay-x"})


# ---------------------------------------------------------------------------- cross-check


def _fake_exiftool(monkeypatch, off_by_one: set[str]):
    """ExifTool as a function of its arguments: the photo's raw image (a TIFF, as ExifTool
    extracts an XT2's words) and its constants; one pixel differs for the models (or photo names) named."""
    calls: list[list[str]] = []

    def run(exe: str, args: list[str]) -> bytes:
        calls.append(args)
        rec = read_flir(Path(args[-1]))
        assert rec is not None
        if "-j" in args:
            p, a = rec.planck, rec.atmos
            return json.dumps(
                [
                    {
                        "Make": rec.make,
                        "Model": rec.model,
                        "RawThermalImageWidth": rec.raw.shape[1],
                        "RawThermalImageHeight": rec.raw.shape[0],
                        "PlanckR1": p.r1,
                        "PlanckR2": p.r2,
                        "PlanckB": p.b,
                        "PlanckF": p.f,
                        "PlanckO": p.o,
                        "AtmosphericTransAlpha1": str(a.alpha1),  # ExifTool quotes some of these
                        "AtmosphericTransAlpha2": a.alpha2,
                        "AtmosphericTransBeta1": str(a.beta1),
                        "AtmosphericTransBeta2": str(a.beta2),
                        "AtmosphericTransX": a.x,
                    }
                ]
            ).encode()
        raw = rec.raw.copy()
        if rec.model in off_by_one or Path(args[-1]).stem in off_by_one:
            raw[3, 5] += 1
        return F.tiff16(raw)

    monkeypatch.setattr(crosscheck, "_run", run)
    return calls


def test_a_raw_image_that_differs_from_exiftool_leaves_that_model_unverified(tmp_path, tools, monkeypatch):
    tools["exiftool"] = str(tmp_path / "exiftool.exe")
    calls = _fake_exiftool(monkeypatch, off_by_one={"XT2"})
    pj = Project(tmp_path)
    pj.flir("a1")
    pj.flir("a2")
    pj.flir("b1", model="A65")
    root = pj.save()
    out, _ = decode(root)
    assert counts(out) == {"decoded": 1, "skipped": 0, "unsupported": 0, "unverified": 2, "implausible": 0}
    photos = index(root)["photos"]
    for pid in ("a1", "a2"):
        assert photos[pid]["status"] == "unverified"
        assert "ExifTool" in photos[pid]["reason"]
        assert not (root / RASTERS / f"{pid}.f32").exists()
        assert not (root / RASTERS / f"{pid}.json").exists()
    assert photos["b1"]["status"] == "ok"
    assert index(root)["crosscheck"] == "failed"
    # the first photo of each model only
    checked = {Path(c[-1]).stem for c in calls}
    assert checked == {"a1", "b1"}


def test_a_matching_exiftool_verifies_the_photos(tmp_path, tools, monkeypatch):
    tools["exiftool"] = str(tmp_path / "exiftool.exe")
    _fake_exiftool(monkeypatch, off_by_one=set())
    pj = Project(tmp_path)
    pj.flir("a1")
    root = pj.save()
    out, _ = decode(root)
    assert out["decoded"] == 1
    assert index(root)["crosscheck"] == "ok"


def test_a_failing_exiftool_leaves_the_model_unverified(tmp_path, tools, monkeypatch):
    tools["exiftool"] = str(tmp_path / "exiftool.exe")

    def broken(exe, args):
        raise crosscheck.CrosscheckError("ExifTool stopped with exit code 1.")

    monkeypatch.setattr(crosscheck, "_run", broken)
    pj = Project(tmp_path)
    pj.flir("a1")
    root = pj.save()
    out, _ = decode(root)
    assert out["unverified"] == 1
    assert "ExifTool" in index(root)["photos"]["a1"]["reason"]


EXIFTOOL = os.environ.get("QUADRION_EXIFTOOL")


@pytest.mark.skipif(not (EXIFTOOL and Path(EXIFTOOL).is_file()), reason="the bundled ExifTool is not here")
@pytest.mark.parametrize("raw_format", ["plain", "png", "tiff"])
def test_the_bundled_exiftool_agrees_with_the_decoder(tmp_path, raw_format):
    p = tmp_path / "x.jpg"
    F.make_flir_jpeg(p, F.field(16, 12, 0.0, 40.0), raw_format=raw_format)
    rec = read_flir(p)
    assert rec is not None
    assert crosscheck.check(str(EXIFTOOL), p, rec) is None


# ---------------------------------------------------------------------------- plausibility


def test_an_implausible_median_gets_no_raster(tmp_path, tools):
    pj = Project(tmp_path)
    pj.flir("hot", temps=F.field(16, 12, 140.0, 160.0))
    pj.flir("ok")
    root = pj.save()
    out, _ = decode(root)
    assert (out["implausible"], out["decoded"]) == (1, 1)
    e = index(root)["photos"]["hot"]
    assert e["status"] == "implausible" and "median" in e["reason"]
    assert not (root / RASTERS / "hot.f32").exists()


def test_plausibility_bounds():
    ok = np.full((4, 4), 20.0, dtype=np.float32)
    assert raster.implausible(ok) is None
    hot = ok.copy()
    hot[0, 0] = 1000.5
    assert "1000" in (raster.implausible(hot) or "")
    cold = ok.copy()
    cold[0, 0] = -70.5
    assert "-70" in (raster.implausible(cold) or "")
    assert raster.implausible(np.full((4, 4), -41.0, dtype=np.float32))
    assert raster.implausible(np.full((4, 4), 80.5, dtype=np.float32))
    assert raster.implausible(np.full((4, 4), np.nan, dtype=np.float32))
    some_nan = ok.copy()
    some_nan[1, 1] = np.nan
    assert raster.implausible(some_nan) is None


def test_a_formula_refusal_marks_the_photo_unverified(tmp_path, tools, monkeypatch):
    def refuse(*a, **k):
        raise ValueError("atmospheric transmission 1.4 is outside (0, 1]")

    monkeypatch.setattr(tp, "to_celsius", refuse)
    pj = Project(tmp_path)
    pj.flir("p1")
    root = pj.save()
    out, _ = decode(root)
    assert out["unverified"] == 1
    e = index(root)["photos"]["p1"]
    assert e["status"] == "unverified" and "transmission" in e["reason"]
    assert not (root / RASTERS / "p1.f32").exists()


def test_invalid_sidecar_settings_mark_only_that_photo(tmp_path, tools):
    pj = Project(tmp_path)
    pj.flir("p1")
    pj.flir("p2")
    root = pj.save()
    pj.sidecar(photos={"p1": _settings(humidityPct=150.0)})
    out, _ = decode(root)
    assert (out["unverified"], out["decoded"]) == (1, 1)
    assert "humidity" in index(root)["photos"]["p1"]["reason"]


# ---------------------------------------------------------------------------- DJI


class FakeTsdk:
    instances: ClassVar[list[FakeTsdk]] = []

    def __init__(self, dll_dir):
        self.dll_dir = dll_dir
        self.seen: list = []
        FakeTsdk.instances.append(self)

    def measure(self, path, settings):
        self.seen.append((Path(path).name, settings))
        t = np.full((24, 32), 21.0, dtype=np.float32)
        t[5, 7] = 48.0
        return t


def test_dji_photos_go_through_the_sdk_with_clamped_settings(tmp_path, tools, monkeypatch):
    tools["dji_tsdk"] = str(tmp_path / "sdk")
    FakeTsdk.instances.clear()
    monkeypatch.setattr(tp, "Tsdk", FakeTsdk)
    pj = Project(tmp_path)
    _dji_jpeg(pj.photo("d1"))
    root = pj.save()
    pj.sidecar(photos={"d1": _settings(distanceM=40.0, humidityPct=10.0)})
    out, _ = decode(root)
    assert out["decoded"] == 1
    (sdk,) = FakeTsdk.instances
    assert sdk.dll_dir == str(tmp_path / "sdk")
    name, used = sdk.seen[0]
    assert name == "d1.jpg" and used.distance_m == 25.0 and used.humidity_pct == 20.0
    m = meta(root, "d1")
    assert_meta_shape(m)
    assert m["family"] == "dji-tsdk" and m["camera"] == "DJI M3T"
    assert sorted(m["clamped"]) == ["distanceM", "humidityPct"]
    assert m["settings"]["distanceM"] == 25.0 and m["settings"]["humidityPct"] == 20.0
    assert m["maxC"] == 48.0 and m["medianC"] == 21.0
    assert "constants" not in m
    # the key is of the settings asked for, so an unchanged sidecar skips the photo next time
    out, _ = decode(root, "j2")
    assert out["skipped"] == 1


def test_dji_photos_without_the_sdk_are_unsupported(tmp_path, tools):
    pj = Project(tmp_path)
    _dji_jpeg(pj.photo("d1"))
    root = pj.save()
    out, _ = decode(root)
    assert out["unsupported"] == 1
    assert "DJI Thermal SDK" in index(root)["photos"]["d1"]["reason"]


def test_dji_photos_left_unread_for_want_of_the_sdk_decode_once_it_is_there(tmp_path, tools, monkeypatch):
    pj = Project(tmp_path)
    _dji_jpeg(pj.photo("d1"))
    root = pj.save()
    out, _ = decode(root, "j1")
    assert out["unsupported"] == 1
    # still no SDK: nothing to try again
    out, _ = decode(root, "j2")
    assert out["skipped"] == 1

    # the SDK is installed but will not load: tried, still unsupported
    tools["dji_tsdk"] = str(tmp_path / "sdk")

    class Unloadable(FakeTsdk):
        def __init__(self, dll_dir):
            raise OSError("the library could not be loaded")

    monkeypatch.setattr(tp, "Tsdk", Unloadable)
    out, _ = decode(root, "j3")
    assert out["unsupported"] == 1
    assert "could not be loaded" in index(root)["photos"]["d1"]["reason"]

    # once it loads, the photo is read
    FakeTsdk.instances.clear()
    monkeypatch.setattr(tp, "Tsdk", FakeTsdk)
    out, _ = decode(root, "j4")
    assert (out["decoded"], out["skipped"]) == (1, 0)
    assert index(root)["photos"]["d1"]["status"] == "ok"
    out, _ = decode(root, "j5")
    assert out["skipped"] == 1


# ---------------------------------------------------------------------------- read-only


def test_a_read_only_project_fails_with_a_clear_error(tmp_path, tools, monkeypatch):
    monkeypatch.setattr("aio_pipelines.runtime._REPLACE_WAITS_S", ())
    pj = Project(tmp_path)
    pj.flir("p1")
    root = pj.save()
    decode(root)
    locked = [root / RASTERS / n for n in ("p1.f32", "p1.json", "index.json")]
    for f in locked:
        os.chmod(f, stat.S_IREAD)
    try:
        with pytest.raises(JobError, match="read-only"):
            run_job(ThermalDecode(), root, {"layerId": LAYER, "force": True}, job_id="j2")
    finally:
        for f in locked:
            os.chmod(f, stat.S_IREAD | stat.S_IWRITE)


# ---------------------------------------------------------------------------- review round 1


@pytest.mark.skipif(not (EXIFTOOL and Path(EXIFTOOL).is_file()), reason="the bundled ExifTool is not here")
def test_the_bundled_exiftool_reads_a_non_ascii_path(tmp_path):
    folder = tmp_path / "Wärme ü 熱 ñ"
    folder.mkdir()
    p = folder / "Bild é.jpg"
    F.make_flir_jpeg(p, F.field(16, 12, 0.0, 40.0))
    rec = read_flir(p)
    assert rec is not None
    assert crosscheck.check(str(EXIFTOOL), p, rec) is None


def test_photos_decoded_without_exiftool_are_checked_once_it_is_there(tmp_path, tools, monkeypatch):
    pj = Project(tmp_path)
    pj.flir("p1")
    root = pj.save()
    decode(root, "j1")
    assert index(root)["crosscheck"] == "skipped"

    tools["exiftool"] = str(tmp_path / "exiftool.exe")
    calls = _fake_exiftool(monkeypatch, off_by_one=set())
    out, _ = decode(root, "j2")
    assert (out["decoded"], out["skipped"]) == (1, 0)
    assert calls and index(root)["crosscheck"] == "ok"

    out, _ = decode(root, "j3")
    assert (out["decoded"], out["skipped"]) == (0, 1)


def test_an_exiftool_failure_is_tried_again_but_a_mismatch_stays(tmp_path, tools, monkeypatch):
    tools["exiftool"] = str(tmp_path / "exiftool.exe")

    def broken(exe, args):
        raise crosscheck.CrosscheckError("ExifTool could not be run: timed out")

    monkeypatch.setattr(crosscheck, "_run", broken)
    pj = Project(tmp_path)
    pj.flir("p1")
    pj.flir("m1", model="A65")
    root = pj.save()
    out, _ = decode(root, "j1")
    assert out["unverified"] == 2

    # both are tried again: p1 now agrees, m1 genuinely disagrees
    _fake_exiftool(monkeypatch, off_by_one={"A65"})
    out, _ = decode(root, "j2")
    assert out["skipped"] == 0
    assert index(root)["photos"]["p1"]["status"] == "ok"
    assert index(root)["photos"]["m1"]["status"] == "unverified"

    # a mismatch is kept until the settings change or force
    _fake_exiftool(monkeypatch, off_by_one=set())
    out, _ = decode(root, "j3")
    assert out["skipped"] == 2
    assert index(root)["photos"]["m1"]["status"] == "unverified"
    decode(root, "j4", force=True)
    assert index(root)["photos"]["m1"]["status"] == "ok"


def test_photos_without_a_camera_name_are_checked_one_by_one(tmp_path, tools, monkeypatch):
    tools["exiftool"] = str(tmp_path / "exiftool.exe")
    calls = _fake_exiftool(monkeypatch, off_by_one={"e1"})
    pj = Project(tmp_path)
    F.make_flir_jpeg(pj.photo("e1"), F.field(16, 12, 0.0, 40.0), model="", make="")
    F.make_flir_jpeg(pj.photo("e2"), F.field(16, 12, 0.0, 40.0), model="", make="")
    root = pj.save()
    decode(root)
    photos = index(root)["photos"]
    assert photos["e1"]["status"] == "unverified" and photos["e2"]["status"] == "ok"
    assert {Path(c[-1]).stem for c in calls} == {"e1", "e2"}


def test_an_sdk_failure_marks_only_that_photo(tmp_path, tools, monkeypatch):
    tools["dji_tsdk"] = str(tmp_path / "sdk")

    class Flaky(FakeTsdk):
        def measure(self, path, settings):
            if Path(path).stem == "d1":
                raise OSError("access violation reading the photo")
            return super().measure(path, settings)

    monkeypatch.setattr(tp, "Tsdk", Flaky)
    pj = Project(tmp_path)
    _dji_jpeg(pj.photo("d1"))
    _dji_jpeg(pj.photo("d2"))
    root = pj.save()
    out, _ = decode(root)
    assert (out["unsupported"], out["decoded"]) == (1, 1)
    assert "DJI Thermal SDK" in index(root)["photos"]["d1"]["reason"]


def test_photos_gone_from_the_layer_leave_the_index_and_their_rasters_go(tmp_path, tools):
    pj = Project(tmp_path)
    pj.flir("p1")
    pj.flir("p2")
    root = pj.save()
    decode(root, "j1")
    pj.items = [i for i in pj.items if i["id"] != "p2"]
    pj.save()
    decode(root, "j2")
    assert set(index(root)["photos"]) == {"p1"}
    assert not (root / RASTERS / "p2.f32").exists()
    assert not (root / RASTERS / "p2.json").exists()


def test_an_ok_raster_that_turns_implausible_or_unverified_is_deleted(tmp_path, tools, monkeypatch):
    pj = Project(tmp_path)
    pj.flir("p1")
    pj.flir("p2")
    root = pj.save()
    decode(root, "j1")
    for pid in ("p1", "p2"):
        assert (root / RASTERS / f"{pid}.f32").exists()

    real = tp.to_celsius

    def hot_at_half(raw, planck, atmos, settings):
        t = real(raw, planck, atmos, settings)
        return t + 150.0 if settings.emissivity == 0.5 else t

    monkeypatch.setattr(tp, "to_celsius", hot_at_half)
    pj.sidecar(photos={"p1": _settings(emissivity=0.5)})
    decode(root, "j2")
    assert index(root)["photos"]["p1"]["status"] == "implausible"
    assert not (root / RASTERS / "p1.f32").exists()
    assert not (root / RASTERS / "p1.json").exists()
    assert (root / RASTERS / "p2.f32").exists()

    tools["exiftool"] = str(tmp_path / "exiftool.exe")
    _fake_exiftool(monkeypatch, off_by_one={"p2"})
    decode(root, "j3", photos=["p2"], force=True)
    assert index(root)["photos"]["p2"]["status"] == "unverified"
    assert not (root / RASTERS / "p2.f32").exists()
    assert not (root / RASTERS / "p2.json").exists()


def test_a_photo_behind_a_junction_out_of_the_project_is_not_read(tmp_path):
    project = tmp_path / "project"
    (project / "photos").mkdir(parents=True)
    (project / "photos" / "in.jpg").write_bytes(b"x")
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "secret.jpg").write_bytes(b"secret")
    link = project / "escape"
    if os.name == "nt":
        import _winapi

        _winapi.CreateJunction(str(outside), str(link))
    else:
        link.symlink_to(outside, target_is_directory=True)
    assert tp._photo_path(project, {"src": {"path": "photos/in.jpg"}}) == project / "photos" / "in.jpg"
    assert tp._photo_path(project, {"src": {"path": "escape/secret.jpg"}}) is None
    assert tp._photo_path(project, {"src": {"path": "../outside/secret.jpg"}}) is None
