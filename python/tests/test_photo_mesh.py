"""photo.products (G3): meshes (2.5D, Poisson), decimation, texturing and the GLB layer."""

from __future__ import annotations

import json
import threading

import numpy as np
import pytest
import trimesh

import products_synth as ps
from aio_pipelines.photo import mesh as M
from aio_pipelines.photo import surface as S
from aio_pipelines.photo import texture as T
from aio_pipelines.runtime import Job, Step
from conftest import Recorder


def _dsm(tmp_path, res=0.25):
    o = np.array(ps.ORIGIN)
    spec = S.GridSpec.around((o[0] - 20, o[1] - 15), (o[0] + 20, o[1] + 15), res)
    gx, gy = spec.centres(0, 0, spec.width, spec.height)
    z = (ps.dsm(gx - o[0], gy - o[1]) + o[2]).astype(np.float32)
    z[:4, :4] = np.nan
    path = tmp_path / "dsm.tif"
    with S.write_tif(path, spec, ps.EPSG, 1, "float32", S.NODATA) as ds:
        ds.write(np.where(np.isfinite(z), z, S.NODATA), 1)
    return path, spec


def test_a_25d_mesh_holds_its_budget_and_lies_on_the_dsm(tmp_path):
    path, spec = _dsm(tmp_path)
    o = np.array(ps.ORIGIN)
    m = M.mesh_25d(path, spec, o, 20_000)
    assert 0 < m.triangles <= 20_000
    x, y, h = m.vertices.T
    inner = (np.abs(x) < 18) & (np.abs(y) < 13) & ~ps.in_box(x, y)
    assert np.abs(h - ps.dsm(x, y))[inner].max() < 0.25
    # faces point up
    assert np.median(M.face_normals(m.vertices, m.faces)[:, 2]) > 0.9


def test_clustering_reduces_to_the_budget(tmp_path):
    path, spec = _dsm(tmp_path, 0.1)
    m = M.mesh_25d(path, spec, np.array(ps.ORIGIN), 10**7)
    small = M.cluster(m, 30_000)
    assert small.triangles <= 30_000 < m.triangles
    x, y, h = small.vertices.T
    inner = (np.abs(x) < 18) & (np.abs(y) < 13) & ~ps.in_box(x, y)
    assert np.percentile(np.abs(h - ps.dsm(x, y))[inner], 95) < 0.3


def test_the_fft_poisson_mesh_of_a_sphere():
    rng = np.random.default_rng(1)
    n = rng.normal(size=(20000, 3))
    n /= np.linalg.norm(n, axis=1, keepdims=True)
    pts = 5.0 * n + [100.0, 50.0, 10.0]
    m = M.poisson_fft(pts, n, 64 * 160**3, max_n=96)
    r = np.linalg.norm(m.vertices - [100.0, 50.0, 10.0], axis=1)
    assert m.triangles > 1000 and np.percentile(np.abs(r - 5.0), 95) < 0.25
    # outward faces
    cen = m.vertices[m.faces].mean(1) - [100.0, 50.0, 10.0]
    assert np.mean(np.sum(M.face_normals(m.vertices, m.faces) * cen, 1) > 0) > 0.95


def test_ply_meshes_round_trip(tmp_path):
    m = M.Mesh(
        np.array([[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1.5]], float), np.array([[0, 1, 2], [0, 2, 3]])
    )
    T.write_ply_mesh(tmp_path / "m.ply", m)
    back = M.read_ply_mesh(tmp_path / "m.ply")
    assert np.allclose(back.vertices, m.vertices) and back.faces.tolist() == m.faces.tolist()
    ascii_ply = (
        "ply\nformat ascii 1.0\nelement vertex 3\nproperty float x\nproperty float y\nproperty float z\n"
    )
    ascii_ply += (
        "element face 1\nproperty list uchar int vertex_indices\nend_header\n0 0 0\n1 0 0\n0 1 0\n3 0 1 2\n"
    )
    (tmp_path / "a.ply").write_text(ascii_ply, "ascii")
    assert M.read_ply_mesh(tmp_path / "a.ply").faces.tolist() == [[0, 1, 2]]


