"""The multi-view vote over a pass of draft detections (vision audit 3.6).

Each draft whose photo has a pose is placed in 3D: the median hit of a 5 x 5 ray grid in the central
half of its box on a surface (the inspection pipeline's "place in 3D" rule, ``aik/project.py``),
or, with no surface, where its box-centre ray crosses the rays of drafts of the same class in other
photos (the densest crossing). A ray no other photo's ray crosses has no place: it is put at the
pass's median depth only to count the photos that look there, and it never joins or takes another
draft. Placed drafts of one class are clustered greedily, highest ranked first (the score, or the
caller's ``rank_of``): a draft joins the nearest cluster whose centre lies within the radius and that
holds no draft of its photo yet, otherwise it starts its own.

One draft stands for each cluster: its highest-ranked member. It gains ``vote``:

- ``views``: photos whose drafts agree (this one included);
- ``seenBy``: photos the run looked at for that class (``assessed``) that look at the cluster's
  point (in front, inside the frame, not hidden behind the surface);
- ``singleView``: true when one photo found it although two or more see the point; kept, flagged;
- ``score``: its own detector score before the vote; ``point`` (project local frame, metres; left
  out for a guessed depth) and ``placedOn`` (``mesh``, ``cloud`` or ``rays``);
- ``sightings``: the other members, each with its photo, box (in its own ``space``, ``width`` and
  ``height``), score, id, note and fields (they leave the pass); past ``MAX_SIGHTINGS``, only
  counted in ``sightingsOmitted``.

Its ``confidence`` becomes the chance that at least one agreeing view is right (``1 - prod(1 - s)``
over the member scores) times ``0.7 + 0.3 * views / seenBy``, and ``belowThreshold`` is set again
against the detector's threshold (``origin.threshold``). A draft that cannot be placed (no pose, a
contact-sheet or video-frame box, no hit) passes through untouched.

``fixed`` drafts (a re-run's reviewed detections and the drafts it keeps) are placed but never
change and never join another cluster. A new draft that falls on a fixed ``"reviewed"`` one is
dropped (that object was reviewed); one that falls on a fixed ``"kept"`` draft is added to its
sightings.
"""

from __future__ import annotations

import math
from collections.abc import Callable, Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any, Protocol

import numpy as np

DEFAULT_RADIUS_M = 0.5
FRAME_MARGIN = 0.02  # share of the frame a point may sit outside and still count as seen
GRID = 5  # rays per side of the central half of a box
MAX_SIGHTINGS = 200
RAY_CHUNK = 50_000  # rays per surface call
RAY_SAMPLES = 32  # samples per ray in the crossing prefilter, at least
MAX_RAY_SAMPLES = 256  # and at most
MAX_REACH = 5.0  # metres: the prefilter's search reach is never wider
PAIR_NEIGHBOURS = 48  # neighbours each sample takes in the prefilter
PAIR_CHUNK = 100_000  # samples per prefilter query
SIGHTING_KEYS = ("space", "width", "height", "note", "fields")


class Surface(Protocol):
    kind: str

    def hit(self, org: np.ndarray, D: np.ndarray) -> np.ndarray:
        """First hit of each ray (origin rows ``org``, unit directions ``D``); NaN rows for a miss."""
        ...

    def visible_many(self, cam_pos: np.ndarray, points: np.ndarray) -> np.ndarray:
        """Per point, true when nothing of the surface stands between the camera and it."""
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


def _grid_rays(cam: Camera, box: tuple[float, float, float, float]) -> tuple[np.ndarray, np.ndarray]:
    x0, y0, x1, y1 = box
    gx, gy = np.meshgrid(
        np.linspace(x0 + (x1 - x0) * 0.25, x1 - (x1 - x0) * 0.25, GRID),
        np.linspace(y0 + (y1 - y0) * 0.25, y1 - (y1 - y0) * 0.25, GRID),
    )
    return cam.rays(gx.ravel(), gy.ravel())


def place_on_surface(
    cam: Camera, box: tuple[float, float, float, float], surface: Surface
) -> np.ndarray | None:
    """The median hit (by distance) of a 5 x 5 ray grid in the central half of the box."""
    org, D = _grid_rays(cam, box)
    return _median_hit(org, surface.hit(org, D))


