"""A project's photo poses and its surface for the multi-view vote, and the vote over a draft pass.

Poses are read as the inspection pipeline reads them (``inspection/pipeline.py`` read step): a photo
sits where its survey date is lined up and turns with the line-up. Only photos with a position and
an orientation (``q``) take part; a photo aimed by rule (the kit's "aimed at the asset axis") would
place its drafts where nothing was seen.

The surface is the project's meshes (all mesh layers, lined up, ``inspection.frame.load_meshes``);
without a mesh, its point clouds (sampled to ``CLOUD_POINTS``, rays marched against a KD tree);
without either, none, and the vote triangulates box-centre rays (``vote.py``).

``vote_pass`` never fails a job: anything that goes wrong leaves the drafts as they were and logs a
warning, because the drafts are worth more than the vote.
"""

from __future__ import annotations

from collections.abc import Callable, Iterable, Mapping
from pathlib import Path
from typing import Any

import numpy as np

from .vote import DEFAULT_RADIUS_M, Camera, vote

CLOUD_POINTS = 2_000_000
MAX_MARCH_STEPS = 4000
DEFAULT_HFOV = 70.0  # the kit's default, as inspection.run's hfovDeg


class MeshSurface:
    """Triangle meshes in the project local frame (one trimesh)."""

    kind = "mesh"

    def __init__(self, mesh):
        self.mesh = mesh
        self.tol = max(0.1, float(np.linalg.norm(mesh.extents)) * 1e-3)

    def hit(self, org: np.ndarray, D: np.ndarray) -> np.ndarray:
        from ..aik.project import cast

        hits, _ = cast(self.mesh, np.asarray(org, float), np.asarray(D, float))
        return hits

    def visible_many(self, cam_pos: np.ndarray, points: np.ndarray) -> np.ndarray:
        """One occlusion ray per point: visible when the first hit is at the point or beyond."""
        pts = np.asarray(points, float).reshape(-1, 3)
        org = np.repeat(np.asarray(cam_pos, float)[None, :], len(pts), 0)
        d = pts - org
        dist = np.linalg.norm(d, axis=1)
        safe = np.where(dist > 0, dist, 1.0)
        h = self.hit(org, d / safe[:, None])
        hd = np.linalg.norm(h - org, axis=1)
        return (dist <= 0) | np.isnan(h[:, 0]) | (hd >= dist - self.tol)


