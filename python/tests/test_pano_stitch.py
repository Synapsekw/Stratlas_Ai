"""``pano.stitch`` end to end on synthetic spheres (plan task 6)."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import cv2
import numpy as np
import pytest

import pano_synth as ps
from aio_pipelines.pano import align, compose, photometry, pipeline
from aio_pipelines.pano.pipeline import FRAMES_MISSING, PanoStitch
from aio_pipelines.pano.record import check_record
from aio_pipelines.runtime import Cancelled, JobError
from conftest import run_job

FIXTURE = (
    Path(__file__).resolve().parents[2]
    / "packages"
    / "schema"
    / "src"
    / "__fixtures__"
    / "pano"
    / "stitch.synthetic.json"
)
PARAMS = {"layer": "panos-2026-09-10", "pano": "p01"}
WIDE_SHOTS = [(y, p) for y in (-100, -67.8, -35.7, -3.5, 28.7, 60.8, 93) for p in (20, -17, -55)] + [
    (0.0, -90.0)
]


def stitch(project: Path, job_id: str = "j1") -> dict:
    return run_job(PanoStitch(), project, PARAMS, job_id=job_id)[0]


@pytest.fixture
def project(tmp_path, monkeypatch):
    monkeypatch.setenv(pipeline.WIDTH_ENV, "1024")
    root = tmp_path / "Projet été"  # a non-ASCII project path (Review Focus 4)
    root.mkdir()
    return root


def frames_dir(project: Path) -> Path:
    return project / "panoramas" / PARAMS["layer"] / PARAMS["pano"] / "frames"


def read_jpeg(path: Path) -> np.ndarray:
    return cv2.imdecode(np.fromfile(str(path), np.uint8), cv2.IMREAD_COLOR)


def test_parameters_are_checked():
    p = PanoStitch()
    assert p.validate(dict(PARAMS)) == PARAMS
    with pytest.raises(JobError, match="needs: pano"):
        p.validate({"layer": "l"})
    with pytest.raises(JobError, match="lower-case"):
        p.validate({"layer": "../x", "pano": "p01"})
    with pytest.raises(JobError, match="standard or high"):
        p.validate({**PARAMS, "quality": "ultra"})
    with pytest.raises(JobError, match="does not take: width"):
        p.validate({**PARAMS, "width": 1024})


def test_output_width_by_quality_and_the_test_override(monkeypatch):
    monkeypatch.delenv(pipeline.WIDTH_ENV, raising=False)
    assert pipeline.out_width("standard") == 8192 and pipeline.out_width("high") == 16384
    monkeypatch.setenv(pipeline.WIDTH_ENV, "1025")
    assert pipeline.out_width("standard") == 1024
    monkeypatch.setenv(pipeline.WIDTH_ENV, "100")
    with pytest.raises(JobError, match="512 to 16384"):
        pipeline.out_width("standard")


def test_stitches_a_sphere_into_a_non_ascii_project(project):
    ps.make_sphere(frames_dir(project), "rows", frame_w=480, seed=3)
    result = stitch(project)
    assert result["status"] == "done"
    folder = frames_dir(project).parent
    doc = json.loads((folder / "stitch.json").read_text("utf-8"))
    check_record(doc)
    assert doc["run"] == "j1" and doc["aligned"] == "features" and doc["shape"] == "sphere"
    assert doc["size"] == {"width": 1024, "height": 512} and len(doc["frames"]["used"]) == 25
    assert doc["coverage"]["bottomDeg"] > 85 and 15 < doc["coverage"]["topDeg"] < 30
    assert set(doc["timings"]) == set(pipeline.WEIGHTS) and "light" in doc["timings"]
    assert read_jpeg(folder / "pano.jpg").shape == (512, 1024, 3)
    assert read_jpeg(folder / "thumb.jpg").shape == (256, 512, 3)


def test_frames_shot_at_different_exposures_are_evened_from_their_exif(project, monkeypatch):
    frames = ps.make_sphere(frames_dir(project), "rows", frame_w=480, seed=3, exposure=5, vignette=-0.3)
    fitted = {}
    real_fit = photometry.fit

    def keeping_fit(copies, rotations, evs, pairs):
        fitted["evs"], fitted["light"] = evs, real_fit(copies, rotations, evs, pairs)
        return fitted["light"]

    monkeypatch.setattr(photometry, "fit", keeping_fit)
    stitch(project)
    doc = json.loads((frames_dir(project).parent / "stitch.json").read_text("utf-8"))
    check_record(doc)
    assert doc["aligned"] == "features" and "light" in doc["timings"]
    assert all(ev is not None for ev in fitted["evs"])
    stops = np.array(ps.exposure_offsets(len(frames), 5)) * np.log(2)
    g = np.array(fitted["light"].log_gains).mean(axis=1)
    assert np.abs(g - (stops - np.median(stops))).max() < 0.1
    assert np.exp(sum(fitted["light"].falloff)) == pytest.approx(np.exp(-0.3), rel=0.05)


def test_a_wide_panorama_is_cropped_and_records_its_yaw_range(project):
    ps.make_sphere(frames_dir(project), "bursts", frame_w=480, seed=3, shots=WIDE_SHOTS)
    stitch(project)
    doc = json.loads((frames_dir(project).parent / "stitch.json").read_text("utf-8"))
    assert doc["shape"] == "wide" and doc["size"]["width"] < 1024
    cov = doc["coverage"]
    assert cov["leftDeg"] < -100 and cov["rightDeg"] > 93 and cov["rightDeg"] - cov["leftDeg"] < 330


def test_a_textureless_sphere_still_gives_an_image_aligned_from_metadata(project):
    ps.make_sphere(frames_dir(project), "bursts", scene=ps.make_scene(textureless=True), frame_w=480, seed=3)
    stitch(project)
    doc = json.loads((frames_dir(project).parent / "stitch.json").read_text("utf-8"))
    assert doc["aligned"] == "metadata" and doc["residualPx"] is None and doc["focalScale"] == 1.0
    assert doc["warnings"] == ["Aligned from the gimbal angles only: No features matched between frames."]
    assert (frames_dir(project).parent / "pano.jpg").is_file()


def test_missing_frames_fail_with_a_message(project):
    with pytest.raises(JobError, match=FRAMES_MISSING):
        stitch(project)
    frames = ps.make_sphere(frames_dir(project), "rows", frame_w=320, seed=3)
    for f in frames[5:]:
        f.path.unlink()
    with pytest.raises(JobError, match=FRAMES_MISSING):
        stitch(project, "j2")


def test_unusable_frames_are_dropped_and_named(project):
    frames = ps.make_sphere(frames_dir(project), "rows", frame_w=480, seed=3)
    frames[0].path.write_bytes(b"not a jpeg")
    stitch(project)
    doc = json.loads((frames_dir(project).parent / "stitch.json").read_text("utf-8"))
    assert doc["frames"]["dropped"] == [{"file": frames[0].path.name, "reason": "Could not be read"}]
    assert len(doc["frames"]["used"]) == 24


def test_a_cancel_while_composing_resumes_without_matching_again(project, monkeypatch):
    ps.make_sphere(frames_dir(project), "rows", frame_w=480, seed=3)
    calls = {"match": 0, "light": 0, "blend": 0}
    real_match, real_fit, real_blend = align.match_frames, photometry.fit, compose.blend

    def counting_match(*a, **k):
        calls["match"] += 1
        return real_match(*a, **k)

    def counting_fit(*a, **k):
        calls["light"] += 1
        return real_fit(*a, **k)

    def cancelling_blend(*a, **k):
        calls["blend"] += 1
        if calls["blend"] == 1:
            raise Cancelled()
        return real_blend(*a, **k)

    monkeypatch.setattr(align, "match_frames", counting_match)
    monkeypatch.setattr(photometry, "fit", counting_fit)
    monkeypatch.setattr(compose, "blend", cancelling_blend)
    with pytest.raises(Cancelled):
        stitch(project)
    assert not (frames_dir(project).parent / "pano.jpg").exists()
    assert stitch(project)["status"] == "done"
    assert calls == {"match": 1, "light": 1, "blend": 2}


def test_a_cancel_while_evening_the_light_resumes_from_the_adjustment(project, monkeypatch):
    ps.make_sphere(frames_dir(project), "rows", frame_w=320, seed=3)
    calls = {"match": 0, "light": 0}
    real_match, real_fit = align.match_frames, photometry.fit

    def counting_match(*a, **k):
        calls["match"] += 1
        return real_match(*a, **k)

    def cancelling_fit(*a, **k):
        calls["light"] += 1
        if calls["light"] == 1:
            raise Cancelled()
        return real_fit(*a, **k)

    monkeypatch.setattr(align, "match_frames", counting_match)
    monkeypatch.setattr(photometry, "fit", cancelling_fit)
    with pytest.raises(Cancelled):
        stitch(project)
    assert stitch(project)["status"] == "done"
    assert calls == {"match": 1, "light": 2}
    check_record(json.loads((frames_dir(project).parent / "stitch.json").read_text("utf-8")))


def test_the_shared_fixture_passes_the_python_check():
    doc = json.loads(FIXTURE.read_text("utf-8"))
    check_record(doc)
    with pytest.raises(ValueError, match="the set of fields"):
        check_record({k: v for k, v in doc.items() if k != "run"})
    with pytest.raises(ValueError, match="frames"):
        check_record({**doc, "frames": {"used": ["a/b.jpg"], "dropped": []}})


def test_pano_stitch_is_registered():
    from aio_pipelines.pipelines import all_pipelines

    assert isinstance(all_pipelines()["pano.stitch"], PanoStitch)


def _sphere_missing_a_horizon_frame(project: Path) -> None:
    gap = round(-180 + 3 * 360 / 7, 1)
    shots = [s for s in ps.PATTERNS["bursts"] if abs(s[0] - gap) > 1e-6]
    ps.make_sphere(frames_dir(project), "bursts", frame_w=480, seed=3, shots=shots)


def test_the_import_classification_keeps_a_sphere_whole(project):
    _sphere_missing_a_horizon_frame(project)
    stitch(project)
    folder = frames_dir(project).parent
    by_coverage = json.loads((folder / "stitch.json").read_text("utf-8"))
    assert by_coverage["shape"] == "wide"  # without the hint the coverage rule decides
    run_job(PanoStitch(), project, {**PARAMS, "shape": "sphere"}, job_id="j2")
    doc = json.loads((folder / "stitch.json").read_text("utf-8"))
    check_record(doc)
    assert doc["shape"] == "sphere" and doc["size"] == {"width": 1024, "height": 512}
    assert read_jpeg(folder / "pano.jpg").shape == (512, 1024, 3)


def test_the_shape_parameter_is_checked():
    with pytest.raises(JobError, match="sphere or wide"):
        PanoStitch().validate({**PARAMS, "shape": "dome"})
    assert PanoStitch().validate({**PARAMS, "shape": "wide"})["shape"] == "wide"


def test_a_sphere_of_too_many_frames_is_refused(project):
    folder = frames_dir(project)
    folder.mkdir(parents=True)
    for n in range(201):
        (folder / f"F_{n:04d}.jpg").write_bytes(b"x")
    with pytest.raises(JobError, match="at most 200") as e:
        stitch(project)
    assert len(str(e.value)) < 400


def test_a_frame_deleted_during_the_run_reads_as_missing(project, monkeypatch):
    ps.make_sphere(frames_dir(project), "rows", frame_w=320, seed=3)

    def gone(path, *a, **k):
        raise FileNotFoundError(2, "No such file", str(path))

    monkeypatch.setattr("aio_pipelines.pano.frames.read_image", gone)
    with pytest.raises(JobError) as e:
        stitch(project)
    assert str(e.value) == FRAMES_MISSING


def test_the_record_check_keeps_the_schema_caps():
    doc = json.loads(FIXTURE.read_text("utf-8"))
    names = [f"F_{n:04d}.jpg" for n in range(201)]
    with pytest.raises(ValueError, match="frames"):
        check_record({**doc, "frames": {"used": names, "dropped": []}})
    dropped = [{"file": n, "reason": "No gimbal angles"} for n in names]
    with pytest.raises(ValueError, match="frames"):
        check_record({**doc, "frames": {"used": names[:8], "dropped": dropped}})
    with pytest.raises(ValueError, match="frames"):
        check_record(
            {**doc, "frames": {"used": names[:8], "dropped": [{"file": "a.jpg", "reason": "x" * 201}]}}
        )


def test_importing_the_pipelines_does_not_load_opencv():
    # MeshLab shares no process with OpenCV (libomp); the pano modules import cv2 on use.
    probe = "import sys, aio_pipelines.pipelines\nprint('cv2' in sys.modules)"
    out = subprocess.run(
        [sys.executable, "-I", "-c", probe], capture_output=True, text=True, timeout=120, check=True
    ).stdout.strip()
    assert out == "False"
