"""``segment.lift``: photo masks through their photos' cameras onto a point cloud (pack 0.35.0).

Each mask is an outline in the pixels of a posed photo. The job reads the cloud (PDAL to a staged
LAS, then numpy in chunks, as ``pointcloud.clean`` does) and, per photo, projects every point
through the photo's camera. A coarse depth buffer over the photo (cells of ``CELL_SHARE`` of its
long edge) keeps the points the photo saw: those within ``max(SEEN_MIN_M, SEEN_SHARE * depth)`` of
the nearest depth in their cell. The seen points inside the outline give the region's depth band,
their nearest and farthest depth widened by ``BAND_MARGIN_M``.

The answer has one ``LiftedRegion`` per mask (``packages/schema/src/pointcloudCleanup.ts``): a lasso
in the camera's clip space (``viewProj``, world to clip, column-major, as the viewer's regions), the
outline in NDC and the depth band. ``evaluate.py`` and the viewer select a point for it when its
clip ``w`` (the depth along the camera's axis, metres) lies in the band and it falls inside the
outline, so the region takes the surface the photo saw, not what lies far behind it. One band per
mask: a point hidden from the photo inside the outline at a depth within the band is taken too (the
ground just behind the foot of a wall the photo sees, for one).

Frames: the region is in world coordinates (project CRS, like the COPC header), as every cleanup
region. The camera is in the project's local frame (x east, y up, z south from the origin) where the
viewer shows the photo (``multiview.scene.cameras``: the photo's date line-up applied); the cloud is
shown at its file's coordinates moved by its date shift and its ``heightOffsetM``
(``cloudFrameOrigin`` in packages/schema/src/cloudFrame.ts), and the matrix carries that move.

Masks whose photo has no pose, sees none of the cloud or sees none of it inside the outline are
listed in ``skipped`` with a sentence. The result is written to
``edits/pointcloud/<layer>.lift-<job>.json`` and is the job's result.
"""

from __future__ import annotations

import math
from typing import Any

import numpy as np

from ..captures import date_shift
from ..change.sources import height_offset_m
from ..params import known_keys, text
from ..pointcloud import check_space, read_summary
from ..pointcloud_cleanup.evaluate import in_polygon
from ..pointcloud_cleanup.lasstream import chunks, read_head, xyz_of
from ..pointcloud_cleanup.pipeline import (
    _cloud_layer,
    _layer_id,
    _manifest,
    _pdal,
    _src,
    stage_plain_las,
    staged_record_length,
)
from ..runtime import JobError, Step, StepContext, atomic_write_json, commit_files
from ..spaces import layer_frame

LIFT_DIR = "edits/pointcloud"
MAX_MASKS = 50
MAX_VERTICES = 256
CELL_SHARE = 0.005  # a depth buffer cell, as a share of the photo's long edge
SEEN_MIN_M = 0.15  # a point within this of its cell's nearest depth was seen...
SEEN_SHARE = 0.01  # ...or within this share of that depth, whichever is more
BAND_MARGIN_M = 0.1  # the depth band reaches this far past the nearest and farthest seen point
ASPECT_TOLERANCE = 0.02  # a mask whose width / height differs more from its photo's is another image
NDC_LIMIT = 100.0  # the contract's NDC range for an outline vertex


def _finite(v: Any) -> bool:
    return isinstance(v, int | float) and not isinstance(v, bool) and math.isfinite(v)


def _mask(raw: Any, i: int) -> dict[str, Any]:
    if not isinstance(raw, dict):
        raise JobError(f"Mask {i + 1} needs a photo, an outline and the photo's size.")
    known_keys(raw, {"layer", "photo", "polygon", "width", "height", "label"}, f"Mask {i + 1}")
    poly = raw.get("polygon")
    if not isinstance(poly, list) or not 3 <= len(poly) <= MAX_VERTICES:
        raise JobError(f"The outline of mask {i + 1} has 3 to {MAX_VERTICES} points.")
    if not all(isinstance(p, list) and len(p) == 2 and all(_finite(c) for c in p) for p in poly):
        raise JobError(f"The outline of mask {i + 1} is a list of pixel positions.")
    size = {}
    for key in ("width", "height"):
        v = raw.get(key)
        if not (isinstance(v, int) and not isinstance(v, bool) and 16 <= v <= 100000):
            raise JobError(f"The {key} of mask {i + 1} is a whole number of pixels from 16 to 100000.")
        size[key] = v
    out = {
        "layer": text(raw, "layer", required=True),
        "photo": text(raw, "photo", required=True),
        "polygon": [[float(x), float(y)] for x, y in poly],
        **size,
    }
    label = raw.get("label")
    if label is not None:
        if not isinstance(label, str) or len(label) > 120:
            raise JobError(f"The label of mask {i + 1} is text of at most 120 characters.")
        out["label"] = label
    return out


