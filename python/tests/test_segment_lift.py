"""segment.lift: photo masks through a posed photo onto a point cloud, as cleanup regions with a
depth band that evaluate.py (and the viewer) apply the same way. A synthetic cloud: ground, a 6 m
block 2 m tall on it, a few points hidden under the block; a photo looking down at the block from
the west."""

import json

import numpy as np
import pytest
from PIL import Image

from aio_pipelines.multiview.vote import Camera
from aio_pipelines.pipelines import all_pipelines
from aio_pipelines.pointcloud import find_pdal
from aio_pipelines.pointcloud_cleanup.evaluate import evaluate
from aio_pipelines.pointcloud_cleanup.recipe import validate_recipe
from aio_pipelines.runtime import JobError
from aio_pipelines.segment.lift import SegmentLift, camera_view_proj, column_major, mask_ndc, world_to_local
from conftest import run_job
from pccleanup_synth import E0, N0, cloud_project
from test_inspection import look_q

needs_pdal = pytest.mark.skipif(find_pdal() is None, reason="PDAL not found (set AIO_PDAL)")
SRC = "clouds/cloud-a.copc.laz"
W, H, HFOV = 800, 600, 50.0
OFFSET = 1.5  # the layer's heightOffsetM: the file is 1.5 m lower than the cloud is shown
EYE = [8.0, 30.0, -20.0]  # local (x east, y up, z south): 12 m west of the block, 30 m up
TARGET = [20.0, 1.0, -20.0]  # the block's middle
LO, HI, TOP = 17.0, 23.0, 2.0  # the block's footprint (east and north, metres) and height


def block_cloud():
    """Points as shown (metres east, north and up from the project origin) and their part:
    0 ground beside the block, 1 its top, 2 its west side (facing the photo), 3 its other sides,
    4 hidden under it."""
    g = np.arange(0.1, 40, 0.2)
    gx, gy = np.meshgrid(g, g)
    ground = np.c_[gx.ravel(), gy.ravel(), np.zeros(gx.size)]
    ground = ground[~((ground[:, 0] > LO) & (ground[:, 0] < HI) & (ground[:, 1] > LO) & (ground[:, 1] < HI))]
    s = np.arange(LO + 0.05, HI, 0.1)
    tx, ty = np.meshgrid(s, s)
    top = np.c_[tx.ravel(), ty.ravel(), np.full(tx.size, TOP)]
    sz = np.arange(0.05, TOP, 0.1)
    a, z = np.meshgrid(s, sz)
    a, z = a.ravel(), z.ravel()
    west = np.c_[np.full(a.size, LO), a, z]
    others = np.vstack(
        [np.c_[np.full(a.size, HI), a, z], np.c_[a, np.full(a.size, LO), z], np.c_[a, np.full(a.size, HI), z]]
    )
    h = np.arange(18.6, 21.5, 0.4)
    hx, hy = np.meshgrid(h, h)
    hidden = np.c_[hx.ravel(), hy.ravel(), np.zeros(hx.size)]
    parts = [ground, top, west, others, hidden]
    return np.vstack(parts), np.repeat(np.arange(5), [len(p) for p in parts])


def camera(eye=EYE, target=TARGET) -> Camera:
    return Camera.from_pose(eye, look_q(eye, target), HFOV, W, H)


def hull(points: np.ndarray) -> np.ndarray:
    """Convex hull, counter-clockwise (monotone chain)."""
    pts = sorted(map(tuple, points))

    def turn(o, a, b):
        return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])

    def half(seq):
        out: list[tuple[float, float]] = []
        for p in seq:
            while len(out) >= 2 and turn(out[-2], out[-1], p) <= 0:
                out.pop()
            out.append(p)
        return out[:-1]

    return np.array(half(pts) + half(pts[::-1]))


def block_mask(scale=0.5, shrink=0.97):
    """The block's outline in the photo, as a segmenter would give it (just inside the edges), in
    pixels of the photo at ``scale``."""
    corners = np.array([[x, z, -y] for x in (LO, HI) for y in (LO, HI) for z in (0.0, TOP)])
    uv, ok = camera().project(corners)
    assert ok.all()
    ring = hull(uv + 0.5)  # pixel centres to positions from the top left corner
    ring = ring.mean(axis=0) + (ring - ring.mean(axis=0)) * shrink
    return {"layer": "photos", "photo": "p1", "polygon": (ring * scale).tolist(),
            "width": int(W * scale), "height": int(H * scale), "label": "Mask on p1"}  # fmt: skip


