"""walk.track: the drafts of a detections pass on 360 walk frames as one draft per object, placed
from the walk pose (``walktrack``; vision 3.9). Parameters as ``WalkTrackParams`` in
packages/schema: ``pass`` (``detections/<name>.json``) and optionally ``layer`` (a walk layer id:
only its frames are tracked).

Steps:

1. **track** reads the pass (and its sha256), the walk poses (``walks/<id>/pose.json``) and the
   project's surface (meshes, else point clouds), runs the tracker and stages the result.
2. **commit** reads the pass again; when it changed since step 1 (sha256), it tracks again from the
   new file. A pass the tracker leaves as it was is not written at all (``unchanged``), so a run
   with no repeated object keeps the file byte for byte.

Placement problems never fail the job: a surface that does not load is left out and a tracker
error keeps the drafts as they were, each with a warning.

Outputs: ``pass``, ``objects`` (tracks, one-frame ones included), ``merged`` (drafts folded into
another), ``placed``, ``placedOn`` (counts per ``mesh``, ``cloud``, ``rays``, ``ground``),
``unplaced`` (tracks of two or more frames with no point), ``droppedOnReviewed`` (new drafts of an
object already accepted or rejected, left out) and ``unchanged``.
"""

from __future__ import annotations

import hashlib
import json
import re
from typing import Any

from ..params import known_keys
from ..runtime import Cancelled, JobError, Step, StepContext, atomic_write_json, commit_files
from . import walktrack as T

PASS = re.compile(r"^detections/[A-Za-z0-9._-]{1,120}\.json$")
DETECTIONS_SCHEMA = "aio.detections/1"
STAGED = "pass.json"
META = "track.json"


def frame_times(doc: dict[str, Any]) -> dict[str, list[float]]:
    """The sampled frames a walk pass names in ``assessed`` (``t:<ms>``), per its layer, in seconds."""
    layer, assessed = doc.get("layer"), doc.get("assessed")
    if not isinstance(layer, str) or not isinstance(assessed, list):
        return {}
    ts = []
    for a in assessed:
        if isinstance(a, str) and a.startswith("t:"):
            try:
                ts.append(int(a[2:]) / 1000.0)
            except ValueError:
                continue
    return {layer: ts} if ts else {}


def track_doc(
    ctx: StepContext, doc: dict[str, Any], only: str | None
) -> tuple[dict[str, Any], dict[str, Any]]:
    """The pass with its walk frame drafts tracked, and the counts. Never fails on placement."""
    from ..multiview.scene import cloud_surface, mesh_surface
    from .frame import read_manifest

    dets = [d for d in doc.get("detections") or []]
    empty = {"objects": 0, "merged": 0, "placed": 0, "placedOn": {}, "unplaced": 0, "droppedOnReviewed": 0}
    manifest = read_manifest(ctx.project)
    walks = [
        x
        for x in manifest.get("layers") or []
        if isinstance(x, dict) and x.get("kind") == "walk" and (only is None or x.get("id") == only)
    ]
    on_walk = {d["frame"]["layer"] for d in dets if isinstance(d, dict) and T.is_frame_draft(d)} & {
        str(x.get("id")) for x in walks
    }
    if not on_walk:
        return doc, empty
    poses = {str(x["id"]): T.read_pose(ctx.project, x) for x in walks if x.get("id") in on_walk}
    for lay, p in poses.items():
        if p is None:
            ctx.log(f'The walk "{lay}" is not placed yet: its objects are tracked but not placed.', "info")
    heights = {str(x["id"]): T.walk_height(x) for x in walks if x.get("id") in on_walk}
    surface = None
    if any(p is not None for p in poses.values()):
        try:
            surface = mesh_surface(ctx.project, manifest) or cloud_surface(ctx, manifest)
        except Cancelled:
            raise
        except Exception as e:  # placing falls back to rays and the ground
            ctx.log(f"The project's surface could not be read for placing: {e}", "warn")
    try:
        out, stats = T.track_frames(
            dets,
            poses,
            surface,
            heights,
            ctx.check,
            lambda f, m=None: ctx.progress(0.2 + 0.8 * f, m),
            assessed=frame_times(doc),
        )
    except Cancelled:
        raise
    except Exception as e:  # the drafts are worth more than the tracking
        ctx.log(f"Tracking the walk detections was skipped: {e}", "warn")
        return doc, empty
    if out == dets:
        return doc, stats
    return {**doc, "detections": out}, stats


class WalkTrack:
    name = "walk.track"
    title = "Walk detections: track and place"
    description = (
        "Folds the detections of one object seen in several 360 walk frames into one draft and "
        "places it in the project from the walk's pose."
    )

    def validate(self, params: dict[str, Any]) -> dict[str, Any]:
        known_keys(params, {"pass", "layer"}, self.name)
        rel = params.get("pass")
        if not isinstance(rel, str) or not PASS.match(rel) or ".." in rel:
            raise JobError("pass must be detections/<name>.json inside the project.")
        layer = params.get("layer")
        if layer is not None and (not isinstance(layer, str) or not 1 <= len(layer) <= 128):
            raise JobError("layer must be a walk layer id.")
        out: dict[str, Any] = {"pass": rel}
        if layer is not None:
            out["layer"] = layer
        return out

    def plan(self, params: dict[str, Any]) -> list[Step]:
        return [
            Step("track", "Following the objects across the frames", self._track, weight=0.9),
            Step("commit", "Saving the detections", self._commit, weight=0.1),
        ]

    @staticmethod
    def _read(ctx: StepContext) -> tuple[bytes, dict[str, Any]]:
        rel = ctx.params["pass"]
        try:
            raw = ctx.out(rel).read_bytes()
            doc = json.loads(raw.decode("utf-8"))
        except (OSError, ValueError) as e:
            raise JobError(f"The detections pass {rel} could not be read.") from e
        if not isinstance(doc, dict) or doc.get("schema") != DETECTIONS_SCHEMA:
            raise JobError(f"{rel} is not a detections pass ({DETECTIONS_SCHEMA}).")
        return raw, doc

    def _run(self, ctx: StepContext, raw: bytes, doc: dict[str, Any]) -> dict[str, Any]:
        out, stats = track_doc(ctx, doc, ctx.params.get("layer"))
        unchanged = out is doc
        if not unchanged:
            atomic_write_json(ctx.stage(STAGED), out)
        meta = {"sha256": hashlib.sha256(raw).hexdigest(), "unchanged": unchanged, **stats}
        atomic_write_json(ctx.stage(META), meta)
        return meta

    def _track(self, ctx: StepContext) -> dict[str, Any]:
        ctx.progress(0.0, "Reading the detections")
        raw, doc = self._read(ctx)
        meta = self._run(ctx, raw, doc)
        return {k: v for k, v in meta.items() if k != "sha256"}

    def _commit(self, ctx: StepContext) -> dict[str, Any]:
        rel = ctx.params["pass"]
        meta = json.loads(ctx.stage(META).read_text("utf-8"))
        raw, doc = self._read(ctx)
        if hashlib.sha256(raw).hexdigest() != meta.get("sha256"):
            ctx.log("The detections changed while they were tracked; tracking them again.")
            meta = self._run(ctx, raw, doc)
        if not meta.get("unchanged"):
            commit_files(ctx, [(STAGED, rel)])
        ctx.log(
            f"{meta['objects']} objects, {meta['merged']} repeated detections folded in, "
            f"{meta['placed']} placed, {meta['unplaced']} not placed."
        )
        ctx.progress(1.0)
        return {"pass": rel, **{k: v for k, v in meta.items() if k != "sha256"}}