def world_to_local(origin: list[float], shift: tuple[float, float], offset_m: float) -> np.ndarray:
    """The cloud's file coordinates (E, N, H) to the local frame the viewer shows it in: moved by
    the date ``shift`` (east, north) and ``offset_m`` up, then x east, y up, z south from ``origin``."""
    oe, on, oh = (float(v) for v in origin)
    se, sn = shift
    return np.array(
        [
            [1.0, 0.0, 0.0, se - oe],
            [0.0, 0.0, 1.0, offset_m - oh],
            [0.0, -1.0, 0.0, on - sn],
            [0.0, 0.0, 0.0, 1.0],
        ]
    )


def camera_view_proj(cam: Any, near: float, far: float) -> np.ndarray:
    """A ``multiview.vote.Camera`` as an OpenGL view and perspective (local frame to clip): clip
    ``w`` is the depth along the camera's axis, NDC x runs right and y up over the photo."""
    view = np.eye(4)
    view[0, :3], view[1, :3], view[2, :3] = cam.right, cam.up, -cam.fwd
    view[:3, 3] = -view[:3, :3] @ cam.pos
    proj = np.zeros((4, 4))
    proj[0, 0], proj[1, 1] = 1.0 / cam.th, 1.0 / cam.tv
    proj[2, 2], proj[2, 3] = (far + near) / (near - far), 2 * far * near / (near - far)
    proj[3, 2] = -1.0
    return proj @ view


def column_major(m: np.ndarray) -> list[float]:
    """A matrix as the recipe stores it (``evaluate.py`` reads it back with ``reshape(4, 4).T``)."""
    return [float(v) for v in np.asarray(m, float).T.ravel()]


def mask_ndc(mask: dict[str, Any]) -> np.ndarray:
    """The outline in NDC: pixel positions measured from the photo's top left corner, y down."""
    p = np.asarray(mask["polygon"], float)
    x = p[:, 0] / mask["width"] * 2 - 1
    y = 1 - p[:, 1] / mask["height"] * 2
    return np.clip(np.column_stack([x, y]), -NDC_LIMIT, NDC_LIMIT)


