"""Two jobs of one project writing ``manifest.json`` at once both keep their layers.

Each job reads the manifest, adds its layer and writes it back. Without the project's manifest
lock (``runtime.manifest_lock``) a job that read before the other wrote puts back the old file and
drops the other's layer. The interleave is forced, not left to timing: the job under test is held
just before its manifest write while the other job runs, for as long as the other job takes or
``WAIT_S`` when it waits for the lock.
"""

import json
import threading
from pathlib import Path

import bentley_synth as bs
from aio_pipelines import runtime
from aio_pipelines.bentley.importer import BentleyImport
from aio_pipelines.pointcloud import PointcloudToCopc
from conftest import run_job

#: How long the held job waits for the other one before it writes. A locked writer cannot finish
#: in that time (it waits for the held job's lock); an unlocked one finishes well within it.
WAIT_S = 1.5

OTHER = {"kind": "vector", "id": "other-job", "name": "Other job", "visible": True}


def _layers(root: Path) -> list[dict]:
    return json.loads((root / "manifest.json").read_text("utf-8"))["layers"]


def _hold_before_manifest_write(monkeypatch, module, other):
    """Patch ``module.atomic_write_json``: the first write of ``manifest.json`` runs ``other`` on a
    thread and waits for it (at most ``WAIT_S``) before writing. Gives a join that re-raises what
    ``other`` raised."""
    real = module.atomic_write_json
    state: dict = {"thread": None, "errors": []}

    def run_other():
        try:
            other()
        except BaseException as e:
            state["errors"].append(e)

    def write(path, data, *a, **k):
        if Path(path).name == "manifest.json" and state["thread"] is None:
            t = threading.Thread(target=run_other)
            state["thread"] = t
            t.start()
            t.join(WAIT_S)
        return real(path, data, *a, **k)

    monkeypatch.setattr(module, "atomic_write_json", write)

    def join():
        assert state["thread"] is not None, "the job never wrote the manifest"
        state["thread"].join(60)
        assert not state["thread"].is_alive()
        assert state["errors"] == []

    return join


def _locked_writer(root: Path):
    """Another job's commit done right: read, add a layer and write under the lock."""

    def other():
        with runtime.manifest_lock(root):
            p = root / "manifest.json"
            m = json.loads(p.read_text("utf-8"))
            m["layers"].append(OTHER)
            runtime.atomic_write_json(p, m, indent=2)

    return other


def _stub_zpc(tmp_path, monkeypatch):
    from aio_pipelines import pointcloud as pc

    z = bs.make_zpc(tmp_path / "c.zpc", tiles=1)
    monkeypatch.setattr(pc, "find_pdal", lambda: "pdal")

    def convert(ctx, pdal, src, epsg):
        ctx.stage("cloud.copc.laz").write_bytes(b"copc")
        return {"points": 500, "bytes": 4, "tiles": 1}

    monkeypatch.setattr(pc, "convert_zpc", convert)
    return {"src": z["zpc"], "epsg": bs.EPSG}


def test_a_cloud_registered_while_another_job_commits_keeps_both_layers(tmp_path, monkeypatch):
    from aio_pipelines import pointcloud as pc

    root = bs.make_project(tmp_path / "proj")
    params = _stub_zpc(tmp_path, monkeypatch)
    join = _hold_before_manifest_write(monkeypatch, pc, _locked_writer(root))
    result, _ = run_job(PointcloudToCopc(), root, params)
    join()
    assert result["status"] == "done", result
    assert sorted(x["kind"] for x in _layers(root)) == ["pointcloud", "vector"]


def test_a_bentley_block_committed_while_another_job_commits_keeps_both(tmp_path, monkeypatch):
    from aio_pipelines.bentley import importer

    root = bs.make_project(tmp_path / "proj")
    out = bs.make_block(tmp_path / "bentley")
    join = _hold_before_manifest_write(monkeypatch, importer, _locked_writer(root))
    result, _ = run_job(BentleyImport(), root, {"xml": out["xml"], "photos": out["photos"]})
    join()
    assert result["status"] == "done", result
    assert sorted(x["kind"] for x in _layers(root)) == ["photos", "vector"]


def test_a_bentley_block_and_its_cloud_finishing_together_keep_both_layers(tmp_path, monkeypatch):
    """The import of a Bentley block with its .zpc: bentley.import and pointcloud.to_copc commit
    at the same moment, and the project ends with the photos and the cloud."""
    from aio_pipelines.bentley import importer

    root = bs.make_project(tmp_path / "proj")
    out = bs.make_block(tmp_path / "bentley")
    params = _stub_zpc(tmp_path, monkeypatch)

    def cloud():
        result, _ = run_job(PointcloudToCopc(), root, params, job_id="cloud")
        assert result["status"] == "done", result

    join = _hold_before_manifest_write(monkeypatch, importer, cloud)
    result, _ = run_job(BentleyImport(), root, {"xml": out["xml"], "photos": out["photos"]}, job_id="block")
    join()
    assert result["status"] == "done", result
    assert sorted(x["kind"] for x in _layers(root)) == ["photos", "pointcloud"]


def test_a_drawing_imported_while_another_job_commits_keeps_both(tmp_path, monkeypatch):
    from aio_pipelines.drawing import pipeline as drawing
    from aio_pipelines.drawing.pipeline import DrawingImport
    from modelling_synth import Dxf, write_manifest

    root = tmp_path / "proj"
    root.mkdir()
    write_manifest(root)
    d = Dxf()
    d.line("PIPES", (0, 10), (20, 10))
    src = d.write(tmp_path / "plan.dxf")
    join = _hold_before_manifest_write(monkeypatch, drawing, _locked_writer(root))
    result, _ = run_job(DrawingImport(), root, {"src": str(src)})
    join()
    assert result["status"] == "done", result
    ids = [x["id"] for x in _layers(root)]
    assert "other-job" in ids and "plan-plan" in ids


def test_an_opf_import_committed_while_another_job_commits_keeps_both(tmp_path, monkeypatch):
    import opf_synth
    from aio_pipelines import pointcloud as pc
    from aio_pipelines.opf import importer
    from aio_pipelines.opf.importer import OpfImport

    monkeypatch.setattr(pc, "find_pdal", lambda: None)
    opf = opf_synth.write_opf(tmp_path / "opf", with_outputs=False)
    root = opf_synth.make_project(tmp_path / "proj")
    join = _hold_before_manifest_write(monkeypatch, importer, _locked_writer(root))
    result, _ = run_job(OpfImport(), root, {"src": str(opf)})
    join()
    assert result["status"] == "done", result
    assert sorted(x["kind"] for x in _layers(root)) == ["photos", "vector"]
