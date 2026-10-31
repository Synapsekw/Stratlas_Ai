"""The multi-view vote over a pass of draft detections (vision audit 3.6).

Each draft whose photo has a pose is placed in 3D: the median hit of a 5 x 5 ray grid in the central
half of its box on a surface (the inspection pipeline's "place in 3D" rule, ``aik/project.py``),
or, with no surface, where its box-centre ray passes closest to the rays of drafts of the same class
in other photos. Placed drafts of one class are clustered greedily in score order: a draft joins the
nearest cluster whose centre lies within the radius and that holds no draft of its photo yet,
otherwise it starts its own.

One draft stands for each cluster: its best-scored member. It gains ``vote``:

- ``views``: photos whose drafts agree (this one included);
- ``seenBy``: posed photos of the pass that look at the cluster's point (in front, inside the frame,
  not hidden behind the surface);
- ``singleView``: true when one photo found it although two or more see the point; kept, flagged;
- ``score``: its own detector score before the vote; ``point`` (project local frame, metres) and
  ``placedOn`` (``mesh``, ``cloud`` or ``rays``);
- ``sightings``: the other members' photo, box, score and id (they leave the pass).

Its ``confidence`` becomes the chance that at least one agreeing view is right (``1 - prod(1 - s)``
over the member scores) times ``0.7 + 0.3 * views / seenBy``, and
``belowThreshold`` is set again against the detector's threshold (``origin.threshold``). A draft
that cannot be placed (no pose, a contact-sheet or video-frame box, no hit) passes through untouched.
"""

from __future__ import annotations

import math
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from typing import Any, Protocol

import numpy as np

DEFAULT_RADIUS_M = 0.5
FRAME_MARGIN = 0.02  # share of the frame a point may sit outside and still count as seen
GRID = 5  # rays per side of the central half of a box
MAX_SIGHTINGS = 200


class Surface(Protocol):
    kind: str

    def hit(self, org: np.ndarray, D: np.ndarray) -> np.ndarray:
        """First hit of each ray (origin rows ``org``, unit directions ``D``); NaN rows for a miss."""
        ...

    def visible(self, cam_pos: np.ndarray, point: np.ndarray) -> bool:
        """True when nothing of the surface stands between the camera and the point."""
        ...


def _unit(v) -> np.ndarray:
    v = np.asarray(v, float)
    n = float(np.linalg.norm(v))
    return v / n if n > 0 else v


def rotate(q: Sequence[float], v: Sequence[float]) -> np.ndarray:
    """``v`` turned by the unit quaternion ``q`` = [x, y, z, w] (three.js order)."""
    from ..inspection.frame import rotate as _rotate

    return np.asarray(_rotate(q, v), float)


