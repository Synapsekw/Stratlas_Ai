import json
import os
import signal
import socket
import subprocess
import sys
import time
from pathlib import Path

import numpy as np
import pytest
import rasterio

import products_synth as ps

FAKE = Path(__file__).parent / "fake_odm"


def _run(project_dir: Path, *flags: str, env: dict | None = None) -> subprocess.CompletedProcess:
    e = {**os.environ, "FAKE_ODM_PYTHON": sys.executable, **(env or {})}
    return subprocess.run(
        [sys.executable, str(FAKE / "fake_odm.py"), *flags, "--project-path", str(project_dir.parent), project_dir.name],
        env=e, capture_output=True, text=True, timeout=300,
    )  # fmt: skip


@pytest.fixture(scope="module")
def aligned(tmp_path_factory) -> Path:
    root = tmp_path_factory.mktemp("fake-odm")
    ps.write_project(root, ps.make_scene(step=0.2))
    return root / "photogrammetry" / ps.RUN / "odm"


def test_the_synthetic_project_carries_an_aligned_odm_folder(aligned):
    assert (aligned / "opensfm" / "reconstruction.topocentric.json").is_file()
    stats = json.loads((aligned / "opensfm" / "stats" / "stats.json").read_text())
    assert stats["reconstruction_statistics"]["reprojection_error_pixels"] > 0
    names = json.loads((aligned / "names.json").read_text())
    assert sorted(names) == sorted(p.name for p in (aligned / "images").iterdir())


def test_products_write_odms_layout(aligned, tmp_path):
    log = tmp_path / "args.jsonl"
    r = _run(aligned, "--pc-quality", "low", "--dsm", "--dtm", "--rerun-from", "openmvs",
             "--orthophoto-resolution", "20", "--dem-resolution", "40", env={"FAKE_ODM_ARGS_LOG": str(log)})  # fmt: skip
    assert r.returncode == 0, r.stdout + r.stderr
    assert "Finished odm_postprocess stage" in r.stdout
    assert "Running opensfm stage" in r.stdout  # skipped work still names its stage, like ODM
    for rel in ("odm_orthophoto/odm_orthophoto.tif", "odm_dem/dsm.tif", "odm_dem/dtm.tif",
                "odm_georeferencing/odm_georeferenced_model.las", "odm_georeferencing/coords.txt",
                "odm_texturing/odm_textured_model_geo.obj", "odm_report/report.pdf", "odm_report/stats.json"):  # fmt: skip
        assert (aligned / rel).is_file(), rel
    with rasterio.open(aligned / "odm_dem" / "dsm.tif") as ds:
        assert ds.crs.to_epsg() == ps.EPSG and abs(ds.res[0] - 0.4) < 1e-9
        z = ds.read(1, masked=True)
        assert z.count() > 0 and np.isfinite(z.compressed()).all()
    assert json.loads(log.read_text().splitlines()[0])[:2] == ["--pc-quality", "low"]


def test_end_with_stops_and_rerun_from_forces(aligned):
    r = _run(aligned, "--rerun-from", "openmvs", "--end-with", "odm_filterpoints")
    assert "Finished odm_filterpoints stage" in r.stdout and "odm_meshing" not in r.stdout


def test_fail_and_hang_on_request(aligned, tmp_path):
    r = _run(aligned, "--rerun-from", "openmvs", env={"FAKE_ODM_FAIL": "odm_meshing:137"})
    assert r.returncode == 137 and "Finished odm_filterpoints stage" in r.stdout
    pids = tmp_path / "pids"
    p = subprocess.Popen(
        [sys.executable, str(FAKE / "fake_odm.py"), "--rerun-from", "openmvs", "--project-path", str(aligned.parent), aligned.name],
        env={**os.environ, "FAKE_ODM_PYTHON": sys.executable, "FAKE_ODM_HANG": "openmvs", "FAKE_ODM_PIDS": str(pids)},
        stdout=subprocess.DEVNULL,
    )  # fmt: skip
    try:
        for _ in range(100):
            if pids.exists() and len(pids.read_text().split()) == 2:
                break
            time.sleep(0.1)
        assert len(pids.read_text().split()) == 2
    finally:
        p.kill()
        for pid in map(int, pids.read_text().split()) if pids.exists() else []:
            try:  # noqa: SIM105
                os.kill(pid, signal.SIGTERM)  # the fake and its sleeping child (TerminateProcess on Windows)
            except OSError:
                pass


def test_gpu_lines_and_udp(aligned):
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
        s.bind(("127.0.0.1", 0))
        s.settimeout(5)
        port = s.getsockname()[1]
        r = _run(aligned, "--feature-type", "sift", "--rerun-from", "opensfm", "--end-with", "openmvs",
                 env={"FAKE_ODM_UDP_PORT": str(port), "FAKE_ODM_GPU": "dense-cuda"})  # fmt: skip
        got = s.recvfrom(256)[0].decode()
    assert "Using GPU for extracting SIFT features" in r.stdout
    assert "CUDA device 0 initialized" in r.stdout
    assert got.startswith("PGUP/") and got.split("/")[2] == aligned.name
    r = _run(aligned, "--feature-type", "sift", "--rerun-from", "opensfm", "--end-with", "openmvs",
             env={"FAKE_ODM_GPU": "features-fallback,dense-fallback"})  # fmt: skip
    assert "GPU SIFT extraction failed" in r.stdout and "OpenMVS failed with GPU" in r.stdout