def lift_project(tmp_path):
    shown, part = block_cloud()
    world = shown + np.array([E0, N0, -OFFSET])  # the file's coordinates
    root = cloud_project(tmp_path, np.round(world, 3), np.ones(len(world), dtype=np.uint8))
    (root / "photos").mkdir()
    items = []
    for pid, eye, target in (("p1", EYE, TARGET), ("sky", EYE, [8.0, 60.0, -20.5])):
        Image.new("RGB", (W, H), (90, 90, 90)).save(root / "photos" / f"{pid}.jpg")
        items.append({"id": pid, "src": {"path": f"photos/{pid}.jpg"}, "pos": eye, "q": look_q(eye, target),
                      "lens": {"model": "pinhole", "hfovDeg": HFOV, "aspect": W / H}})  # fmt: skip
    items.append({"id": "nopose", "src": {"path": "photos/p1.jpg"}})
    manifest = json.loads((root / "manifest.json").read_text("utf-8"))
    manifest["layers"][0]["heightOffsetM"] = OFFSET
    manifest["layers"].append(
        {"kind": "photos", "id": "photos", "name": "Photos", "visible": True, "items": items}
    )
    (root / "manifest.json").write_text(json.dumps(manifest, indent=2), "utf-8")
    return root, world, part


def test_is_registered():
    assert isinstance(all_pipelines()["segment.lift"], SegmentLift)


def test_clip_w_is_the_depth_along_the_camera_and_ndc_matches_the_photo():
    cam = camera()
    m = camera_view_proj(cam, 0.5, 200.0) @ world_to_local([E0, N0, 0.0], (0.0, 0.0), 0.0)
    shown = np.array([[20.0, 20.0, 1.0], [LO, LO, TOP], [30.0, 25.0, 0.0]])
    h = np.c_[shown + np.array([E0, N0, 0.0]), np.ones(3)]
    stored = np.asarray(column_major(m)).reshape(4, 4).T  # as evaluate.py reads it back
    assert stored == pytest.approx(m)
    clip = h @ stored.T
    local = np.c_[shown[:, 0], shown[:, 2], -shown[:, 1]]
    depth = (local - cam.pos) @ cam.fwd
    assert clip[:, 3] == pytest.approx(depth)
    uv, _ = cam.project(local)
    ndc = mask_ndc({"polygon": (uv + 0.5).tolist(), "width": W, "height": H})
    assert clip[:, 0] / clip[:, 3] == pytest.approx(ndc[:, 0])
    assert clip[:, 1] / clip[:, 3] == pytest.approx(ndc[:, 1])
    assert clip[0, :2] / clip[0, 3] == pytest.approx([0, 0], abs=1e-9)  # the target is the middle


def test_the_frame_carries_the_date_shift_and_the_height_offset():
    m = world_to_local([100.0, 200.0, 10.0], (3.0, -4.0), 1.5)
    # the file's point (103, 206, 8.5) is shown at (106, 202, 10): local x 6, y 0, z -2
    assert (m @ [103.0, 206.0, 8.5, 1.0]).tolist() == pytest.approx([6.0, 0.0, -2.0, 1.0])


MASK = {"layer": "photos", "photo": "p1", "polygon": [[0, 0], [10, 0], [10, 10]], "width": 400, "height": 300}
PARAMS = {"layerId": "cloud-a", "src": SRC, "masks": [MASK]}


@pytest.mark.parametrize(
    "params, message",
    [
        ({**PARAMS, "extra": 1}, "does not take: extra"),
        ({**PARAMS, "masks": []}, "1 to 50"),
        ({**PARAMS, "masks": [MASK] * 51}, "1 to 50"),
        ({**PARAMS, "masks": [{**MASK, "polygon": [[0, 0], [1, 1]]}]}, "3 to 256"),
        ({**PARAMS, "masks": [{**MASK, "polygon": [[0, 0], [1, "a"], [2, 2]]}]}, "pixel positions"),
        ({**PARAMS, "masks": [{**MASK, "width": 8}]}, "width"),
        ({**PARAMS, "masks": [{**MASK, "label": "x" * 121}]}, "label"),
        ({**PARAMS, "masks": [{**MASK, "colour": "red"}]}, "does not take: colour"),
        ({**PARAMS, "src": "../x.copc.laz"}, "inside the project"),
        ({**PARAMS, "layerId": "a/b"}, "layer id"),
    ],
)
def test_validate_refuses(params, message):
    with pytest.raises(JobError, match=message):
        SegmentLift().validate(params)


