"""tiles.mesh and tiles.cloud (M10 G7): synthetic meshes and clouds to 3D Tiles 1.1.

Tilesets are checked with our structural checker (``check_tileset``); the full 3d-tiles-validator
is a development tool and runs in CI only. Everything is generated at the fictional desert site.
"""

from __future__ import annotations

import json
import struct
import threading

import numpy as np
import pytest
from PIL import Image
from rasterio.crs import CRS
from rasterio.warp import transform

from aio_pipelines.change.las import write_las
from aio_pipelines.runtime import Cancelled, JobError
from aio_pipelines.tiles.cloud import Cube, TilesCloud, cube_of
from aio_pipelines.tiles.gltf import Part, read_glb, write_glb
from aio_pipelines.tiles.mesh import TilesMesh, cluster
from aio_pipelines.tiles.tileset import check_tileset
from aio_pipelines.tiles.transform import SiteFrame, geodetic_to_ecef, gltf_to_enu
from conftest import run_job

EPSG = 32639
ORIGIN = [500_000.0, 3_200_000.0, 12.0]
GRID = 121  # 120 x 120 quads = 28 800 triangles
SPAN = 600.0


def manifest(layers):
    return {
        "schema": "aio.project/1",
        "id": "tiles-site",
        "name": "Tiles site",
        "crs": {"epsg": EPSG},
        "origin": ORIGIN,
        "captures": [{"id": "c1", "label": "Survey", "date": "2026-10-01"}],
        "layers": layers,
        "severityModels": [],
        "classCatalogues": [],
    }


def height(x, z):
    return 3.0 * np.sin(x / 40.0) + 2.0 * np.cos(z / 55.0)


def grid_mesh():
    import trimesh

    xs = np.linspace(-SPAN / 2, SPAN / 2, GRID)
    xx, zz = np.meshgrid(xs, xs)
    verts = np.stack([xx.ravel(), height(xx, zz).ravel(), zz.ravel()], axis=1)
    idx = np.arange(GRID * GRID).reshape(GRID, GRID)
    a, b, c, d = idx[:-1, :-1].ravel(), idx[:-1, 1:].ravel(), idx[1:, :-1].ravel(), idx[1:, 1:].ravel()
    faces = np.concatenate([np.stack([a, c, b], 1), np.stack([b, c, d], 1)])
    uv = np.stack([(xx.ravel() + SPAN / 2) / SPAN, (zz.ravel() + SPAN / 2) / SPAN], axis=1)
    tex = np.zeros((256, 256, 3), np.uint8)
    tex[::32, :] = 255
    tex[:, ::32] = 255
    tex[..., 1] = np.arange(256)[None, :]
    visual = trimesh.visual.TextureVisuals(uv=uv, image=Image.fromarray(tex))
    return trimesh.Trimesh(verts, faces, visual=visual, process=False), verts


@pytest.fixture
def mesh_project(tmp_path):
    mesh, verts = grid_mesh()
    (tmp_path / "models").mkdir()
    (tmp_path / "models" / "site.glb").write_bytes(mesh.export(file_type="glb"))
    layer = {
        "id": "mesh-1",
        "kind": "mesh",
        "name": "Site mesh",
        "capture": "c1",
        "src": {"path": "models/site.glb"},
        # a small shift baked by an importer: the tiles must follow it
        "transform": [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 5.0, 0.5, -3.0, 1],
    }
    (tmp_path / "manifest.json").write_text(json.dumps(manifest([layer])), "utf-8")
    return tmp_path, verts + np.array([5.0, 0.5, -3.0])


def ecef_truth(local):
    """ECEF of local points the independent way: GDAL from the project CRS (with heights)."""
    e = ORIGIN[0] + local[:, 0]
    n = ORIGIN[1] - local[:, 2]
    h = ORIGIN[2] + local[:, 1]
    x, y, z = transform(CRS.from_epsg(EPSG), CRS.from_epsg(4978), list(e), list(n), list(h))
    return np.stack([x, y, z], axis=1)


def to_ecef(tileset, content_bytes):
    gltf, prims = read_glb(content_bytes)
    tr = np.asarray(gltf["nodes"][0]["translation"], dtype=np.float64)
    m = np.asarray(tileset["root"]["transform"], dtype=np.float64).reshape(4, 4).T
    out = []
    for p in prims:
        enu = gltf_to_enu(p["POSITION"].astype(np.float64) + tr)
        out.append(enu @ m[:3, :3].T + m[:3, 3])
    return np.concatenate(out), prims


def walk(t, depth=0):
    yield t, depth
    for c in t.get("children") or []:
        yield from walk(c, depth + 1)


# ---------------------------------------------------------------- transform


