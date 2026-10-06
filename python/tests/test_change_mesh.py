"""change.mesh: model deviation and the tagged part diff (synthetic models only)."""

import json
import threading

import numpy as np
import pytest
import trimesh

from aio_pipelines.change.changeset import validate_change_set
from aio_pipelines.change.mesh import ChangeMesh, part_names
from aio_pipelines.runtime import Job, JobError
from conftest import Recorder

IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
# glTF is Y up: a part stands on y = 0


def block(cx, cz, size=(2.0, 2.0, 2.0)):
    m = trimesh.creation.box(extents=size)
    m.apply_translation([cx, size[1] / 2, cz])
    return m


def tank(cx, cz, radius=2.0, height=4.0, dent=0.0):
    m = trimesh.creation.cylinder(radius=radius, height=height, sections=72)
    m.apply_transform(trimesh.transformations.rotation_matrix(-np.pi / 2, [1, 0, 0]))  # axis Z to Y
    m.apply_translation([0, height / 2, 0])
    m = m.subdivide_to_size(max_edge=0.15, max_iter=12)
    if dent:
        v = m.vertices.copy()
        ang = np.arctan2(v[:, 2], v[:, 0])
        r = np.hypot(v[:, 0], v[:, 2])
        side = r > radius * 0.99
        bump = np.clip(1 - (ang / np.radians(30)) ** 2, 0, 1) * np.clip(1 - ((v[:, 1] - 2) / 1.2) ** 2, 0, 1)
        push = np.where(side, dent * bump, 0)
        v[:, 0] -= push * np.cos(ang)
        v[:, 2] -= push * np.sin(ang)
        m = trimesh.Trimesh(v, m.faces, process=False)
    m.apply_translation([cx, 0, cz])
    return m


def glb(path, parts):
    scene = trimesh.Scene()
    for name, mesh in parts.items():
        scene.add_geometry(mesh, node_name=name, geom_name=name)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(scene.export(file_type="glb"))


def project(tmp_path, before, after, captures=True):
    root = tmp_path / "proj"
    glb(root / "models" / "site-e1.glb", before)
    glb(root / "models" / "site-e2.glb", after)
    layers = [
        {
            "kind": "mesh",
            "id": lid,
            "name": f"Site {lid}",
            "src": {"path": f"models/site-{lid}.glb"},
            "transform": IDENTITY,
            **({"capture": cap} if captures else {}),
            "tags": [{"node": n, "tag": n.split("_")[0]} for n in parts],
        }
        for lid, cap, parts in (("e1", "c1", before), ("e2", "c2", after))
    ]
    manifest = {
        "schema": "aio.project/1",
        "id": "p",
        "crs": {"epsg": 32639},
        "origin": [500000, 3200000, 0],
        "captures": [{"id": "c1", "date": "2026-01-01"}, {"id": "c2", "date": "2026-02-01"}],
        "layers": layers,
    }
    (root / "manifest.json").write_text(json.dumps(manifest))
    return root


def run(root, params, job_id="j1"):
    return Job(job_id, ChangeMesh(), root, params, Recorder(), threading.Event()).run()


def test_the_survey_key_is_stripped_only_when_every_node_carries_the_same_one():
    assert part_names(["P01_e1", "P02_e1", "T-101_e1"]) == {
        "P01_e1": "P01",
        "P02_e1": "P02",
        "T-101_e1": "T-101",
    }
    assert part_names(["P01_e1", "P02_e2"]) == {"P01_e1": "P01_e1", "P02_e2": "P02_e2"}
    assert part_names(["Tank", "Pipe"]) == {"Tank": "Tank", "Pipe": "Pipe"}


def test_validate_fills_the_defaults():
    v = ChangeMesh().validate({"layerFrom": "a", "layerTo": "b"})
    assert v["minDistM"] == 0.05 and v["maxDistM"] == 0.3 and v["samples"] == 50_000
    with pytest.raises(JobError, match="does not take"):
        ChangeMesh().validate({"layerFrom": "a", "layerTo": "b", "colour": 1})
    with pytest.raises(JobError, match="samples"):
        ChangeMesh().validate({"layerFrom": "a", "layerTo": "b", "samples": 10})