FAKE_POISSON = r"""
import sys, numpy as np
sys.path.insert(0, {src!r})
from aio_pipelines.photo.mesh import Mesh
from aio_pipelines.photo.texture import write_ply_mesh
args = sys.argv[1:]
src, out = args[args.index("--in") + 1], args[args.index("--out") + 1]
assert "--depth" in args and "--density" in args
data = open(src, "rb").read()
head, body = data.split(b"end_header\n", 1)
n = int([l for l in head.decode().splitlines() if l.startswith("element vertex")][0].split()[2])
rec = np.frombuffer(body, dtype=[("p", "<f4", 3), ("n", "<f4", 3), ("c", "u1", 3)], count=n)
from scipy.spatial import Delaunay
p = rec["p"].astype(float)[:: max(1, n // 4000)]
tri = Delaunay(p[:, :2]).simplices
write_ply_mesh(__import__("pathlib").Path(out), Mesh(p, tri))
open(out + ".args", "w").write(" ".join(args))
"""

FAKE_TRIMMER = r"""
import shutil, sys
args = sys.argv[1:]
assert args[args.index("--trim") + 1] == "7"
shutil.copyfile(args[args.index("--in") + 1], args[args.index("--out") + 1])
"""


def _ctx(tmp_path):
    rec = Recorder()
    job = Job("t1", None, tmp_path, {}, rec, threading.Event())  # type: ignore[arg-type]
    job.steps, job.weights = [Step("mesh", "Mesh", lambda c: None)], [1.0]
    from aio_pipelines.runtime import StepContext

    return StepContext(job, 0, job.steps[0])


def test_the_poisson_tool_is_called_and_its_mesh_read(tmp_path, monkeypatch):
    src = str(ps.Path(M.__file__).parents[2])
    monkeypatch.setenv(
        "AIO_POISSONRECON",
        str(ps.fake_tool(tmp_path / "tools", "PoissonRecon", FAKE_POISSON.replace("{src!r}", repr(src)))),
    )
    monkeypatch.setenv(
        "AIO_SURFACETRIMMER", str(ps.fake_tool(tmp_path / "tools", "SurfaceTrimmer", FAKE_TRIMMER))
    )
    rng = np.random.default_rng(2)
    pts = np.column_stack([rng.uniform(0, 10, 3000), rng.uniform(0, 10, 3000), rng.uniform(0, 0.1, 3000)])
    nrm = np.tile([0.0, 0.0, 1.0], (3000, 1))
    m = M.poisson_tool(_ctx(tmp_path), tmp_path / "work", pts, nrm, 11, np.zeros((3000, 3), np.uint8))
    assert m.triangles > 1000
    args = (tmp_path / "work" / "poisson.ply.args").read_text()
    assert "--depth 11" in args and "--colors" in args


def _cap(n: int = 20_000, seed: int = 3):
    """Oriented points on a spherical cap of radius 5 m (normals outwards)."""
    rng = np.random.default_rng(seed)
    d = rng.normal(size=(n, 3))
    d /= np.linalg.norm(d, axis=1, keepdims=True)
    d = d[d[:, 2] > -0.3]
    return 5.0 * d, d


@pytest.mark.skipif(not M.meshlab_available(), reason="pymeshlab is not installed")
def test_meshlab_meshes_a_cloud_in_a_child_python_and_trims_it(tmp_path):
    pts, nrm = _cap()
    src = tmp_path / "dense.ply"
    M.write_ply_chunks(src, [(pts, nrm, np.zeros((len(pts), 3), np.uint8))], len(pts))
    m = M.poisson_meshlab(_ctx(tmp_path), tmp_path / "work", src, 7, len(pts), 2**30)
    assert m.triangles > 1000
    r = np.linalg.norm(m.vertices, axis=1)
    assert np.percentile(np.abs(r - 5.0), 90) < 0.05, np.percentile(np.abs(r - 5.0), [50, 90, 99])
    # trimmed by density: the reconstruction's closing surface below the open cap is gone
    assert m.vertices[:, 2].min() > -4.0, m.vertices[:, 2].min()


