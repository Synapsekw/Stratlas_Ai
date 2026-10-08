import json
import subprocess

import pytest

from aio_pipelines.pointcloud import PDAL_MISSING, PointcloudToCopc, find_pdal, pdal_env
from aio_pipelines.runtime import JobError
from conftest import run_job

PDAL = find_pdal()
needs_pdal = pytest.mark.skipif(PDAL is None, reason="PDAL not found (set AIO_PDAL)")


def small_laz(path, epsg=32639):
    """A 200-point LAZ in UTM 39N, written by PDAL from a text file (synthetic)."""
    txt = path.with_suffix(".txt")
    rows = ["X,Y,Z,Intensity"] + [
        f"{245700 + (i % 20) * 0.5},{3179600 + (i // 20) * 0.5},{10 + (i % 7) * 0.1},{i % 255}"
        for i in range(200)
    ]
    txt.write_text("\n".join(rows) + "\n")
    pipe = path.with_suffix(".json")
    pipe.write_text(
        json.dumps(
            {
                "pipeline": [
                    {"type": "readers.text", "filename": str(txt)},
                    {
                        "type": "writers.las",
                        "filename": str(path),
                        "compression": "laszip",
                        "a_srs": f"EPSG:{epsg}",
                    },
                ]
            }
        )
    )
    subprocess.run([PDAL, "pipeline", str(pipe)], check=True, capture_output=True)
    return path


def project(tmp_path):
    root = tmp_path / "proj"
    root.mkdir()
    (root / "manifest.json").write_text(json.dumps({"schema": "aio.project/1", "id": "p", "layers": []}))
    return root


def test_validate_names_the_output_and_refuses_other_files():
    p = PointcloudToCopc()
    assert p.validate({"src": "D:/scans/Site A.laz", "epsg": 32639}) == {
        "src": "D:/scans/Site A.laz",
        "out": "clouds/site-a.copc.laz",
        "epsg": 32639,
    }
    with pytest.raises(JobError, match="LAS, LAZ"):
        p.validate({"src": "D:/scans/site.txt"})
    with pytest.raises(JobError, match=r"copc.laz"):
        p.validate({"src": "a.laz", "out": "clouds/a.las"})


def test_without_pdal_the_job_says_what_is_missing(tmp_path, monkeypatch):
    import aio_pipelines.pointcloud as pc

    monkeypatch.setattr(pc, "find_pdal", lambda: None)
    root = project(tmp_path)
    (tmp_path / "a.laz").write_bytes(b"x")
    with pytest.raises(JobError) as e:
        run_job(PointcloudToCopc(), root, {"src": str(tmp_path / "a.laz")})
    assert str(e.value) == PDAL_MISSING


@needs_pdal
def test_converts_a_laz_to_copc_and_adds_the_layer(tmp_path):
    laz = small_laz(tmp_path / "site.laz")
    root = project(tmp_path)
    result, rec = run_job(PointcloudToCopc(), root, {"src": str(laz), "epsg": 32639})
    assert result["status"] == "done"
    out = root / "clouds" / "site.copc.laz"
    assert out.is_file() and out.stat().st_size > 0
    info = json.loads(
        subprocess.run([PDAL, "info", "--summary", str(out)], capture_output=True, check=True).stdout
    )
    assert info["summary"]["num_points"] == 200
    manifest = json.loads((root / "manifest.json").read_text())
    assert manifest["layers"] == [
        {
            "kind": "pointcloud",
            "id": "cloud-site",
            "name": "site.laz",
            "visible": True,
            "src": {"path": "clouds/site.copc.laz"},
            "format": "copc",
            "pointCount": 200,
        }
    ]
    assert (root / "manifest.json.bak").is_file()
    assert {"jobId": "j1", "path": "clouds/site.copc.laz", "kind": "file"} in rec.of("artifact")

    # a second run with another id adds no duplicate layer
    run_job(PointcloudToCopc(), root, {"src": str(laz), "epsg": 32639}, job_id="j2")
    assert len(json.loads((root / "manifest.json").read_text())["layers"]) == 1


def test_a_conda_style_pdal_runs_with_its_own_proj_and_gdal_data(tmp_path, monkeypatch):
    monkeypatch.delenv("PROJ_DATA", raising=False)
    monkeypatch.delenv("GDAL_DATA", raising=False)
    exe = tmp_path / "pdal" / "Library" / "bin" / "pdal.exe"
    exe.parent.mkdir(parents=True)
    exe.write_bytes(b"")
    plain = pdal_env(str(exe))
    assert "PROJ_DATA" not in plain and "GDAL_DATA" not in plain
    share = tmp_path / "pdal" / "Library" / "share"
    (share / "proj").mkdir(parents=True)
    (share / "proj" / "proj.db").write_bytes(b"")
    (share / "gdal").mkdir()
    env = pdal_env(str(exe))
    assert env["PROJ_DATA"] == str((share / "proj").resolve())
    assert env["GDAL_DATA"] == str((share / "gdal").resolve())
    assert env["PROJ_NETWORK"] == "OFF"