def test_the_site_frame_matches_gdal_within_a_millimetre():
    frame = SiteFrame.of(manifest([]))
    local = np.array([[0.0, 0.0, 0.0], [250.0, 30.0, -400.0], [-800.0, -5.0, 900.0]])
    enu = frame.local_to_enu(local)
    ecef = enu @ frame.rot.T + frame.ecef
    assert np.abs(ecef - ecef_truth(local)).max() < 1e-3
    # The rotation is orthonormal and up points away from the Earth's centre.
    assert np.allclose(frame.rot.T @ frame.rot, np.eye(3), atol=1e-12)
    assert frame.rot[:, 2] @ (frame.ecef / np.linalg.norm(frame.ecef)) > 0.99
    # UTM is not a tangent plane: 400 m north is not exactly 400 m north in ENU (convergence)
    assert abs(enu[1, 0] - 250.0) > 1e-3


def test_geodetic_to_ecef_known_points():
    assert np.allclose(geodetic_to_ecef(0.0, 0.0, 0.0), [6378137.0, 0, 0])
    assert np.allclose(geodetic_to_ecef(0.0, 90.0, 0.0), [0, 0, 6356752.314245], atol=1e-6)


# ---------------------------------------------------------------- glTF


def test_glb_round_trip():
    pts = np.array([[0, 0, 0], [1, 0, 0], [0, 1, 0]], np.float32)
    glb = write_glb([Part(positions=pts, indices=np.array([[0, 1, 2]]))], [10.0, 20.0, 30.0])
    gltf, prims = read_glb(glb)
    assert gltf["nodes"][0]["translation"] == [10.0, 20.0, 30.0]
    assert np.array_equal(prims[0]["POSITION"], pts)
    assert prims[0]["indices"].tolist() == [0, 1, 2]
    assert len(glb) % 4 == 0
    points = write_glb([Part(positions=pts, colors=np.array([[255, 0, 0]] * 3, np.uint8))], [0, 0, 0])
    gltf, prims = read_glb(points)
    assert gltf["meshes"][0]["primitives"][0]["mode"] == 0
    assert prims[0]["COLOR_0"].tolist()[0] == [255, 0, 0]


def test_vertex_clustering_simplifies_and_keeps_faces_valid():
    _, verts = grid_mesh()
    import trimesh

    m = trimesh.creation.box()
    enu = np.asarray(m.vertices, float) * 10
    out_v, out_f, _, _ = cluster(enu, np.asarray(m.faces), None, None, 100.0, enu.min(axis=0), 1.0)
    assert len(out_v) == 1 and len(out_f) == 0
    xs = np.linspace(0, 100, 51)
    xx, yy = np.meshgrid(xs, xs)
    v = np.stack([xx.ravel(), yy.ravel(), np.zeros(xx.size)], 1)
    idx = np.arange(51 * 51).reshape(51, 51)
    a, b, c = idx[:-1, :-1].ravel(), idx[:-1, 1:].ravel(), idx[1:, :-1].ravel()
    f = np.stack([a, b, c], 1)
    ov, of, _, _ = cluster(v, f, None, None, 10.0, v.min(axis=0), 1.0)
    assert 0 < len(of) < len(f) / 10
    assert of.max() < len(ov)


# ---------------------------------------------------------------- tiles.mesh