def test_a_crashed_meshlab_run_is_tried_again_single_threaded(tmp_path, monkeypatch):
    calls = []
    monkeypatch.setattr(M.native, "tool_threads", lambda cap=8: 4)

    def fake_run(ctx, args, what, work, expected_s=60.0, progress=(0.0, 0.95), memory_limit=0, env=None):
        calls.append(list(args))
        assert memory_limit == 2**30 and env["OMP_NUM_THREADS"] == args[7]
        if len(calls) == 1:
            raise M.JobError("Poisson meshing failed: exit 3221225477")
        v = np.array([[0.0, 0, 0], [1, 0, 0], [0, 1, 0], [9, 9, 9]])
        f = np.array([[0, 1, 2], [0, 1, 3]])
        np.savez(args[5], vertices=v, faces=f, density=np.array([8.0, 8, 8, 2]))  # trim at 5 (depth 9)
        return ""

    monkeypatch.setattr(M.native, "run_tool", fake_run)
    m = M.poisson_meshlab(_ctx(tmp_path), tmp_path / "work", tmp_path / "in.ply", 9, 10, 2**30)
    assert [a[7] for a in calls] == ["4", "1"]  # threads: the machine's (capped), then one
    assert [a[6] for a in calls] == ["9", "9"]
    assert m.triangles == 1 and len(m.vertices) == 3  # the low-density face is trimmed


def test_a_meshlab_run_over_its_memory_is_tried_again_coarser(tmp_path, monkeypatch):
    calls = []
    monkeypatch.setattr(M.native, "tool_threads", lambda cap=8: 4)

    def fake_run(ctx, args, what, work, expected_s=60.0, progress=(0.0, 0.95), memory_limit=0, env=None):
        calls.append(list(args))
        if len(calls) == 1:
            raise M.native.ToolMemoryExceeded("Poisson meshing stopped: it needed more than 1.1 GB")
        v = np.array([[0.0, 0, 0], [1, 0, 0], [0, 1, 0]])
        np.savez(args[5], vertices=v, faces=np.array([[0, 1, 2]]), density=np.array([8.0, 8, 8]))
        return ""

    monkeypatch.setattr(M.native, "run_tool", fake_run)
    M.poisson_meshlab(_ctx(tmp_path), tmp_path / "work", tmp_path / "in.ply", 11, 10, 2**30)
    assert [(a[6], a[7]) for a in calls] == [("11", "4"), ("10", "4")]


def test_the_poisson_depth_follows_the_spacing_and_the_memory_budget():
    # a flat 200 m site sampled every 20 cm (G8's mini set is like this)
    g = np.arange(0, 200, 0.2)
    xx, yy = np.meshgrid(g, g)
    pts = np.column_stack([xx.ravel(), yy.ravel(), np.zeros(xx.size)])[::7]
    assert M.poisson_depth(pts, 11, 64 * 2**30) == (11, "preset")
    # cells no finer than the 20 cm spacing
    assert M.poisson_depth(pts, 11, 64 * 2**30, spacing=0.2) == (10, "point spacing 0.200 m")
    # a 16 GB runner's budget (40 %): depth 10 would need about 9 GB
    assert M.poisson_depth(pts, 11, int(6.4e9), spacing=0.2) == (9, "memory budget 6.4 GB")
    assert M.poisson_depth(pts, 11, int(1.5e9))[0] == 8
    assert M.poisson_depth(pts[:5], 11, 2**30)[0] == 8


def test_when_meshlab_fails_the_poisson_tool_stands_in(tmp_path, monkeypatch):
    src = str(ps.Path(M.__file__).parents[2])
    monkeypatch.delenv("AIO_POISSONRECON", raising=False)
    monkeypatch.setattr(M, "meshlab_available", lambda: True)
    tool = ps.fake_tool(tmp_path / "tools", "PoissonRecon", FAKE_POISSON.replace("{src!r}", repr(src)))
    monkeypatch.setattr(M.native, "find_tool", lambda name: str(tool) if name == "PoissonRecon" else None)

    def crash(*a, **k):
        raise M.JobError("MeshLab's Poisson made an empty mesh.")

    monkeypatch.setattr(M, "poisson_meshlab", crash)
    rng = np.random.default_rng(2)
    pts = np.column_stack([rng.uniform(0, 10, 3000), rng.uniform(0, 10, 3000), rng.uniform(0, 0.1, 3000)])
    nrm = np.tile([0.0, 0.0, 1.0], (3000, 1))
    src_ply = tmp_path / "work" / "dense.ply"
    M.write_ply_chunks(src_ply, [(pts, nrm, np.zeros((3000, 3), np.uint8))], 3000)
    assert M.poisson_engine() == "meshlab"
    mesh, engine = M.poisson_mesh(_ctx(tmp_path), tmp_path / "work", pts, nrm, 9, src_ply, 3000, 2**30)
    assert engine == "poissonrecon" and mesh.triangles > 1000