class CloudSurface:
    """Points in the project local frame: a ray hits the first point it passes within ``tol`` of.

    Rays are marched in steps of at most ``tol``, so a ray cannot step over the surface. A ray too
    long for ``MAX_MARCH_STEPS`` steps of the point spacing takes longer steps and a ``tol`` widened
    to match; a miss is then still a miss, only the hit is coarser."""

    kind = "cloud"

    def __init__(self, points: np.ndarray, spacing: float | None = None):
        from scipy.spatial import cKDTree

        self.points = np.asarray(points, float).reshape(-1, 3)
        self.tree = cKDTree(self.points)
        if spacing is None:
            n = len(self.points)
            if n > 1:
                pick = self.points[np.random.default_rng(0).choice(n, min(n, 2000), replace=False)]
                d, _ = self.tree.query(pick, k=2)
                spacing = float(np.median(d[:, 1]))
            else:
                spacing = 0.1
        self.spacing = max(float(spacing), 0.005)
        self.tol = 1.5 * self.spacing
        self.lo = self.points.min(axis=0) - self.tol
        self.hi = self.points.max(axis=0) + self.tol

    def _spans(self, org: np.ndarray, D: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        """Where each ray is inside the cloud's bounds (slab test); t1 < t0 for a ray that misses."""
        with np.errstate(divide="ignore", invalid="ignore"):
            a = (self.lo[None, :] - org) / D
            b = (self.hi[None, :] - org) / D
        lo = np.where(np.isnan(a), -np.inf, np.minimum(a, b))
        hi = np.where(np.isnan(a), np.inf, np.maximum(a, b))
        # a ray parallel to a slab and outside it never enters
        out = (D == 0) & ((org < self.lo[None, :]) | (org > self.hi[None, :]))
        t0 = np.maximum(lo.max(axis=1), 0.0)
        t1 = hi.min(axis=1)
        t1 = np.where(out.any(axis=1), -1.0, t1)
        return t0, t1

    def march(self, org: np.ndarray, D: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        """First hit of each ray (NaN rows for a miss) and the tolerance each ray was marched with."""
        org, D = np.asarray(org, float).reshape(-1, 3), np.asarray(D, float).reshape(-1, 3)
        n = len(org)
        out = np.full((n, 3), np.nan)
        t0, t1 = self._spans(org, D)
        length = np.where(t1 >= t0, t1 - t0, 0.0)
        step = np.maximum(self.spacing, length / MAX_MARCH_STEPS)
        tol = np.maximum(self.tol, step)
        active = np.flatnonzero(t1 >= t0)
        block = 64
        k = 0
        while len(active) and k <= MAX_MARCH_STEPS:
            ts = t0[active, None] + step[active, None] * (k + np.arange(block))[None, :]
            pts = org[active, None, :] + D[active, None, :] * ts[:, :, None]
            dist, idx = self.tree.query(pts.reshape(-1, 3), distance_upper_bound=float(tol[active].max()))
            dist, idx = dist.reshape(len(active), block), idx.reshape(len(active), block)
            inside = ts <= t1[active, None] + step[active, None]
            got = (dist <= tol[active, None]) & inside
            any_hit = got.any(axis=1)
            first = np.argmax(got, axis=1)
            rows = active[any_hit]
            out[rows] = self.points[idx[any_hit, first[any_hit]]]
            done = any_hit | ~inside[:, -1]
            active = active[~done]
            k += block
        return out, tol

    def hit(self, org: np.ndarray, D: np.ndarray) -> np.ndarray:
        return self.march(org, D)[0]

    def visible_many(self, cam_pos: np.ndarray, points: np.ndarray) -> np.ndarray:
        pts = np.asarray(points, float).reshape(-1, 3)
        org = np.repeat(np.asarray(cam_pos, float)[None, :], len(pts), 0)
        d = pts - org
        dist = np.linalg.norm(d, axis=1)
        safe = np.where(dist > 0, dist, 1.0)
        h, tol = self.march(org, d / safe[:, None])
        hd = np.linalg.norm(h - org, axis=1)
        return (dist <= 0) | np.isnan(h[:, 0]) | (hd >= dist - 2 * tol - 0.1)


def cameras(
    project: Path, manifest: dict[str, Any], layer_id: str | None = None, hfov_default: float = DEFAULT_HFOV
) -> dict[str, Camera]:
    """Photo id -> camera, for the posed photos of ``layer_id`` (every photos layer when None)."""
    from PIL import Image

    from ..captures import date_similarity
    from ..inspection import frame as Fr

    out: dict[str, Camera] = {}
    origin = manifest.get("origin") or [0, 0, 0]
    for layer in Fr.photo_layers(manifest, [layer_id] if layer_id else None):
        sim = date_similarity(manifest, str(layer["id"]))
        for item in layer.get("items", []):
            pos, q = item.get("pos"), item.get("q")
            if not pos or not q or item.get("id") in out:
                continue
            path = Fr.asset_path(project, item.get("src"))
            if path is None or not path.exists():
                continue
            try:
                with Image.open(path) as im:
                    w, h = im.size
            except OSError:
                continue
            if not sim.is_identity():
                x, z = sim.apply_local(float(pos[0]), float(pos[2]), origin)
                pos = [x, pos[1], z]
                if abs(sim.rotation_deg) > 0.0:
                    q = Fr.turn_q(q, sim.rotation_deg)
            lens = item.get("lens") or {}
            hfov = float(lens.get("hfovDeg") or hfov_default)
            out[str(item["id"])] = Camera.from_pose(pos, q, min(hfov, 170.0), w, h)
    return out


def mesh_surface(project: Path, manifest: dict[str, Any]) -> MeshSurface | None:
    from ..inspection import frame as Fr
    from ..runtime import JobError

    layers = Fr.mesh_layers(manifest)
    if not layers:
        return None
    try:
        parts = Fr.load_meshes(project, layers, lambda *_a, **_k: None, manifest)
    except JobError:
        return None
    import trimesh

    return MeshSurface(trimesh.util.concatenate([m for _, _, m in parts]))


def cloud_surface(ctx, manifest: dict[str, Any]) -> CloudSurface | None:
    """The project's point clouds as one sampled surface; None when it has none that read."""
    from ..captures import date_shift
    from ..change.derived import layer_file
    from ..change.sources import height_offset_m
    from ..spaces import in_project_frame
    from ..tiles.cloud import crs_to_local, read_points

    origin = np.asarray(manifest.get("origin") or [0, 0, 0], float)
    chunks = []
    for layer in manifest.get("layers") or []:
        if not isinstance(layer, dict) or layer.get("kind") != "pointcloud":
            continue
        if not in_project_frame(manifest, layer):
            # the photos are placed in the project's frame: a cloud of a space with its own
            # coordinates would sit somewhere else, so it is left out rather than mixed in
            ctx.log(
                f'The point cloud "{layer.get("name") or layer.get("id")}" is in a space with its own '
                "coordinates; the vote leaves it out.",
                "info",
            )
            continue
        try:
            path = layer_file(ctx.project, layer)
            east, north = date_shift(manifest, str(layer["id"]))
            xyz, _rgb, _cube = read_points(ctx, path, height_offset_m(layer), (float(east), float(north)))
        except Exception as e:  # a cloud that does not read leaves the vote without it
            ctx.log(
                f'The point cloud "{layer.get("name") or layer.get("id")}" could not be read for the vote: {e}',
                "warn",
            )
            continue
        chunks.append(crs_to_local(xyz, origin))
    if not chunks:
        return None
    pts = np.concatenate(chunks)
    if len(pts) > CLOUD_POINTS:
        pts = pts[np.random.default_rng(0).choice(len(pts), CLOUD_POINTS, replace=False)]
    return CloudSurface(pts)


def radius_for(detectors: dict[str, dict[str, Any]]) -> Callable[[dict[str, Any]], float]:
    """The cluster radius of a draft: 0.5 m, or its detector's ``objectSizeM`` when larger."""

    def of(d: dict[str, Any]) -> float:
        det = detectors.get(str((d.get("origin") or {}).get("detectorId")))
        size = det.get("objectSizeM") if det else None
        return max(DEFAULT_RADIUS_M, float(size)) if isinstance(size, int | float) else DEFAULT_RADIUS_M

    return of


def vote_pass(
    ctx,
    layer_id: str | None,
    dets: list[dict[str, Any]],
    radius_of: Callable[[dict[str, Any]], float] | None = None,
    *,
    assessed: Mapping[str, Iterable[str]] | Iterable[str] | None = None,
    rank_of: Callable[[dict[str, Any]], float | None] | None = None,
    fixed: Callable[[dict[str, Any]], str | None] | None = None,
) -> tuple[list[dict[str, Any]], dict[str, Any] | None]:
    """The pass's drafts after the multi-view vote, and its counts (None when no vote ran).

    ``assessed``: the photos the run looked at (per class or for all); only they count in
    ``seenBy``. The vote runs when drafts sit on two or more posed photos. It never fails the job:
    an error leaves the drafts as they were with a warning; a cancel still cancels."""
    from ..runtime import Cancelled

    try:
        from ..inspection.frame import read_manifest

        manifest = read_manifest(ctx.project)
        cams = cameras(ctx.project, manifest, layer_id)
        posed = {str(d.get("photo")) for d in dets if str(d.get("photo")) in cams}
        if len(posed) < 2:
            return dets, None
        ctx.log("Voting across photos: placing the drafts in 3D")
        surface = mesh_surface(ctx.project, manifest) or cloud_surface(ctx, manifest)
        out, stats = vote(
            dets,
            cams,
            surface,
            radius_of=radius_of,
            assessed=assessed,
            rank_of=rank_of,
            fixed=fixed,
            check=ctx.check,
            progress=lambda f, m=None: ctx.progress(0.1 + 0.8 * f, m),
        )
        ctx.log(
            f"Multi-view vote on the {stats['placedOn']}: {stats['placed']} drafts placed, "
            f"{stats['clusters']} objects, {stats['merged']} duplicates folded in, "
            f"{stats['singleView']} seen in one photo only (kept, flagged), {stats['unplaced']} not placed."
        )
        return out, stats
    except Cancelled:
        raise
    except Exception as e:  # the drafts are worth more than the vote
        ctx.log(f"The multi-view vote was skipped: {e}", "warn")
        return dets, None