@dataclass
class Camera:
    """A pinhole camera: position, right / up / forward axes, horizontal field of view, frame size."""

    pos: np.ndarray
    right: np.ndarray
    up: np.ndarray
    fwd: np.ndarray
    hfov_deg: float
    width: int
    height: int

    @property
    def th(self) -> float:
        return math.tan(math.radians(self.hfov_deg) / 2)

    @property
    def tv(self) -> float:
        return self.th * self.height / self.width

    @classmethod
    def from_pose(cls, pos, q, hfov_deg: float, width: int, height: int) -> Camera:
        """A project photo pose: ``q`` turns the camera, which looks along -Z with +Y up."""
        return cls(
            np.asarray(pos, float),
            _unit(rotate(q, [1, 0, 0])),
            _unit(rotate(q, [0, 1, 0])),
            _unit(rotate(q, [0, 0, -1])),
            float(hfov_deg),
            int(width),
            int(height),
        )

    @classmethod
    def look_at(cls, pos, target, hfov_deg: float, width: int, height: int, up=(0.0, 1.0, 0.0)) -> Camera:
        p = np.asarray(pos, float)
        f = _unit(np.asarray(target, float) - p)
        r = _unit(np.cross(f, np.asarray(up, float)))
        u = _unit(np.cross(r, f))
        return cls(p, r, u, f, float(hfov_deg), int(width), int(height))

    def rays(self, px: np.ndarray, py: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        """Rays through pixel positions (``aik.project.camera_rays``: pixel centres, y down)."""
        x = (np.asarray(px, float) + 0.5) / self.width * 2 - 1
        y = 1 - (np.asarray(py, float) + 0.5) / self.height * 2
        d = (
            self.fwd[None, :]
            + x[:, None] * self.th * self.right[None, :]
            + y[:, None] * self.tv * self.up[None, :]
        )
        d /= np.linalg.norm(d, axis=1)[:, None]
        return np.repeat(self.pos[None, :], len(d), 0), d

    def project(self, points: np.ndarray, margin: float = FRAME_MARGIN) -> tuple[np.ndarray, np.ndarray]:
        """Pixel positions of ``points`` and whether each is in front and inside the frame."""
        rel = np.asarray(points, float).reshape(-1, 3) - self.pos[None, :]
        z = rel @ self.fwd
        with np.errstate(divide="ignore", invalid="ignore"):
            x = (rel @ self.right) / (z * self.th)
            y = (rel @ self.up) / (z * self.tv)
        u = (x + 1) / 2 * self.width - 0.5
        v = (1 - y) / 2 * self.height - 0.5
        lim = 1 + 2 * margin
        ok = (z > 1e-6) & (np.abs(x) <= lim) & (np.abs(y) <= lim)
        return np.column_stack([u, v]), ok


# ------------------------------------------------------------------------------------- placing


def box_in_frame(d: dict[str, Any], cam: Camera) -> tuple[float, float, float, float] | None:
    """The draft's box in the camera's pixels; None for a box the vote cannot place."""
    if d.get("frame") is not None or not d.get("photo"):
        return None
    space = d.get("space") or "preview"
    try:
        x0, y0, x1, y1 = (float(v) for v in d["bbox"])
    except (KeyError, TypeError, ValueError):
        return None
    if space == "preview":
        sx = sy = 1.0
    elif space == "normalized":
        sx, sy = cam.width, cam.height
    elif space == "source":
        w, h = d.get("width"), d.get("height")
        if not w or not h:
            return None
        sx, sy = cam.width / float(w), cam.height / float(h)
    else:  # a contact-sheet box names no photo of its own
        return None
    return (x0 * sx, y0 * sy, x1 * sx, y1 * sy)


def place_on_surface(
    cam: Camera, box: tuple[float, float, float, float], surface: Surface
) -> np.ndarray | None:
    """The median hit (by distance) of a 5 x 5 ray grid in the central half of the box."""
    x0, y0, x1, y1 = box
    gx, gy = np.meshgrid(
        np.linspace(x0 + (x1 - x0) * 0.25, x1 - (x1 - x0) * 0.25, GRID),
        np.linspace(y0 + (y1 - y0) * 0.25, y1 - (y1 - y0) * 0.25, GRID),
    )
    org, D = cam.rays(gx.ravel(), gy.ravel())
    hits = surface.hit(org, D)
    ok = ~np.isnan(hits[:, 0])
    if not ok.any():
        return None
    dist = np.linalg.norm(hits[ok] - org[ok], axis=1)
    return hits[ok][np.argsort(dist)[len(dist) // 2]]


def closest_approach(o1, d1, o2, d2) -> tuple[float, np.ndarray, float, float] | None:
    """Gap between two rays at their closest points, the midpoint and both ray lengths; None when
    parallel."""
    w0 = o1 - o2
    a, b, c = d1 @ d1, d1 @ d2, d2 @ d2
    d, e = d1 @ w0, d2 @ w0
    den = a * c - b * b
    if den < 1e-9:
        return None
    s = (b * e - c * d) / den
    t = (a * e - b * d) / den
    p1, p2 = o1 + s * d1, o2 + t * d2
    return float(np.linalg.norm(p1 - p2)), (p1 + p2) / 2, float(s), float(t)


# ------------------------------------------------------------------------------------- the vote


@dataclass
class _Obs:
    index: int
    det: dict[str, Any]
    photo: str
    cls: str
    score: float | None
    point: np.ndarray | None = None
    origin: np.ndarray | None = None
    ray: np.ndarray | None = None


def _place_by_rays(obs: list[_Obs], radius_of: Callable[[dict[str, Any]], float]) -> None:
    """Each ray where most of the rays of other photos that pass close to it cross it (unrelated rays
    cross it too, at other depths, so the densest crossing wins, not the median); a ray nobody
    agrees with sits at the median depth of the placed ones (so ``seenBy`` can still be told)."""
    depths: list[float] = []
    for a in obs:
        mids, radii = [], []
        for b in obs:
            if b is a or b.photo == a.photo or b.cls != a.cls:
                continue
            ca = closest_approach(a.origin, a.ray, b.origin, b.ray)
            if ca is None:
                continue
            gap, mid, s, t = ca
            r = max(radius_of(a.det), radius_of(b.det))
            if s > 0 and t > 0 and gap <= r:
                mids.append(mid)
                radii.append(r)
        if mids:
            m = np.array(mids)
            near = np.linalg.norm(m[:, None, :] - m[None, :, :], axis=2) <= max(radii)
            best = int(np.argmax(near.sum(axis=1)))
            a.point = m[near[best]].mean(axis=0)
            depths.append(float(np.linalg.norm(a.point - a.origin)))
    if depths:
        depth = float(np.median(depths))
        for a in obs:
            if a.point is None:
                a.point = a.origin + a.ray * depth


def _confidence(scores: list[float], views: int, seen_by: int | None) -> float | None:
    """The chance at least one agreeing view is right (noisy-or), times the share of the photos that
    see the point and agree (0.7 + 0.3 x views / seenBy). Picked on ``tools/detectors/vote_bench.py``
    over the mean and the best member score."""
    if not scores:
        return None
    agree = 1.0 - math.prod(1.0 - s for s in scores)
    support = 1.0 if not seen_by else min(1.0, views / seen_by)
    return round(agree * (0.7 + 0.3 * support), 4)


def vote(
    dets: list[dict[str, Any]],
    cameras: dict[str, Camera],
    surface: Surface | None,
    radius_m: float = DEFAULT_RADIUS_M,
    radius_of: Callable[[dict[str, Any]], float] | None = None,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """The pass's drafts after the vote, in their first order, and the counts for the job log."""
    rad = radius_of or (lambda _d: radius_m)
    obs: list[_Obs] = []
    for i, d in enumerate(dets):
        cam = cameras.get(str(d.get("photo"))) if d.get("photo") is not None else None
        box = box_in_frame(d, cam) if cam is not None else None
        if cam is None or box is None:
            continue
        score = d.get("confidence")
        o = _Obs(i, d, str(d["photo"]), str(d.get("class")), float(score) if score is not None else None)
        if surface is not None:
            o.point = place_on_surface(cam, box, surface)
            if o.point is None:
                continue
        else:
            cx, cy = (box[0] + box[2]) / 2, (box[1] + box[3]) / 2
            org, D = cam.rays(np.array([cx]), np.array([cy]))
            o.origin, o.ray = org[0], D[0]
        obs.append(o)
    if surface is None:
        _place_by_rays(obs, rad)
        obs = [o for o in obs if o.point is not None]
    placed_on = getattr(surface, "kind", "mesh") if surface is not None else "rays"

    # greedy clustering in score order (an unscored draft last)
    clusters: list[list[_Obs]] = []
    centres: list[np.ndarray] = []
    for o in sorted(obs, key=lambda o: (-(o.score if o.score is not None else -1.0), o.index)):
        best, best_d = -1, math.inf
        for k, members in enumerate(clusters):
            if members[0].cls != o.cls or any(m.photo == o.photo for m in members):
                continue
            dist = float(np.linalg.norm(centres[k] - o.point))
            if dist <= max(rad(members[0].det), rad(o.det)) and dist < best_d:
                best, best_d = k, dist
        if best < 0:
            clusters.append([o])
            centres.append(o.point.copy())
        else:
            clusters[best].append(o)
            centres[best] = np.mean([m.point for m in clusters[best]], axis=0)

    replaced: dict[int, dict[str, Any] | None] = {}
    single = 0
    for members, centre in zip(clusters, centres, strict=True):
        rep = members[0]
        views = len(members)
        seen = [
            pid
            for pid, cam in cameras.items()
            if cam.project(centre[None, :])[1][0] and (surface is None or surface.visible(cam.pos, centre))
        ]
        seen_by = max(len(seen), views)
        v: dict[str, Any] = {"views": views, "seenBy": seen_by}
        if views == 1 and seen_by >= 2:
            v["singleView"] = True
            single += 1
        if rep.score is not None:
            v["score"] = rep.score
        v["point"] = [round(float(x), 3) for x in centre]
        v["placedOn"] = placed_on
        sightings = []
        for m in members[1 : MAX_SIGHTINGS + 1]:
            s: dict[str, Any] = {"photo": m.photo, "bbox": m.det["bbox"]}
            if m.score is not None:
                s["confidence"] = m.score
            if m.det.get("id"):
                s["id"] = m.det["id"]
            sightings.append(s)
        if sightings:
            v["sightings"] = sightings
        out = {k: x for k, x in rep.det.items() if k not in ("vote", "belowThreshold")}
        conf = _confidence([m.score for m in members if m.score is not None], views, seen_by)
        if conf is not None:
            out["confidence"] = conf
            threshold = (rep.det.get("origin") or {}).get("threshold")
            if threshold is not None and conf < float(threshold):
                out["belowThreshold"] = True
        elif "belowThreshold" in rep.det:
            out["belowThreshold"] = rep.det["belowThreshold"]
        out["vote"] = v
        replaced[rep.index] = out
        for m in members[1:]:
            replaced[m.index] = None

    result = [replaced.get(i, d) if i in replaced else d for i, d in enumerate(dets)]
    result = [d for d in result if d is not None]
    stats = {
        "placed": len(obs),
        "unplaced": len(dets) - len(obs),
        "clusters": len(clusters),
        "merged": len(obs) - len(clusters),
        "singleView": single,
        "placedOn": placed_on,
    }
    return result, stats