def test_the_poisson_engine_order(monkeypatch, tmp_path):
    monkeypatch.delenv("AIO_POISSONRECON", raising=False)
    monkeypatch.setattr(M.native, "find_tool", lambda name: None)
    monkeypatch.setattr(M, "meshlab_available", lambda: False)
    assert M.poisson_engine() is None
    monkeypatch.setattr(M, "meshlab_available", lambda: True)
    assert M.poisson_engine() == "meshlab"
    monkeypatch.setattr(M.native, "find_tool", lambda name: "x")
    assert M.poisson_engine() == "meshlab"
    monkeypatch.setenv("AIO_POISSONRECON", "x")  # an explicit tool wins
    assert M.poisson_engine() == "poissonrecon"


def test_read_ply_points_thins_the_cloud(tmp_path):
    pts, nrm = _cap(5000)
    src = tmp_path / "c.ply"
    M.write_ply_chunks(src, [(pts, nrm, np.zeros((len(pts), 3), np.uint8))], len(pts))
    p, n = M.read_ply_points(src)
    assert np.allclose(p, pts, atol=1e-5) and np.allclose(n, nrm, atol=1e-6)
    p2, _ = M.read_ply_points(src, 1000)
    assert 500 <= len(p2) <= 1000


def test_a_missing_tool_says_so(tmp_path, monkeypatch):
    monkeypatch.setenv("AIO_POISSONRECON", str(tmp_path / "nothing.exe"))
    with pytest.raises(Exception, match="PoissonRecon is not in this pipeline pack"):
        M.poisson_tool(_ctx(tmp_path), tmp_path, np.zeros((5, 3)), np.zeros((5, 3)), 8)


def test_a_cancelled_tool_is_killed(tmp_path, monkeypatch):
    from aio_pipelines.photo.native import run_tool
    from aio_pipelines.runtime import Cancelled

    exe = ps.fake_tool(tmp_path, "slow", "import time\ntime.sleep(60)\n")
    ctx = _ctx(tmp_path)
    threading.Timer(0.5, ctx.cancel_event.set).start()
    import time

    t0 = time.monotonic()
    with pytest.raises(Cancelled):
        run_tool(ctx, [str(exe)], "Slow", tmp_path / "w")
    assert time.monotonic() - t0 < 5


def test_texrecon_cameras_are_in_the_local_frame(tmp_path):
    v = ps.scene().views[0]
    o = np.array(ps.ORIGIN)
    T.write_cam(tmp_path / "a.cam", v, v.camera.pinhole(), o)
    line1, line2 = (tmp_path / "a.cam").read_text().splitlines()
    t = np.array([float(x) for x in line1.split()[:3]])
    r = np.array([float(x) for x in line1.split()[3:]]).reshape(3, 3)
    assert np.allclose(-r.T @ t, v.centre - o, atol=1e-6)
    f, d0, d1, aspect, ppx, ppy = (float(x) for x in line2.split())
    assert f == pytest.approx(v.camera.fx / 480) and (d0, d1) == (0, 0)
    assert ppx == pytest.approx(v.camera.cx / 480) and aspect == pytest.approx(v.camera.fy / v.camera.fx)