def _median_hit(org: np.ndarray, hits: np.ndarray) -> np.ndarray | None:
    ok = ~np.isnan(hits[:, 0])
    if not ok.any():
        return None
    dist = np.linalg.norm(hits[ok] - org[ok], axis=1)
    return hits[ok][np.argsort(dist)[len(dist) // 2]]


def closest_approach(o1, d1, o2, d2) -> tuple[float, np.ndarray, float, float] | None:
    """Gap between two rays at their closest points, the midpoint and both ray lengths; None when
    parallel."""
    gap, mid, s, t, ok = _closest(o1[None, :], d1[None, :], o2[None, :], d2[None, :])
    if not ok[0]:
        return None
    return float(gap[0]), mid[0], float(s[0]), float(t[0])


def _closest(o1, d1, o2, d2):
    """Row-wise ``closest_approach`` of ray pairs: gap, midpoint, both lengths, not parallel."""
    w0 = o1 - o2
    a = np.einsum("ij,ij->i", d1, d1)
    b = np.einsum("ij,ij->i", d1, d2)
    c = np.einsum("ij,ij->i", d2, d2)
    d = np.einsum("ij,ij->i", d1, w0)
    e = np.einsum("ij,ij->i", d2, w0)
    den = a * c - b * b
    ok = den >= 1e-9
    den = np.where(ok, den, 1.0)
    s = (b * e - c * d) / den
    t = (a * e - b * d) / den
    p1, p2 = o1 + s[:, None] * d1, o2 + t[:, None] * d2
    return np.linalg.norm(p1 - p2, axis=1), (p1 + p2) / 2, s, t, ok


# ------------------------------------------------------------------------------------- the vote


@dataclass
class _Obs:
    index: int
    det: dict[str, Any]
    photo: str
    cls: str
    score: float | None
    rank: float
    radius: float
    fixed: str | None = None
    point: np.ndarray | None = None
    origin: np.ndarray | None = None
    ray: np.ndarray | None = None
    guessed: bool = False


@dataclass
class _Cluster:
    members: list[_Obs]
    centre: np.ndarray
    photos: set[str] = field(default_factory=set)
    closed: bool = False  # a guessed or fixed seed: nobody joins it (a fixed one only absorbs)

    @property
    def lead(self) -> _Obs:
        return self.members[0]


def _ray_pairs(obs: list[_Obs], check: Callable[[], None]) -> tuple[np.ndarray, np.ndarray]:
    """Candidate pairs (index arrays into ``obs``) of rays of one class from different photos that may
    cross within their radius: each ray is sampled over the depths where crossings happen, and only
    rays with samples within one sample step plus the radius of each other (never wider than
    ``MAX_REACH``; each sample takes at most ``PAIR_NEIGHBOURS`` neighbours, in chunks) are paired."""
    from scipy.spatial import cKDTree

    n = len(obs)
    if n < 2:
        return np.zeros(0, int), np.zeros(0, int)
    org = np.array([o.origin for o in obs])
    dirs = np.array([o.ray for o in obs])
    photo = np.unique([o.photo for o in obs], return_inverse=True)[1]
    cls = np.unique([o.cls for o in obs], return_inverse=True)[1]
    r = max(o.radius for o in obs)
    # the depths where rays cross: from the photos nearest each other (a few pairs per photo)
    cams, first = np.unique(photo, return_index=True)
    lo, hi = 0.5, 1000.0
    if len(cams) >= 2:
        cpos = org[first]
        k = min(4, len(cams))
        _, nn = cKDTree(cpos).query(cpos, k=k)
        order = np.argsort(photo, kind="stable")
        bounds = np.searchsorted(photo[order], np.r_[cams, cams[-1] + 1])
        by_photo = {int(p): order[bounds[j] : bounds[j + 1]] for j, p in enumerate(cams)}
        depths = []
        for a in range(len(cams)):
            ia = by_photo[int(cams[a])]
            for b in np.atleast_1d(nn[a])[1:]:
                ib = by_photo[int(cams[b])]
                A, B = np.repeat(ia, len(ib)), np.tile(ib, len(ia))
                same = cls[A] == cls[B]
                A, B = A[same], B[same]
                if not len(A):
                    continue
                gap, _, s, t, ok = _closest(org[A], dirs[A], org[B], dirs[B])
                good = ok & (s > 0) & (t > 0) & (gap <= r)
                depths.extend(s[good].tolist())
            if a % 256 == 0:
                check()
        if depths:
            med = float(np.median(depths))
            lo, hi = med / 4, med * 4
    # samples close enough that a crossing within r lies between neighbours, up to a sample cap;
    # the search reach is bounded, and each sample takes at most PAIR_NEIGHBOURS neighbours, so
    # the candidate list cannot grow without limit
    samples = int(min(MAX_RAY_SAMPLES, max(RAY_SAMPLES, math.ceil((hi - lo) / max(MAX_REACH - r, r)))))
    step = (hi - lo) / samples
    reach = min(step + r, MAX_REACH)
    ts = lo + step * (np.arange(samples) + 0.5)
    pairs = []
    for c in np.unique(cls):
        idx = np.flatnonzero(cls == c)
        if len(idx) < 2:
            continue
        pts = (org[idx, None, :] + dirs[idx, None, :] * ts[None, :, None]).reshape(-1, 3)
        owner = np.repeat(idx, samples)
        tree = cKDTree(pts)
        k = min(PAIR_NEIGHBOURS, len(pts))
        for s0 in range(0, len(pts), PAIR_CHUNK):
            check()
            dist, nb = tree.query(pts[s0 : s0 + PAIR_CHUNK], k=k, distance_upper_bound=reach)
            dist, nb = np.atleast_2d(dist), np.atleast_2d(nb)
            got = np.isfinite(dist)
            a = np.repeat(owner[s0 : s0 + PAIR_CHUNK], k).reshape(-1, k)[got]
            b = owner[nb[got]]
            keep = photo[a] != photo[b]
            a, b = a[keep], b[keep]
            lo_, hi_ = np.minimum(a, b), np.maximum(a, b)
            pairs.append(np.unique(lo_ * n + hi_))
    if not pairs:
        return np.zeros(0, int), np.zeros(0, int)
    u = np.unique(np.concatenate(pairs))
    return u // n, u % n


def _place_by_rays(obs: list[_Obs], check: Callable[[], None]) -> None:
    """Each ray where most of the rays of other photos that pass close to it cross it (unrelated rays
    cross it too, at other depths, so the densest crossing wins, not the median); a ray nobody
    crosses gets the median depth of the placed ones, marked ``guessed``."""
    A, B = _ray_pairs(obs, check)
    org = np.array([o.origin for o in obs]) if obs else np.zeros((0, 3))
    dirs = np.array([o.ray for o in obs]) if obs else np.zeros((0, 3))
    radius = np.array([o.radius for o in obs]) if obs else np.zeros(0)
    if len(A):
        gap, mid, s, t, ok = _closest(org[A], dirs[A], org[B], dirs[B])
        good = ok & (s > 0) & (t > 0) & (gap <= np.maximum(radius[A], radius[B]))
        A, B, mid = A[good], B[good], mid[good]
        owner = np.concatenate([A, B])
        mids = np.concatenate([mid, mid])
        order = np.argsort(owner, kind="stable")
        owner, mids = owner[order], mids[order]
        starts = np.flatnonzero(np.r_[True, owner[1:] != owner[:-1]])
        ends = np.r_[starts[1:], len(owner)]
        for k, (s0, s1) in enumerate(zip(starts, ends, strict=True)):
            if k % 1024 == 0:
                check()
            a = obs[int(owner[s0])]
            m = mids[s0:s1]
            if len(m) > 64:  # the densest of a sample is enough
                m = m[np.linspace(0, len(m) - 1, 64).astype(int)]
            near = np.linalg.norm(m[:, None, :] - m[None, :, :], axis=2) <= a.radius
            best = int(np.argmax(near.sum(axis=1)))
            a.point = m[near[best]].mean(axis=0)
    placed = [float(np.linalg.norm(o.point - o.origin)) for o in obs if o.point is not None]
    if placed:
        depth = float(np.median(placed))
        for o in obs:
            if o.point is None:
                o.point = o.origin + o.ray * depth
                o.guessed = True


def _confidence(scores: list[float], views: int, seen_by: int | None) -> float | None:
    """The chance at least one agreeing view is right (noisy-or), times the share of the photos that
    see the point and agree (0.7 + 0.3 x views / seenBy). Picked on ``tools/detectors/vote_bench.py``
    over the mean and the best member score."""
    if not scores:
        return None
    agree = 1.0 - math.prod(1.0 - s for s in scores)
    support = 1.0 if not seen_by else min(1.0, views / seen_by)
    return round(agree * (0.7 + 0.3 * support), 4)


def _sighting(o: _Obs) -> dict[str, Any]:
    s: dict[str, Any] = {"photo": o.photo, "bbox": o.det["bbox"]}
    for k in SIGHTING_KEYS:
        if o.det.get(k) not in (None, "", []):
            s[k] = o.det[k]
    if o.score is not None:
        s["confidence"] = o.score
    if o.det.get("id"):
        s["id"] = o.det["id"]
    return s


def _vote_again(cl: _Cluster, joiners: list[_Obs], seen: int, placed_on: str) -> dict[str, Any]:
    """A kept draft that new drafts of other photos joined: one sighting per photo (a new one from a
    photo already listed replaces it), ``views`` the photos counted once, ``seenBy`` and
    ``singleView`` again, and, for a draft, its confidence voted again from every score it holds."""
    det = cl.lead.det
    v = dict(det.get("vote") or {})
    by_photo: dict[str, dict[str, Any]] = {}
    for s in v.get("sightings") or []:
        if isinstance(s, dict) and s.get("photo") and s["photo"] != cl.lead.photo:
            by_photo[str(s["photo"])] = s
    for o in joiners:
        by_photo[o.photo] = _sighting(o)
    sightings = list(by_photo.values())
    omitted = int(v.get("sightingsOmitted") or 0)
    if len(sightings) > MAX_SIGHTINGS:
        omitted += len(sightings) - MAX_SIGHTINGS
        sightings = sightings[:MAX_SIGHTINGS]
    views = 1 + len(by_photo) + int(v.get("sightingsOmitted") or 0)
    seen_by = max(seen, views)
    v.update(views=views, seenBy=seen_by, sightings=sightings)
    if omitted:
        v["sightingsOmitted"] = omitted
    v.pop("singleView", None)
    if views == 1 and seen_by >= 2:
        v["singleView"] = True
    v.setdefault("placedOn", placed_on)
    if "point" not in v and not cl.lead.guessed:
        v["point"] = [round(float(x), 3) for x in cl.centre]
    out = {**det, "vote": v}
    if det.get("status", "draft") == "draft" and not det.get("issueId"):
        own = v.get("score", det.get("confidence"))
        scores = [float(own)] if isinstance(own, int | float) else []
        scores += [float(s["confidence"]) for s in sightings if isinstance(s.get("confidence"), int | float)]
        conf = _confidence(scores, views, seen_by)
        if conf is not None:
            out["confidence"] = conf
            out.pop("belowThreshold", None)
            threshold = (det.get("origin") or {}).get("threshold")
            if threshold is not None and conf < float(threshold):
                out["belowThreshold"] = True
    return out


def _assessed_of(assessed, cameras: dict[str, Camera]) -> Callable[[str], list[str]]:
    """Per class, the photos the run looked at that have a camera."""
    if assessed is None:
        every = list(cameras)
        return lambda _cls: every
    if isinstance(assessed, Mapping):
        table = {str(c): [p for p in ps if p in cameras] for c, ps in assessed.items()}
        return lambda cls: table.get(cls, [])
    flat = [p for p in assessed if p in cameras]
    return lambda _cls: flat


def _seen_by(
    clusters: list[_Cluster],
    cameras: dict[str, Camera],
    surface: Surface | None,
    looked: Callable[[str], list[str]],
    check: Callable[[], None],
) -> list[int]:
    """Per cluster, how many photos the run looked at for its class see its point (one projection of
    every point per camera, one batch of occlusion rays per camera)."""
    counts = np.zeros(len(clusters), int)
    if not clusters:
        return []
    centres = np.array([c.centre for c in clusters])
    by_photo: dict[str, list[int]] = {}
    for k, c in enumerate(clusters):
        for pid in looked(c.lead.cls):
            by_photo.setdefault(pid, []).append(k)
    for n, (pid, ks) in enumerate(by_photo.items()):
        if n % 64 == 0:
            check()
        cam = cameras[pid]
        idx = np.array(ks)
        _, ok = cam.project(centres[idx])
        idx = idx[ok]
        if len(idx) and surface is not None:
            idx = idx[np.asarray(surface.visible_many(cam.pos, centres[idx]), bool)]
        counts[idx] += 1
    return counts.tolist()


def vote(
    dets: list[dict[str, Any]],
    cameras: dict[str, Camera],
    surface: Surface | None,
    radius_m: float = DEFAULT_RADIUS_M,
    radius_of: Callable[[dict[str, Any]], float] | None = None,
    *,
    assessed: Mapping[str, Iterable[str]] | Iterable[str] | None = None,
    rank_of: Callable[[dict[str, Any]], float | None] | None = None,
    fixed: Callable[[dict[str, Any]], str | None] | None = None,
    check: Callable[[], None] = lambda: None,
    progress: Callable[[float, str | None], None] = lambda f, m=None: None,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """The pass's drafts after the vote, in their first order, and the counts for the job log.

    ``assessed``: the photos the run looked at, per class (a mapping) or for every class; only they
    count in ``seenBy`` (default: every camera). ``rank_of``: which member stands for a cluster
    (default its score). ``fixed``: ``"reviewed"``, ``"kept"`` or None per draft (see the module)."""
    rad = radius_of or (lambda _d: radius_m)
    rank = rank_of or (lambda d: d.get("confidence"))
    fix = fixed or (lambda _d: None)
    obs: list[_Obs] = []
    boxes: list[tuple[Camera, tuple[float, float, float, float]]] = []
    for i, d in enumerate(dets):
        cam = cameras.get(str(d.get("photo"))) if d.get("photo") is not None else None
        box = box_in_frame(d, cam) if cam is not None else None
        if cam is None or box is None:
            continue
        score = d.get("confidence")
        r = rank(d)
        obs.append(
            _Obs(
                i,
                d,
                str(d["photo"]),
                str(d.get("class")),
                float(score) if score is not None else None,
                float(r) if r is not None else -math.inf,
                float(rad(d)),
                fix(d),
            )
        )
        boxes.append((cam, box))
    progress(0.1, "Placing the drafts in 3D")
    if surface is not None:
        org_l, dir_l = [], []
        for cam, box in boxes:
            o, dd = _grid_rays(cam, box)
            org_l.append(o)
            dir_l.append(dd)
        if obs:
            org, dirs = np.concatenate(org_l), np.concatenate(dir_l)
            hits = np.empty_like(org)
            for k in range(0, len(org), RAY_CHUNK):
                check()
                hits[k : k + RAY_CHUNK] = surface.hit(org[k : k + RAY_CHUNK], dirs[k : k + RAY_CHUNK])
                progress(0.1 + 0.5 * min(1.0, (k + RAY_CHUNK) / len(org)), None)
            n = GRID * GRID
            for j, o in enumerate(obs):
                o.point = _median_hit(org[j * n : (j + 1) * n], hits[j * n : (j + 1) * n])
        obs = [o for o in obs if o.point is not None]
    else:
        for o, (cam, box) in zip(obs, boxes, strict=True):
            cx, cy = (box[0] + box[2]) / 2, (box[1] + box[3]) / 2
            org, D = cam.rays(np.array([cx]), np.array([cy]))
            o.origin, o.ray = org[0], D[0]
        _place_by_rays(obs, check)
        obs = [o for o in obs if o.point is not None]
    placed_on = getattr(surface, "kind", "mesh") if surface is not None else "rays"
    progress(0.6, "Grouping the drafts")

    # greedy clustering: fixed drafts first, then the highest ranked; a grid of cluster centres
    reach = max((o.radius for o in obs), default=radius_m)
    grid: dict[tuple[str, int, int, int], set[int]] = {}

    def cell(cls: str, p: np.ndarray) -> tuple[str, int, int, int]:
        q = np.floor(p / reach).astype(int)
        return (cls, int(q[0]), int(q[1]), int(q[2]))

    clusters: list[_Cluster] = []
    absorbed: list[tuple[_Cluster, _Obs]] = []
    ordered = sorted(obs, key=lambda o: (o.fixed is None, -o.rank, o.index))
    for n, o in enumerate(ordered):
        if n % 1000 == 0:
            check()
        best, best_d = None, math.inf
        if o.fixed is None and not o.guessed:
            c0 = cell(o.cls, o.point)
            for dx in (-1, 0, 1):
                for dy in (-1, 0, 1):
                    for dz in (-1, 0, 1):
                        for k in grid.get((o.cls, c0[1] + dx, c0[2] + dy, c0[3] + dz), ()):
                            cl = clusters[k]
                            if cl.lead.guessed or o.photo in cl.photos:
                                continue
                            if cl.closed and cl.lead.fixed is None:
                                continue
                            dist = float(np.linalg.norm(cl.centre - o.point))
                            if dist <= max(cl.lead.radius, o.radius) and dist < best_d:
                                best, best_d = k, dist
        if best is None:
            cl = _Cluster([o], o.point.copy(), {o.photo}, closed=o.guessed or o.fixed is not None)
            clusters.append(cl)
            grid.setdefault(cell(o.cls, cl.centre), set()).add(len(clusters) - 1)
            continue
        cl = clusters[best]
        if cl.lead.fixed is not None:
            absorbed.append((cl, o))
            cl.photos.add(o.photo)
            continue
        old = cell(o.cls, cl.centre)
        cl.members.append(o)
        cl.photos.add(o.photo)
        cl.centre = np.mean([m.point for m in cl.members], axis=0)
        new = cell(o.cls, cl.centre)
        if new != old:
            grid[old].discard(best)
            grid.setdefault(new, set()).add(best)

    progress(0.75, "Counting the photos that see each object")
    looked = _assessed_of(assessed, cameras)
    live = [c for c in clusters if c.lead.fixed is None]
    seen_counts = _seen_by(live, cameras, surface, looked, check)

    replaced: dict[int, dict[str, Any] | None] = {}
    single = dropped = added = 0
    joiners: dict[int, list[_Obs]] = {}
    for cl, o in absorbed:
        replaced[o.index] = None
        if cl.lead.fixed == "reviewed":
            dropped += 1
            continue
        joiners.setdefault(id(cl), []).append(o)
        added += 1
    grown = [c for c in clusters if id(c) in joiners]
    for cl, seen in zip(grown, _seen_by(grown, cameras, surface, looked, check), strict=True):
        replaced[cl.lead.index] = _vote_again(cl, joiners[id(cl)], seen, placed_on)
    for cl, seen in zip(live, seen_counts, strict=True):
        members = cl.members
        rep = cl.lead
        views = len(members)
        seen_by = max(seen, views)
        v: dict[str, Any] = {"views": views, "seenBy": seen_by}
        if views == 1 and seen_by >= 2:
            v["singleView"] = True
            single += 1
        if rep.score is not None:
            v["score"] = rep.score
        if not rep.guessed:
            v["point"] = [round(float(x), 3) for x in cl.centre]
        v["placedOn"] = placed_on
        sightings = [_sighting(m) for m in members[1 : MAX_SIGHTINGS + 1]]
        if sightings:
            v["sightings"] = sightings
        if views - 1 > MAX_SIGHTINGS:
            v["sightingsOmitted"] = views - 1 - MAX_SIGHTINGS
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

    result = [replaced.get(i, d) for i, d in enumerate(dets)]
    result = [d for d in result if d is not None]
    progress(1.0, None)
    stats = {
        "placed": len(obs),
        "unplaced": len(dets) - len(obs),
        "clusters": len(live),
        "merged": sum(len(c.members) - 1 for c in live),
        "singleView": single,
        "guessed": sum(1 for o in obs if o.guessed),
        "droppedOnReviewed": dropped,
        "addedToKept": added,
        "placedOn": placed_on,
    }
    return result, stats