def test_a_mesh_layer_becomes_a_valid_tileset_in_place(mesh_project):
    project, local_verts = mesh_project
    result, rec = run_job(
        TilesMesh(), project, {"layer": "mesh-1", "maxTrianglesPerTile": 3000, "textureMaxPx": 128}
    )
    folder = project / "tiles" / "mesh-1-tiles"
    assert check_tileset(folder) == []
    ts = json.loads((folder / "tileset.json").read_text("utf-8"))
    assert ts["asset"]["version"] == "1.1"
    assert ts["root"]["refine"] == "REPLACE"
    assert ts["extras"]["aio"]["crs"] == {"epsg": EPSG}

    tiles = list(walk(ts["root"]))
    depth = max(d for _, d in tiles)
    assert depth >= 2
    # Geometric error falls level by level, to 0 at the leaves.
    for t, _ in tiles:
        for c in t.get("children") or []:
            assert c["geometricError"] < t["geometricError"]
        if not t.get("children"):
            assert t["geometricError"] == 0
    # Leaves hold every source triangle once.
    leaf_tris = 0
    for t, _ in tiles:
        if not t.get("children"):
            _, prims = read_glb((folder / t["content"]["uri"]).read_bytes())
            leaf_tris += sum(len(p["indices"]) // 3 for p in prims)
    assert leaf_tris == 2 * (GRID - 1) ** 2
    # Parents are simplified: the root has fewer triangles than the leaves.
    _, root_prims = read_glb((folder / ts["root"]["content"]["uri"]).read_bytes())
    assert sum(len(p["indices"]) // 3 for p in root_prims) < leaf_tris / 4
    # Textures came along, cropped and downscaled.
    gltf, _ = read_glb((folder / ts["root"]["content"]["uri"]).read_bytes())
    assert gltf["images"][0]["mimeType"] in ("image/jpeg", "image/png")

    # A known vertex lands within 1 mm of its ECEF truth (per-vertex reprojection, float64).
    corner = local_verts[0]
    truth = ecef_truth(corner[None])[0]
    best = np.inf
    for t, _ in tiles:
        if t.get("children"):
            continue
        ecef, _ = to_ecef(ts, (folder / t["content"]["uri"]).read_bytes())
        best = min(best, float(np.linalg.norm(ecef - truth, axis=1).min()))
    assert best < 1e-3

    tilesets = json.loads((project / "tilesets.json").read_text("utf-8"))
    assert tilesets["schema"] == "aio.tilesets/1"
    (entry,) = tilesets["entries"]
    assert entry == {
        "id": "mesh-1-tiles",
        "name": "Site mesh",
        "kind": "mesh",
        "src": "tiles/mesh-1-tiles/tileset.json",
        "from": "mesh-1",
        "capture": "c1",
        "visible": True,
    }
    assert result["outputs"]["commit"]["tileset"] == "mesh-1-tiles"
    assert result["outputs"]["commit"]["entry"]["id"] == "mesh-1-tiles"
    assert any(a["path"] == "tilesets.json" for a in rec.of("artifact"))


def test_a_rebuild_replaces_the_entry_keeps_the_choice_and_a_bak(mesh_project):
    project, _ = mesh_project
    params = {
        "layer": "mesh-1",
        "id": "site",
        "name": "Site",
        "maxTrianglesPerTile": 20000,
        "compression": "draco",
    }
    run_job(TilesMesh(), project, params, job_id="a")
    f = project / "tilesets.json"
    data = json.loads(f.read_text("utf-8"))
    data["entries"][0]["visible"] = False
    data["entries"].insert(
        0,
        {
            "id": "other",
            "name": "Other",
            "kind": "imported",
            "src": "tiles/other/tileset.json",
            "visible": True,
        },
    )
    f.write_text(json.dumps(data), "utf-8")
    _, rec = run_job(TilesMesh(), project, {**params, "name": "Site again"}, job_id="b")
    after = json.loads(f.read_text("utf-8"))
    assert [e["id"] for e in after["entries"]] == ["other", "site"]
    assert after["entries"][1]["visible"] is False
    assert after["entries"][1]["name"] == "Site again"
    assert json.loads((project / "tilesets.json.bak").read_text("utf-8")) == data
    assert any("uncompressed" in m["message"] for m in rec.of("log"))


def test_a_mesh_file_in_the_project_is_tiled_too(mesh_project):
    project, _ = mesh_project
    run_job(
        TilesMesh(), project, {"src": "models/site.glb", "run": "20261007-0915", "maxTrianglesPerTile": 50000}
    )
    entry = json.loads((project / "tilesets.json").read_text("utf-8"))["entries"][0]
    assert entry["id"] == "site-tiles"
    assert entry["run"] == "20261007-0915"
    assert "from" not in entry
    assert check_tileset(project / "tiles" / "site-tiles") == []


def test_tiles_mesh_params_and_inputs_are_checked(mesh_project):
    project, _ = mesh_project
    p = TilesMesh()
    with pytest.raises(JobError, match="not both"):
        p.validate({"layer": "a", "src": "b.glb"})
    with pytest.raises(JobError, match="does not take: bogus"):
        p.validate({"layer": "a", "bogus": 1})
    with pytest.raises(JobError, match="compression must be one of"):
        p.validate({"layer": "a", "compression": "zip"})
    with pytest.raises(JobError, match="id must be"):
        p.validate({"layer": "a", "id": "../x"})
    with pytest.raises(JobError, match="no layer"):
        run_job(p, project, {"layer": "nope"})
    with pytest.raises(JobError, match="must stay inside"):
        run_job(p, project, {"src": "../outside.glb"}, job_id="j2")


def test_cancel_writes_no_tileset(mesh_project):
    project, _ = mesh_project
    cancel = threading.Event()
    cancel.set()
    with pytest.raises(Cancelled):
        run_job(TilesMesh(), project, {"layer": "mesh-1"}, cancel=cancel)
    assert not (project / "tilesets.json").exists()
    assert not (project / "tiles").exists()


# ---------------------------------------------------------------- tiles.cloud


@pytest.fixture
def cloud_project(tmp_path):
    rng = np.random.default_rng(3)
    n = 40_000
    local = np.stack([rng.uniform(-200, 200, n), rng.uniform(0, 30, n), rng.uniform(-200, 200, n)], 1)
    crs = np.stack([ORIGIN[0] + local[:, 0], ORIGIN[1] - local[:, 2], ORIGIN[2] + local[:, 1]], 1)
    rgb = (rng.integers(0, 256, (n, 3)) * 257).astype(np.uint16)
    (tmp_path / "clouds").mkdir()
    write_las(tmp_path / "clouds" / "site.las", crs, pdrf=7, rgb=rgb)
    layer = {
        "id": "cloud-1",
        "kind": "pointcloud",
        "name": "Site cloud",
        "format": "copc",
        "src": {"path": "clouds/site.las"},
    }
    (tmp_path / "manifest.json").write_text(json.dumps(manifest([layer])), "utf-8")
    return tmp_path, local


def test_a_cloud_becomes_a_points_tileset_keeping_every_point_once(cloud_project):
    project, local = cloud_project
    result, _ = run_job(TilesCloud(), project, {"layer": "cloud-1", "maxPointsPerTile": 4000})
    folder = project / "tiles" / "cloud-1-tiles"
    assert check_tileset(folder) == []
    ts = json.loads((folder / "tileset.json").read_text("utf-8"))
    assert ts["root"]["refine"] == "ADD"
    total = 0
    keys = set()
    for t, d in walk(ts["root"]):
        uri = t["content"]["uri"]
        key = uri.removeprefix("content/").removesuffix(".glb")
        dd, x, y, z = (int(v) for v in key.split("-"))
        assert dd == d
        keys.add((dd, x, y, z))
        _, prims = read_glb((folder / uri).read_bytes())
        total += len(prims[0]["POSITION"])
        assert prims[0]["COLOR_0"].dtype == np.uint8
        assert len(prims[0]["POSITION"]) <= 4000
    assert total == len(local)
    # COPC keys: every node's parent is in the tree.
    for d, x, y, z in keys:
        if d:
            assert (d - 1, x // 2, y // 2, z // 2) in keys
    # A point lands within 1 mm of its ECEF truth.
    ecef, _ = to_ecef(ts, (folder / ts["root"]["content"]["uri"]).read_bytes())
    truth = ecef_truth(local)
    from scipy.spatial import cKDTree

    d, _ = cKDTree(truth).query(ecef[:50])
    assert d.max() < 1e-3
    entry = json.loads((project / "tilesets.json").read_text("utf-8"))["entries"][0]
    assert entry["kind"] == "points" and entry["from"] == "cloud-1"
    assert result["outputs"]["tile"]["points"] == len(local)


def test_the_copc_info_record_sets_the_cube():
    info = struct.pack("<5d", 1.0, 2.0, 3.0, 50.0, 0.5) + bytes(120)
    cube = cube_of({("copc", 1): info}, (0, 1, 0, 1, 0, 1))
    assert isinstance(cube, Cube) and cube.half == 50.0 and cube.spacing == 0.5
    assert cube.centre.tolist() == [1.0, 2.0, 3.0]
    plain = cube_of({}, (0.0, 100.0, 0.0, 40.0, 0.0, 10.0))
    assert plain.half == 50.0 and plain.spacing == pytest.approx(100 / 128)


def test_tiles_cloud_needs_a_point_cloud_layer(cloud_project):
    project, _ = cloud_project
    with pytest.raises(JobError, match="needs: layer"):
        TilesCloud().validate({})
    with pytest.raises(JobError, match="not a point cloud"):
        m = json.loads((project / "manifest.json").read_text("utf-8"))
        m["layers"].append({"id": "m", "kind": "mesh", "src": {"path": "x.glb"}})
        (project / "manifest.json").write_text(json.dumps(m), "utf-8")
        run_job(TilesCloud(), project, {"layer": "m"})


def test_a_cancelled_tiling_resumes_to_a_valid_tileset(mesh_project):
    from aio_pipelines.runtime import Job
    from conftest import Recorder

    project, _ = mesh_project
    params = {"layer": "mesh-1", "maxTrianglesPerTile": 5000}
    cancel = threading.Event()

    def emit(method, msg):
        if method == "progress" and msg.get("step") == "read" and msg.get("state") == "done":
            cancel.set()

    with pytest.raises(Cancelled):
        Job("j1", TilesMesh(), project, params, emit, cancel).run()
    assert not (project / "tilesets.json").exists()
    out = Job("j1", TilesMesh(), project, params, Recorder(), threading.Event()).run()
    assert out["status"] == "done"
    assert check_tileset(project / "tiles" / "mesh-1-tiles") == []