FAKE_TEXRECON = r"""
import sys
from pathlib import Path
from PIL import Image
args = [a for a in sys.argv[1:] if not a.startswith("-") and a != "gauss_clamping"]
scene, mesh, prefix = (Path(a) for a in args)
assert any(scene.glob("*.cam")) and any(scene.glob("*.png"))
data = mesh.read_bytes()
head = data.split(b"end_header")[0].decode()
n = int([l for l in head.splitlines() if l.startswith("element vertex")][0].split()[2])
Image.new("RGB", (8, 8), (200, 40, 40)).save(str(prefix) + "_material0000_map_Kd.png")
Path(str(prefix) + ".mtl").write_text("newmtl material0000\nmap_Kd " + prefix.name + "_material0000_map_Kd.png\n")
lines = ["mtllib " + prefix.name + ".mtl", "v 0 0 0", "v 1 0 0", "v 0 1 0", "vt 0 0", "vt 1 0", "vt 0 1", "usemtl material0000", "f 1/1 2/2 3/3"]
Path(str(prefix) + ".obj").write_text("\n".join(lines) + "\n")
"""


def test_texrecon_output_becomes_a_textured_glb(tmp_path, monkeypatch):
    monkeypatch.setenv("AIO_TEXRECON", str(ps.fake_tool(tmp_path / "tools", "texrecon", FAKE_TEXRECON)))
    s = ps.scene()
    views = []
    for v, img in list(zip(s.views, s.images, strict=True))[:3]:
        p = tmp_path / v.name
        from PIL import Image

        Image.fromarray(img).save(p)
        views.append(ps.View(v.id, v.name, v.camera, v.r, v.t, p))
    mesh = M.Mesh(np.array([[0, 0, 0], [1, 0, 0], [0, 1, 0]], float), np.array([[0, 1, 2]]))
    glb, info = T.texture_texrecon(_ctx(tmp_path), tmp_path / "tex", mesh, views, np.array(ps.ORIGIN))
    doc = T.glb_info(glb)
    assert info["textures"] == 1 and len(doc["images"]) == 1
    assert doc["materials"][0]["pbrMetallicRoughness"]["baseColorTexture"] == {"index": 0}


@pytest.fixture(scope="module")
def processed():
    return ps.processed()


def test_the_mesh_layer_is_a_textured_glb_on_the_surface(processed):
    root, _, _ = processed
    glb = root / "models" / f"{ps.RUN}-mesh.glb"
    doc = T.glb_info(glb.read_bytes())
    assert doc["images"] and doc["materials"][0]["pbrMetallicRoughness"].get("baseColorTexture")
    m = trimesh.load(glb, force="mesh")
    x, y, h = m.vertices[:, 0], -m.vertices[:, 2], m.vertices[:, 1]  # scene frame to east, north, up
    inner = (np.abs(x) < 24) & (np.abs(y) < 18)
    x0, x1, y0, y1, _ = ps.BOX
    edge = (x > x0 - 0.4) & (x < x1 + 0.4) & (y > y0 - 0.4) & (y < y1 + 0.4)
    edge &= ~((x > x0 + 0.4) & (x < x1 - 0.4) & (y > y0 + 0.4) & (y < y1 - 0.4))
    assert np.percentile(np.abs(h - ps.dsm(x, y))[inner & ~edge], 95) < 4 * ps.GSD
    assert len(m.faces) <= 2_000_000
    report = json.loads((root / "photogrammetry" / ps.RUN / "report" / "products.json").read_text("utf-8"))
    # a nadir set: screened Poisson when this Python has it (the pack does), else the DSM's grid
    if M.meshlab_available():
        assert report["engines"]["mesh"] == "meshlab-poisson" and report["engines"]["texture"] == "views"
    else:
        assert report["engines"]["mesh"] == "grid-25d" and report["engines"]["texture"] == "ortho-drape"


def test_per_photo_texturing_covers_the_mesh(tmp_path):
    path, spec = _dsm(tmp_path, 0.5)
    o = np.array(ps.ORIGIN)
    mesh = M.mesh_25d(path, spec, o, 5_000)
    s = ps.scene()
    views = []
    from PIL import Image

    for v, img in zip(s.views, s.images, strict=True):
        p = tmp_path / v.name
        Image.fromarray(img).save(p)
        views.append(ps.View(v.id, v.name, v.camera, v.r, v.t, p))
    glb, info = T.texture_views(mesh, views, o)
    assert info["photos"] >= 4 and info["unseenFaces"] < 0.02 * mesh.triangles
    doc = T.glb_info(glb)
    assert len(doc["images"]) == info["photos"]
