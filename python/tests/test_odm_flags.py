from itertools import pairwise
from pathlib import Path

import pytest

from aio_pipelines.photo.odm import flags as F

GB = 1024**3


def test_threads_follow_the_spec_formula():
    assert F.odm_threads(24, 64 * GB, None) == 21  # min(22, 21)
    assert F.odm_threads(24, 64 * GB, 48 * GB) == 16  # the cap lowers it
    assert F.odm_threads(4, 8 * GB, None) == 2  # never below 2
    assert F.odm_threads(128, 512 * GB, None) == 32  # never above 32
    assert F.odm_threads(1, 1 * GB, None) == 2


def test_gpu_only_when_auto_and_the_cuda_driver_is_there():
    assert F.gpu_wanted("auto", True) is True
    assert F.gpu_wanted("auto", False) is False
    assert F.gpu_wanted("off", True) is False
    assert F.gpu_wanted("nonsense", True) is True  # unknown values read as the default
    assert F.gpu_flags(True) == ["--feature-type", "sift"]
    assert F.gpu_flags(False) == ["--no-gpu"]


def test_preset_flags_are_the_spec_table():
    assert F.PRESET_FLAGS["fast"] == (
        "--fast-orthophoto", "--skip-3dmodel", "--pc-quality", "low", "--feature-quality", "medium",
    )  # fmt: skip
    assert F.PRESET_FLAGS["standard"] == ("--pc-quality", "medium", "--feature-quality", "high")
    assert F.PRESET_FLAGS["high"] == ("--pc-quality", "high", "--feature-quality", "ultra")


def test_align_flags(tmp_path: Path):
    geo = tmp_path / "geo.txt"
    got = F.align_flags("standard", True, 8, geo, 2.0)
    assert got == [
        "--pc-quality", "medium", "--feature-quality", "high", "--feature-type", "sift",
        "--max-concurrency", "8", "--orthophoto-resolution", "2", "--geo", str(geo),
    ]  # fmt: skip
    assert "--geo" not in F.align_flags("fast", False, 2, None, 2.0)
    assert "--no-gpu" in F.align_flags("fast", False, 2, None, 2.0)


def test_georef_flags_add_the_gcp_file(tmp_path: Path):
    gcp = tmp_path / "gcp_list.txt"
    got = F.georef_flags("high", False, 4, gcp, None, 2.5)
    assert got[-2:] == ["--gcp", str(gcp)]
    assert got[got.index("--orthophoto-resolution") + 1] == "2.5"


def test_alignment_undistorts_for_the_photos_own_resolution(tmp_path: Path):
    # ODM sizes opensfm/undistorted for --orthophoto-resolution at the opensfm stage, which products
    # never rerun: with ODM's default 5 cm, photos finer than 1.7 cm would be halved for good (I3)
    got = F.align_flags("standard", False, 8, None, 1.234)
    assert got[got.index("--orthophoto-resolution") + 1] == "1.23"
    unknown = F.align_flags("standard", False, 8, None, None)
    assert unknown[unknown.index("--orthophoto-resolution") + 1] == f"{F.UNDISTORT_FALLBACK_CM:g}"


def test_products_flags_always_and_by_product(tmp_path: Path):
    got = F.products_flags("standard", {"ortho", "dsm"}, True, 20, 2.5, 5.0, None, None)
    for flag in ("--dsm", "--dtm", "--cog", "--pc-copc", "--build-overviews"):
        assert flag in got
    assert "--optimize-disk-space" not in got  # it would delete the features a later georeference reuses
    assert got[got.index("--orthophoto-resolution") + 1] == "2.5"
    assert got[got.index("--dem-resolution") + 1] == "5"
    assert got[got.index("--max-concurrency") + 1] == "20"
    assert "--skip-3dmodel" in got  # no mesh asked for
    with_mesh = F.products_flags("standard", {"mesh"}, True, 20, 2.5, 5.0, 300_000, tmp_path / "b.json")
    assert "--skip-3dmodel" not in with_mesh
    assert with_mesh[with_mesh.index("--mesh-size") + 1] == "300000"
    assert with_mesh[with_mesh.index("--boundary") + 1] == str(tmp_path / "b.json")
    fast = F.products_flags("fast", {"ortho"}, False, 2, 5.0, 10.0, None, None)
    assert fast.count("--skip-3dmodel") == 1  # once, though the preset has it too


def test_product_steps_cover_odm_in_order_without_gaps():
    for want in ({"ortho"}, {"mesh"}, {"cloud", "dsm", "dtm", "ortho", "mesh", "tiles"}):
        steps = F.product_steps(want)
        assert steps[0].name == "dense" and steps[-1].name == "ortho"
        assert steps[-1].last == "odm_postprocess"
        for a, b in pairwise(steps):
            assert F.stage_after(a.last) == b.first, (a, b)
    names = [s.name for s in F.product_steps({"mesh"})]
    assert names == ["dense", "mesh", "texture", "cloud", "dsm", "ortho"]
    assert [s.name for s in F.product_steps({"ortho"})] == ["dense", "cloud", "dsm", "ortho"]


def test_dense_starts_later_on_fast():
    assert F.dense_first("fast") == F.FAST_FIRST_STAGE
    assert F.dense_first("standard") == "openmvs"


def test_stage_windows_map_onto_odm_percent():
    assert F.stage_window("dataset", "opensfm") == (0.0, 25.0)
    assert F.stage_window("openmvs", "odm_filterpoints") == (25.0, 52.0)
    assert F.stage_after("odm_postprocess") is None
    with pytest.raises(ValueError):
        F.stage_index("split")