@needs_pdal
def test_a_mask_lifts_to_the_block_the_photo_saw(tmp_path):
    root, world, part = lift_project(tmp_path)
    masks = [
        block_mask(),
        {**MASK, "photo": "nopose"},
        {**MASK, "photo": "sky", "width": 800, "height": 600},
    ]
    result, _ = run_job(SegmentLift(), root, {**PARAMS, "masks": masks}, job_id="j-lift")
    out = result["outputs"]["commit"]
    saved = json.loads((root / "edits/pointcloud/cloud-a.lift-j-lift.json").read_text("utf-8"))
    assert saved == out
    reasons = {s["photo"]: s["reason"] for s in out["skipped"]}
    assert "position" in reasons["nopose"]
    assert "does not look at the point cloud" in reasons["sky"]
    region = out["regions"][0]
    assert region["photo"] == "p1" and region["label"] == "Mask on p1"
    assert region["points"] > 0
    assert 0 < region["depth"]["near"] < region["depth"]["far"]
    # the region, added to a recipe as a class, selects the block the photo saw, through evaluate.py
    recipe = validate_recipe(
        {"schema": "aio.pccleanup/1", "layerId": "cloud-a", "hiddenClasses": [],
         "regions": [{"id": "r", "shape": "lasso", "viewProj": region["viewProj"], "polygon": region["polygon"],
                      "depth": region["depth"], "action": {"kind": "class", "value": 6}}]}
    )  # fmt: skip
    _, cls = evaluate(recipe, world, np.ones(len(world), dtype=np.uint8))
    taken = cls == 6
    seen = (part == 1) | (part == 2)
    assert taken[seen].mean() > 0.9  # the top and the west side
    assert not taken[part == 4].any()  # nothing hidden under it
    # no ground beside the block, but for ground hidden behind its north and south sides right at
    # their foot (one depth band a mask: inside the outline, as deep as the block's far top edge)
    shown = world - [E0, N0, -OFFSET]
    beside = shown[taken & (part == 0)]
    gap = np.maximum(np.maximum(LO - beside[:, :2], beside[:, :2] - HI), 0).max(axis=1)
    assert np.all(gap <= 0.15) and len(beside) <= 0.005 * taken.sum()
    assert np.all((beside[:, 0] > LO) & (beside[:, 0] < HI))  # never past the west side it faces
    assert taken.sum() >= region["points"]  # every point it saw inside the outline, at least


@needs_pdal
def test_a_mask_on_ground_beside_the_block_takes_ground_only(tmp_path):
    root, world, part = lift_project(tmp_path)
    cam = camera()
    # a small square on the ground west of the block, in the photo's pixels
    corners = np.array([[x, 0.0, -y] for x, y in ((12, 18), (14, 18), (14, 22), (12, 22))])
    uv, ok = cam.project(corners)
    assert ok.all()
    mask = {"layer": "photos", "photo": "p1", "polygon": (uv + 0.5).tolist(), "width": W, "height": H}
    result, _ = run_job(SegmentLift(), root, {**PARAMS, "masks": [mask]}, job_id="j-ground")
    region = result["outputs"]["commit"]["regions"][0]
    recipe = validate_recipe(
        {"schema": "aio.pccleanup/1", "layerId": "cloud-a", "hiddenClasses": [],
         "regions": [{"id": "r", "shape": "lasso", "viewProj": region["viewProj"], "polygon": region["polygon"],
                      "depth": region["depth"], "action": {"kind": "delete"}}]}
    )  # fmt: skip
    state, _ = evaluate(recipe, world, np.ones(len(world), dtype=np.uint8))
    taken = state == 3
    assert taken.sum() == region["points"]  # flat ground in plain view: what it saw is what it takes
    assert taken.any() and not taken[part != 0].any()
    shown = world - [E0, N0, -OFFSET]
    assert np.all((shown[taken, 0] > 11.5) & (shown[taken, 0] < 14.5))