def test_gcp_gives_the_truth_and_no_gcp_the_bias(tmp_path):
    root = tmp_path / "p"
    ps.write_project(root, ps.make_scene(step=0.2), odm_bias=(0.0, 0.0, 2.0))
    odm = root / "photogrammetry" / ps.RUN / "odm"
    truth = json.loads((odm / ".fake" / "truth.json").read_text())
    rec = json.loads((odm / "opensfm" / "reconstruction.topocentric.json").read_text())[0]
    shot = next(iter(truth["shots"]))
    assert rec["shots"][shot]["translation"] != truth["shots"][shot]["translation"]
    (odm / "gcp_list.txt").write_text("EPSG:4326\n")
    _run(odm, "--gcp", str(odm / "gcp_list.txt"), "--rerun-from", "opensfm", "--end-with", "opensfm")
    rec = json.loads((odm / "opensfm" / "reconstruction.topocentric.json").read_text())[0]
    assert rec["shots"][shot]["translation"] == pytest.approx(truth["shots"][shot]["translation"])


def test_gcp_counts_only_when_odm_sets_opensfm_up_again(tmp_path):
    """Like ODM: with opensfm/image_list.txt kept, the setup (config.yaml, the GCP copy) is skipped."""
    root = tmp_path / "p"
    ps.write_project(root, ps.make_scene(step=0.2), odm_bias=(0.0, 0.0, 2.0))
    odm = root / "photogrammetry" / ps.RUN / "odm"
    sfm = odm / "opensfm"
    assert (sfm / "image_list.txt").is_file()

    def first_shot() -> list[float]:
        rec = json.loads((sfm / "reconstruction.topocentric.json").read_text())[0]
        return rec["shots"][min(rec["shots"])]["translation"]

    before = first_shot()
    (odm / "gcp_list.txt").write_text(f"EPSG:{ps.EPSG}\n412000.0 3245000.0 21.0 10.0 10.0 00000.jpg G1\n")
    (sfm / "reconstruction.json").unlink()  # the alignment is invalidated, the setup is not
    _run(odm, "--gcp", str(odm / "gcp_list.txt"), "--end-with", "opensfm")
    assert first_shot() == pytest.approx(before)  # still the biased alignment
    assert not (sfm / "gcp_list.txt").exists() and not (sfm / "config.yaml").exists()
    (sfm / "image_list.txt").unlink()
    (sfm / "reconstruction.json").unlink()
    ref = json.loads((sfm / "reference_lla.json").read_text())
    _run(odm, "--gcp", str(odm / "gcp_list.txt"), "--end-with", "opensfm")
    assert (sfm / "gcp_list.txt").is_file() and "bundle_use_gcp: yes" in (sfm / "config.yaml").read_text()
    assert json.loads((sfm / "reference_lla.json").read_text()) != ref  # centred on the control points


def _las_classes(path: Path) -> set[int]:
    data = path.read_bytes()
    start = int.from_bytes(data[96:100], "little")
    length = int.from_bytes(data[105:107], "little")
    return set(np.frombuffer(data[start:], np.uint8).reshape(-1, length)[:, 15].tolist())


@pytest.mark.parametrize(
    ("flags", "env", "ground"),
    [
        (("--dtm",), {}, True),
        (("--pc-classify",), {}, True),
        ((), {}, False),
        (("--dtm",), {"FAKE_ODM_NO_GROUND": "1"}, False),
    ],
)
def test_ground_is_classified_under_dtm_or_pc_classify(aligned, flags, env, ground):
    r = _run(
        aligned, *flags, "--rerun-from", "odm_georeferencing", "--end-with", "odm_georeferencing", env=env
    )
    assert r.returncode == 0, r.stdout + r.stderr
    classes = _las_classes(aligned / "odm_georeferencing" / "odm_georeferenced_model.laz")
    assert (2 in classes) is ground
    if ground:
        assert classes - {2}  # not every point is ground


def test_the_opensfm_stage_undistorts_again_only_when_needed(aligned, tmp_path):
    """Like ODM 3.6.2: a --rerun-from openmvs with opensfm/undistorted gone undistorts again in the
    (otherwise skipped) opensfm stage; with it kept, it does not; dense and texturing need it."""
    import shutil

    odm = tmp_path / "odm"
    shutil.copytree(aligned, odm)
    und = odm / "opensfm" / "undistorted"
    shutil.rmtree(und, ignore_errors=True)
    r = _run(odm, "--rerun-from", "openmvs", "--end-with", "mvs_texturing")
    assert r.returncode == 0, r.stdout + r.stderr
    assert "Undistorting" in r.stdout and (und / "reconstruction.nvm").is_file()
    assert (und / "openmvs" / "scene_dense.mvs").is_file()  # where ODM keeps OpenMVS's work
    r = _run(odm, "--rerun-from", "openmvs", "--end-with", "openmvs")
    assert r.returncode == 0 and "Undistorting" not in r.stdout
    import importlib.util

    spec = importlib.util.spec_from_file_location("fake_odm_module", FAKE / "fake_odm.py")
    F = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(F)
    shutil.rmtree(und)
    args = F.parse(["--project-path", str(odm.parent), odm.name])
    for stage in (F.stage_openmvs, F.stage_texturing):  # without them ODM's stages fail
        with pytest.raises(SystemExit):
            stage(odm, args, "ok")