def scenes():
    before = {
        "P01_e1": block(0, 0),
        "P02_e1": tank(10, 0),
        "P03_e1": block(-10, 0),
        "P04_e1": block(0, 10),
    }
    after = {
        "P01_e2": block(0, 0),
        "P02_e2": tank(10, 0, dent=0.2),
        "P04_e2": block(0.5, 10),
        "P05_e2": block(-10, 10, size=(1.0, 3.0, 1.0)),
    }
    return before, after


def test_parts_added_removed_moved_and_a_dent_are_found(tmp_path):
    before, after = scenes()
    root = project(tmp_path, before, after)
    result = run(root, {"layerFrom": "e1", "layerTo": "e2", "samples": 5000})
    assert result["status"] == "done"
    cs = validate_change_set(json.loads((root / "change" / "c1-c2-mesh.json").read_text()))
    assert cs["producer"] == "change.mesh" and cs["from"] == "c1" and cs["to"] == "c2"
    by_part = {i["part"]: i for i in cs["items"]}
    assert {p: i["verdict"] for p, i in by_part.items()} == {
        "P01": "unchanged",
        "P02": "changed",
        "P03": "removed",
        "P04": "moved",
        "P05": "added",
    }
    moved = by_part["P04"]
    assert moved["offsetM"] == pytest.approx([0.5, 0, 0], abs=0.01)
    assert moved["nodeFrom"] == "P04_e1" and moved["nodeTo"] == "P04_e2"
    assert moved["layerFrom"] == "e1" and moved["layerTo"] == "e2"
    assert moved["id"] == "component:P04" and moved["kind"] == "component"
    assert by_part["P02"]["deviation"]["maxM"] == pytest.approx(0.2, abs=0.02)
    assert by_part["P05"]["nodeTo"] == "P05_e2" and "nodeFrom" not in by_part["P05"]
    assert by_part["P03"]["nodeFrom"] == "P03_e1" and "nodeTo" not in by_part["P03"]
    # local frame: the added part stands at x -10, z 10
    assert by_part["P05"]["at"][0] == pytest.approx(-10, abs=0.01)
    assert by_part["P05"]["at"][2] == pytest.approx(10, abs=0.01)
    assert cs["registration"]["ok"] is True
    assert cs["stats"]["parts"] == 5 and cs["stats"]["moved"] == 1

    m = json.loads((root / "manifest.json").read_text())
    layer = next(x for x in m["layers"] if x["id"] == "c1-c2-mesh")
    assert layer["kind"] == "mesh" and layer["capture"] == "c2"
    assert layer["derived"]["kind"] == "change" and layer["derived"]["source"] == ["e1", "e2"]
    assert layer["transform"] == IDENTITY
    assert layer["tags"] == [{"node": n, "tag": n.split("_")[0]} for n in after]
    assert cs["layers"] == ["c1-c2-mesh"]

    # the deviation model: the later parts by node name, coloured per vertex
    dev = trimesh.load(str(root / layer["src"]["path"]), force="scene")
    assert set(dev.graph.nodes_geometry) == set(after)
    tank_geom = dev.geometry[dev.graph["P02_e2"][1]]
    assert tank_geom.visual.kind == "vertex"
    colours = np.asarray(tank_geom.visual.vertex_colors)[:, :3].astype(int)
    assert len({tuple(c) for c in colours}) > 3  # the dent is coloured, the rest grey
    flat = dev.geometry[dev.graph["P01_e2"][1]]
    assert len({tuple(c) for c in np.asarray(flat.visual.vertex_colors)[:, :3]}) == 1


def test_models_that_do_not_line_up_are_refused(tmp_path):
    before, _ = scenes()
    after = {n.replace("_e1", "_e2"): m.copy().apply_translation([0, 0.2, 0]) for n, m in before.items()}
    root = project(tmp_path, before, after)
    with pytest.raises(JobError, match="not aligned"):
        run(root, {"layerFrom": "e1", "layerTo": "e2", "samples": 2000})
    assert not (root / "change" / "c1-c2-mesh.json").exists()


def test_a_layer_that_is_not_a_model_is_refused(tmp_path):
    before, after = scenes()
    root = project(tmp_path, before, after)
    m = json.loads((root / "manifest.json").read_text())
    m["layers"].append(
        {"kind": "pointcloud", "id": "pc", "name": "PC", "src": {"path": "x"}, "format": "copc"}
    )
    (root / "manifest.json").write_text(json.dumps(m))
    with pytest.raises(JobError, match="not a 3D model"):
        run(root, {"layerFrom": "e1", "layerTo": "pc", "captures": {"from": "c1", "to": "c2"}})