class _View:
    """One photo's camera over the cloud: world to clip, and its depth buffer."""

    def __init__(self, cam: Any, to_local: np.ndarray):
        self.cam = cam
        self.to_local = to_local
        # the depth row does not change x, y or w: a placeholder until the cloud's depths are known
        self.m = camera_view_proj(cam, 0.1, 1000.0) @ to_local
        self.cell = max(1.0, CELL_SHARE * max(cam.width, cam.height))
        self.nx = math.ceil(cam.width / self.cell)
        self.ny = math.ceil(cam.height / self.cell)
        self.zbuf = np.full(self.nx * self.ny, np.inf)
        self.w_min, self.w_max = np.inf, 0.0

    def clip(self, xyz: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        """NDC x, y and clip w of world points, as ``evaluate.py`` computes them."""
        h = np.concatenate([xyz, np.ones((len(xyz), 1))], axis=1)
        c = h @ self.m.T
        w = c[:, 3]
        with np.errstate(divide="ignore", invalid="ignore"):
            return c[:, 0] / w, c[:, 1] / w, w

    def cells(self, nx: np.ndarray, ny: np.ndarray, w: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        """Whether each point is in front and inside the frame, and its depth buffer cell."""
        ok = (w > 1e-6) & (np.abs(nx) <= 1) & (np.abs(ny) <= 1)
        ix = np.clip(((nx + 1) / 2 * self.cam.width / self.cell).astype(np.int64, copy=False), 0, self.nx - 1)
        iy = np.clip(
            ((1 - ny) / 2 * self.cam.height / self.cell).astype(np.int64, copy=False), 0, self.ny - 1
        )
        return ok, np.where(ok, iy * self.nx + ix, 0)

    def fill(self, xyz: np.ndarray) -> None:
        nx, ny, w = self.clip(xyz)
        ok, idx = self.cells(nx, ny, w)
        if ok.any():
            np.minimum.at(self.zbuf, idx[ok], w[ok])
            self.w_min = min(self.w_min, float(w[ok].min()))
            self.w_max = max(self.w_max, float(w[ok].max()))

    def seen(self, xyz: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
        """NDC x, y, w and whether the photo saw each point (nearest in its cell, within tolerance)."""
        nx, ny, w = self.clip(xyz)
        ok, idx = self.cells(nx, ny, w)
        z = self.zbuf[idx]
        return nx, ny, w, ok & (w <= z + np.maximum(SEEN_MIN_M, SEEN_SHARE * z))

    def finish(self) -> None:
        """The depth row from the cloud's depths: the near and far planes take every point in view."""
        if np.isfinite(self.w_min):
            near = max(0.01, 0.5 * self.w_min)
            far = max(near * 2, 2.0 * self.w_max)
            self.m = camera_view_proj(self.cam, near, far) @ self.to_local


class SegmentLift:
    name = "segment.lift"
    title = "Lift photo masks onto a point cloud"
    description = (
        "Projects object outlines drawn on posed photos onto a point cloud, keeping the surface each "
        "photo saw, as classification regions."
    )

    def validate(self, params: dict[str, Any]) -> dict[str, Any]:
        known_keys(params, {"layerId", "src", "masks"}, self.name)
        masks = params.get("masks")
        if not isinstance(masks, list) or not 1 <= len(masks) <= MAX_MASKS:
            raise JobError(f"Lift 1 to {MAX_MASKS} masks at a time.")
        return {
            "layerId": _layer_id(params),
            "src": _src(params),
            "masks": [_mask(m, i) for i, m in enumerate(masks)],
        }

    def inputs(self, params: dict[str, Any]) -> list[str]:
        return [params["src"]]

    def plan(self, params: dict[str, Any]) -> list[Step]:
        lid = params["layerId"]

        def stage(ctx: StepContext) -> dict[str, Any]:
            _cloud_layer(ctx.project, lid, params["src"])
            pdal = _pdal()
            src = ctx.input(params["src"])
            count = int(read_summary(ctx, pdal, src).get("num_points") or 0)
            check_space(
                ctx.staging, count * staged_record_length(src, extra_dims=False), what="Lifting the masks"
            )
            stage_plain_las(ctx, pdal, src, ctx.stage("source.las"), "Reading the cloud", (0.02, 0.3))
            return {"points": count}

        def lift(ctx: StepContext) -> dict[str, Any]:
            result = self._lift(ctx, lid, params["src"], params["masks"])
            ctx.stage("source.las").unlink(missing_ok=True)
            return result

        def commit(ctx: StepContext) -> dict[str, Any]:
            result = ctx.outputs("lift")
            atomic_write_json(ctx.stage("lift.json"), result)
            commit_files(ctx, [("lift.json", f"{LIFT_DIR}/{lid}.lift-{ctx.job.job_id}.json")])
            return result

        return [
            Step("stage", "Read the cloud", stage, weight=3),
            Step("lift", "Lift the masks", lift, weight=3),
            Step("commit", "Save the result", commit, weight=0.2),
        ]

    def _views(
        self, ctx: StepContext, layer: dict[str, Any], masks: list[dict[str, Any]]
    ) -> tuple[dict[tuple[str, str], _View], dict[int, str]]:
        """The camera of each mask's photo, or why it has none (by mask index)."""
        from ..inspection import frame as Fr
        from ..multiview.scene import cameras

        _, manifest = _manifest(ctx.project)
        frame = layer_frame(manifest, layer)
        shift = date_shift(manifest, str(layer["id"]))
        to_local = world_to_local(frame["origin"], (float(shift[0]), float(shift[1])), height_offset_m(layer))
        photo_layers = {str(x.get("id")): x for x in Fr.photo_layers(manifest)}
        cams: dict[str, dict[str, Any]] = {}
        views: dict[tuple[str, str], _View] = {}
        skipped: dict[int, str] = {}
        for i, m in enumerate(masks):
            pl = photo_layers.get(m["layer"])
            if pl is None:
                skipped[i] = "The photo's layer is not in the project any more."
                continue
            if layer_frame(manifest, pl) != frame:
                skipped[i] = "The photo is in another space than the point cloud."
                continue
            if m["layer"] not in cams:
                cams[m["layer"]] = cameras(ctx.project, manifest, m["layer"])
            cam = cams[m["layer"]].get(m["photo"])
            if cam is None:
                skipped[i] = "The photo has no position and direction, so its mask cannot be lifted."
                continue
            if (
                abs(m["width"] / m["height"] - cam.width / cam.height)
                > ASPECT_TOLERANCE * cam.width / cam.height
            ):
                skipped[i] = "The mask is not the shape of its photo."
                continue
            key = (m["layer"], m["photo"])
            if key not in views:
                views[key] = _View(cam, to_local)
        return views, skipped

    def _lift(self, ctx: StepContext, lid: str, src: str, masks: list[dict[str, Any]]) -> dict[str, Any]:
        layer = _cloud_layer(ctx.project, lid, src)
        views, skipped = self._views(ctx, layer, masks)
        las = ctx.stage("source.las")
        head = read_head(las)
        total = max(head.count, 1)
        done = 0
        # pass 1: each photo's depth buffer over the whole cloud
        for rec in chunks(las, head):
            ctx.check()
            xyz = xyz_of(head, rec)
            for v in views.values():
                v.fill(xyz)
            done += len(rec)
            ctx.progress(0.3 + 0.3 * done / total, "Finding what each photo saw")
        for v in views.values():
            v.finish()
        live = [i for i in range(len(masks)) if i not in skipped]
        rings = {i: mask_ndc(masks[i]) for i in live}
        seen_n = dict.fromkeys(live, 0)
        w_lo = dict.fromkeys(live, np.inf)
        w_hi = dict.fromkeys(live, -np.inf)
        # pass 2: the seen points inside each outline
        done = 0
        for rec in chunks(las, head):
            ctx.check()
            xyz = xyz_of(head, rec)
            by_view: dict[tuple[str, str], tuple[np.ndarray, ...]] = {}
            for i in live:
                key = (masks[i]["layer"], masks[i]["photo"])
                if key not in by_view:
                    by_view[key] = views[key].seen(xyz)
                nx, ny, w, seen = by_view[key]
                if not seen.any():
                    continue
                inside = np.zeros(len(w), dtype=bool)
                inside[seen] = in_polygon(rings[i], nx[seen], ny[seen])
                if inside.any():
                    seen_n[i] += int(inside.sum())
                    w_lo[i] = min(w_lo[i], float(w[inside].min()))
                    w_hi[i] = max(w_hi[i], float(w[inside].max()))
            done += len(rec)
            ctx.progress(0.6 + 0.35 * done / total, "Lifting the masks")
        regions: list[dict[str, Any]] = []
        for i, m in enumerate(masks):
            if i in skipped:
                continue
            v = views[(m["layer"], m["photo"])]
            if not np.isfinite(v.w_min):
                skipped[i] = "The photo does not look at the point cloud."
                continue
            if seen_n[i] == 0:
                skipped[i] = "The photo sees no point of the cloud inside the mask."
                continue
            region = {
                "photo": m["photo"],
                "viewProj": column_major(v.m),
                "polygon": [[float(x), float(y)] for x, y in rings[i]],
                "depth": {"near": max(0.0, w_lo[i] - BAND_MARGIN_M), "far": w_hi[i] + BAND_MARGIN_M},
                "points": seen_n[i],
                **({"label": m["label"]} if "label" in m else {}),
            }
            regions.append(region)
        skips = [{"photo": masks[i]["photo"], "reason": skipped[i]} for i in sorted(skipped)]
        ctx.log(f"Lifted {len(regions)} of {len(masks)} masks onto the cloud.")
        return {"regions": regions, "skipped": skips}
