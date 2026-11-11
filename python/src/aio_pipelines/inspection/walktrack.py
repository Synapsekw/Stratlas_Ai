"""Detections on 360 walk frames as one draft per object, placed from the walk pose (vision 3.9).

A walk frame draft (``frame: {layer, t}``, ``space: "source"``, a box in pixels of the playback
copy, ``x1 > width`` wraps the seam) turns its box centre into a direction (``equirect.box_dir``),
and the walk pose (``walks/<id>/pose.json``, ``aio.flight/1``; position linear and orientation
slerped at ``t``) turns that into the project frame. Without a pose the camera frame is used.

Tracking: drafts of one class in neighbouring sampled frames join a track when their directions lie
within ``max(6 degrees, 0.6 x box size)`` (times the square root of the frames skipped plus one),
their sizes within a factor of 2, and at most ``MAX_GAP`` sampled frames are missing between them.
Greedy, best match (smallest angle) first, frame by frame. The sampled frames are the pass's
``assessed`` frames (``t:<ms>``) and every frame a draft sits on.

One draft per track: its lead is the best-scored member (then the largest box). The others go into
``track.sightings`` (``MAX_SIGHTINGS``, the rest counted in ``sightingsOmitted``). Confidence stays
the lead's own: frames of one walk are not independent views. A one-frame track is left unchanged.

Placing, in order: the surface (the project's meshes, else point clouds: the median hit of the
members' centre rays), crossing rays (the least squares point of every member ray: 0.5 m of
baseline, 2 degrees of spread, every ray in front, a residual under max(0.5 m, 10 % of the range),
range under 100 m), the ground under the walk (the lead's box bottom ray against the pose height
minus ``heightM``, when it looks down). ``bearingDeg`` (compass from north; north is -z, east +x)
and ``rangeM`` are from the lead frame's walk position.

A draft that already has ``track`` (an earlier run) is expanded back into its member drafts first,
so a re-run or an extended run gives one draft per object again. Reviewed detections (accepted,
rejected, linked to an issue) and drafts that are not on a walk frame pass through untouched; the
order stays stable (a lead takes the place of its first member).
"""

from __future__ import annotations

import json
import math
from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import numpy as np

from . import equirect as E

MAX_SIGHTINGS = 200
MAX_GAP = 2  # sampled frames that may be missing inside a track
MIN_JOIN_DEG = 6.0
JOIN_SIZE_SHARE = 0.6
MAX_SIZE_RATIO = 2.0
MIN_BASELINE_M = 0.5
MIN_SPREAD_DEG = 2.0
MAX_RANGE_M = 100.0
DEFAULT_HEIGHT_M = 1.7  # @aio/schema WALK_HEIGHT_M
FLIGHT_SCHEMA = "aio.flight/1"

#: Fields of a lead that a sighting draft does not inherit when an earlier track is expanded.
_OWN_KEYS = {"id", "bbox", "confidence", "frame", "track", "note", "belowThreshold", "unscored", "fields",
             "vote", "issueId", "status"}  # fmt: skip


# ------------------------------------------------------------------------------------------ poses


def _slerp(a: np.ndarray, b: np.ndarray, u: float) -> np.ndarray:
    dot = float(a @ b)
    if dot < 0:
        b, dot = -b, -dot
    if dot > 0.9995:
        q = a + u * (b - a)
    else:
        th = math.acos(min(1.0, dot))
        s = math.sin(th)
        q = (math.sin((1 - u) * th) / s) * a + (math.sin(u * th) / s) * b
    return q / np.linalg.norm(q)


@dataclass
class WalkPose:
    """A walk's pose samples: ``t`` in ms, ``pos`` project local metres, ``q`` three.js x y z w."""

    t: np.ndarray
    pos: np.ndarray
    q: np.ndarray

    def at(self, t_s: float) -> tuple[np.ndarray, np.ndarray]:
        """Position and orientation at ``t_s`` seconds (held at the ends)."""
        ms = float(t_s) * 1000.0
        n = len(self.t)
        if n == 1 or ms <= self.t[0]:
            return self.pos[0].copy(), self.q[0].copy()
        if ms >= self.t[-1]:
            return self.pos[-1].copy(), self.q[-1].copy()
        k = int(np.searchsorted(self.t, ms, side="right")) - 1
        span = self.t[k + 1] - self.t[k]
        u = 0.0 if span <= 0 else (ms - self.t[k]) / span
        return self.pos[k] + u * (self.pos[k + 1] - self.pos[k]), _slerp(self.q[k], self.q[k + 1], u)


def pose_from_samples(samples: Iterable[Mapping[str, Any]]) -> WalkPose | None:
    rows = []
    for s in samples:
        try:
            t = float(s["t"])
            pos = [float(v) for v in s["pos"]]
            q = [float(v) for v in s["q"]]
        except (KeyError, TypeError, ValueError):
            continue
        if len(pos) != 3 or len(q) != 4 or not all(map(math.isfinite, [t, *pos, *q])):
            continue
        n = math.sqrt(sum(v * v for v in q))
        if n <= 0:
            continue
        rows.append((t, pos, [v / n for v in q]))
    if not rows:
        return None
    rows.sort(key=lambda r: r[0])
    return WalkPose(
        np.array([r[0] for r in rows]), np.array([r[1] for r in rows]), np.array([r[2] for r in rows])
    )


def read_pose(project: Path, layer: Mapping[str, Any]) -> WalkPose | None:
    """The pose of a walk layer (its ``flight.src``), or None when it has none that reads."""
    from .frame import asset_path

    flight = layer.get("flight")
    if not isinstance(flight, dict):
        return None
    path = asset_path(project, flight.get("src"))
    if path is None or not path.is_file():
        return None
    try:
        doc = json.loads(path.read_text("utf-8"))
    except (OSError, ValueError):
        return None
    if (
        not isinstance(doc, dict)
        or doc.get("schema") != FLIGHT_SCHEMA
        or not isinstance(doc.get("samples"), list)
    ):
        return None
    return pose_from_samples(s for s in doc["samples"] if isinstance(s, dict))


def walk_height(layer: Mapping[str, Any]) -> float:
    """The camera height above the walk's ground (``place.heightM``, else 1.7 m)."""
    h = (layer.get("place") or {}).get("heightM") if isinstance(layer.get("place"), dict) else None
    return float(h) if isinstance(h, int | float) and not isinstance(h, bool) else DEFAULT_HEIGHT_M


def _rotate(q: np.ndarray, v: np.ndarray) -> np.ndarray:
    from ..multiview.vote import rotate

    return rotate(list(q), list(v))


# ---------------------------------------------------------------------------------------- tracking


def is_frame_draft(d: Mapping[str, Any]) -> bool:
    """A draft on a walk frame with a usable source box."""
    fr = d.get("frame")
    if not isinstance(fr, dict) or not isinstance(fr.get("layer"), str):
        return False
    t = fr.get("t")
    if isinstance(t, bool) or not isinstance(t, int | float) or not math.isfinite(t):
        return False
    if d.get("status", "draft") != "draft" or d.get("issueId"):
        return False
    if d.get("space") != "source" or not d.get("width") or not d.get("height"):
        return False
    box = d.get("bbox")
    return isinstance(box, list) and len(box) == 4 and all(isinstance(v, int | float) for v in box)


def _threshold(d: Mapping[str, Any], conf: float | None) -> dict[str, Any]:
    out: dict[str, Any] = {}
    if conf is None:
        out["unscored"] = True
        return out
    thr = (d.get("origin") or {}).get("threshold") if isinstance(d.get("origin"), dict) else None
    if isinstance(thr, int | float) and conf < float(thr):
        out["belowThreshold"] = True
    return out


def expand(d: dict[str, Any]) -> list[dict[str, Any]]:
    """A tracked draft as its member drafts: the lead (without ``track``) and one per sighting."""
    tr = d.get("track")
    lead = {k: v for k, v in d.items() if k != "track"}
    if not isinstance(tr, dict):
        return [lead]
    base = {k: v for k, v in d.items() if k not in _OWN_KEYS}
    layer = d["frame"]["layer"]
    out = [lead]
    for s in tr.get("sightings") or []:
        if (
            not isinstance(s, dict)
            or not isinstance(s.get("bbox"), list)
            or not isinstance(s.get("t"), int | float)
        ):
            continue
        m: dict[str, Any] = dict(base)
        if s.get("id"):
            m["id"] = s["id"]
        conf = s.get("confidence")
        conf = float(conf) if isinstance(conf, int | float) else None
        if conf is not None:
            m["confidence"] = conf
        m.update(status="draft", bbox=list(s["bbox"]), frame={"layer": layer, "t": s["t"]})
        m.update(_threshold(d, conf))
        out.append(m)
    return out


@dataclass
class _Obs:
    index: int  # in the expanded list
    det: dict[str, Any]
    layer: str
    cls: str
    t: float
    frame: int  # index into the layer's sampled frames
    w: float
    h: float
    size: float  # degrees
    dir: np.ndarray  # world (or camera) direction of the box centre
    org: np.ndarray | None  # walk position at t, None without a pose
    q: np.ndarray | None
    score: float | None
    area: float


@dataclass
class _Track:
    members: list[_Obs] = field(default_factory=list)

    @property
    def last(self) -> _Obs:
        return self.members[-1]


def _angle(a: np.ndarray, b: np.ndarray) -> float:
    return math.degrees(math.acos(max(-1.0, min(1.0, float(a @ b)))))


def _join_limit(a: _Obs, b: _Obs, skipped: int) -> float:
    return max(MIN_JOIN_DEG, JOIN_SIZE_SHARE * max(a.size, b.size)) * math.sqrt(1 + skipped)


def _track_group(obs: list[_Obs], check: Callable[[], None]) -> list[_Track]:
    """Greedy frame-by-frame tracking of one layer's drafts of one class."""
    tracks: list[_Track] = []
    by_frame: dict[int, list[_Obs]] = {}
    for o in obs:
        by_frame.setdefault(o.frame, []).append(o)
    for n, f in enumerate(sorted(by_frame)):
        if n % 200 == 0:
            check()
        here = by_frame[f]
        live = [k for k, tr in enumerate(tracks) if 0 <= f - tr.last.frame - 1 <= MAX_GAP]
        pairs = []
        for k in live:
            last = tracks[k].last
            skipped = f - last.frame - 1
            for j, o in enumerate(here):
                ratio = max(last.size, o.size) / max(1e-6, min(last.size, o.size))
                if ratio > MAX_SIZE_RATIO:
                    continue
                ang = _angle(last.dir, o.dir)
                if ang <= _join_limit(last, o, skipped):
                    pairs.append((ang, skipped, k, j))
        pairs.sort()
        used_t: set[int] = set()
        used_o: set[int] = set()
        for _ang, _s, k, j in pairs:
            if k in used_t or j in used_o:
                continue
            used_t.add(k)
            used_o.add(j)
            tracks[k].members.append(here[j])
        for j, o in enumerate(here):
            if j not in used_o:
                tracks.append(_Track([o]))
    return tracks


# ----------------------------------------------------------------------------------------- placing


def _median_hit(org: np.ndarray, hits: np.ndarray) -> np.ndarray | None:
    ok = ~np.isnan(hits[:, 0])
    if not ok.any():
        return None
    dist = np.linalg.norm(hits[ok] - org[ok], axis=1)
    return hits[ok][np.argsort(dist)[len(dist) // 2]]


def cross_rays(org: np.ndarray, dirs: np.ndarray) -> np.ndarray | None:
    """The least squares point of rays, or None when they do not cross well enough (see module)."""
    if len(org) < 2:
        return None
    base = float(np.max(np.linalg.norm(org[:, None, :] - org[None, :, :], axis=2)))
    if base < MIN_BASELINE_M:
        return None
    spread = float(np.max(np.degrees(np.arccos(np.clip(dirs @ dirs.T, -1.0, 1.0)))))
    if spread < MIN_SPREAD_DEG:
        return None
    eye = np.eye(3)
    proj = eye[None, :, :] - dirs[:, :, None] * dirs[:, None, :]
    A = proj.sum(axis=0)
    b = np.einsum("nij,nj->i", proj, org)
    try:
        p = np.linalg.solve(A, b)
    except np.linalg.LinAlgError:
        return None
    rel = p[None, :] - org
    along = np.einsum("ij,ij->i", rel, dirs)
    if np.any(along <= 0):
        return None
    perp = np.einsum("nij,nj->ni", proj, rel)  # each ray's miss of the point
    resid = float(np.sqrt(np.mean(np.einsum("ij,ij->i", perp, perp))))
    rng = float(np.linalg.norm(p - org[0]))
    if rng >= MAX_RANGE_M or resid > max(0.5, 0.1 * rng):
        return None
    return p


def _ground(lead: _Obs, height_m: float) -> np.ndarray | None:
    if lead.org is None or lead.q is None:
        return None
    d = _rotate(lead.q, E.box_dir(lead.det["bbox"], lead.w, lead.h, "bottom"))
    d = d / np.linalg.norm(d)
    if d[1] >= -1e-3:
        return None
    ground_y = float(lead.org[1]) - height_m
    s = (ground_y - float(lead.org[1])) / float(d[1])
    if s <= 0 or s >= MAX_RANGE_M:
        return None
    return lead.org + s * d


def _place(tr: _Track, lead: _Obs, surface, height_m: float) -> tuple[np.ndarray | None, str | None]:
    posed = [m for m in tr.members if m.org is not None]
    if len(posed) != len(tr.members):
        return None, None
    org = np.array([m.org for m in posed])
    dirs = np.array([m.dir for m in posed])
    if surface is not None:
        p = _median_hit(org, np.asarray(surface.hit(org, dirs), float))
        if p is not None:
            return p, str(getattr(surface, "kind", "mesh"))
    p = cross_rays(org, dirs)
    if p is not None:
        return p, "rays"
    p = _ground(lead, height_m)
    if p is not None:
        return p, "ground"
    return None, None


def _bearing(v: np.ndarray) -> float:
    return round(math.degrees(math.atan2(float(v[0]), -float(v[2]))) % 360.0, 1) % 360.0


# ----------------------------------------------------------------------------------------- the job


def _sampled(
    layer: str, obs: list[tuple[str, float]], assessed: Mapping[str, Iterable[float]] | None
) -> list[float]:
    ts = {round(t, 3) for lay, t in obs if lay == layer}
    if assessed and layer in assessed:
        ts |= {round(float(t), 3) for t in assessed[layer]}
    return sorted(ts)


def track_frames(
    dets: list[dict[str, Any]],
    poses_by_layer: Mapping[str, WalkPose | None],
    surface=None,
    height_of_layer: Mapping[str, float] | None = None,
    check: Callable[[], None] = lambda: None,
    progress: Callable[[float, str | None], None] = lambda f, m=None: None,
    *,
    assessed: Mapping[str, Iterable[float]] | None = None,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """The pass's detections with the walk frame drafts of ``poses_by_layer``'s layers tracked.

    ``poses_by_layer``: walk layer id -> its pose (None: tracked in the camera frame, not placed);
    drafts of other layers pass through. ``assessed``: per layer, the sampled frame times in
    seconds (frames looked at with nothing found count as missing frames)."""
    heights = height_of_layer or {}
    expanded: list[dict[str, Any]] = []
    for d in dets:
        if isinstance(d, dict) and is_frame_draft(d) and d["frame"]["layer"] in poses_by_layer:
            expanded.extend(expand(d))
        else:
            expanded.append(d)
    cand = [
        (i, d)
        for i, d in enumerate(expanded)
        if isinstance(d, dict) and is_frame_draft(d) and d["frame"]["layer"] in poses_by_layer
    ]
    frames_of = {
        lay: _sampled(lay, [(d["frame"]["layer"], float(d["frame"]["t"])) for _, d in cand], assessed)
        for lay in {d["frame"]["layer"] for _, d in cand}
    }
    index_of = {lay: {t: k for k, t in enumerate(ts)} for lay, ts in frames_of.items()}
    progress(0.1, "Following the objects from frame to frame")
    groups: dict[tuple[str, str], list[_Obs]] = {}
    for i, d in cand:
        lay = d["frame"]["layer"]
        t = float(d["frame"]["t"])
        w, h = float(d["width"]), float(d["height"])
        box = [float(v) for v in d["bbox"]]
        cam = E.box_dir(box, w, h)
        pose = poses_by_layer.get(lay)
        org = q = None
        if pose is not None:
            org, q = pose.at(t)
            cam = _rotate(q, cam)
        cam = cam / np.linalg.norm(cam)
        conf = d.get("confidence")
        o = _Obs(
            index=i,
            det=d,
            layer=lay,
            cls=str(d.get("class")),
            t=t,
            frame=index_of[lay][round(t, 3)],
            w=w,
            h=h,
            size=max(0.05, E.box_size_deg(box, w, h)),
            dir=cam,
            org=org,
            q=q,
            score=float(conf) if isinstance(conf, int | float) and not isinstance(conf, bool) else None,
            area=max(0.0, box[2] - box[0]) * max(0.0, box[3] - box[1]),
        )
        groups.setdefault((lay, o.cls), []).append(o)
    tracks: list[_Track] = []
    for key in sorted(groups):
        tracks += _track_group(sorted(groups[key], key=lambda o: (o.t, o.index)), check)
    progress(0.5, "Placing the objects")

    replaced: dict[int, dict[str, Any] | None] = {}
    placed_on: dict[str, int] = {}
    placed = unplaced = merged = 0
    for n, tr in enumerate(tracks):
        if n % 100 == 0:
            check()
        if len(tr.members) == 1:
            continue
        merged += len(tr.members) - 1
        lead = max(
            tr.members,
            key=lambda m: (m.score if m.score is not None else -1.0, m.area, -m.t, -m.index),
        )
        point, on = _place(tr, lead, surface, float(heights.get(lead.layer, DEFAULT_HEIGHT_M)))
        ts = [m.t for m in tr.members]
        track: dict[str, Any] = {"frames": len(tr.members), "firstT": min(ts), "lastT": max(ts)}
        if lead.score is not None:
            track["score"] = lead.score
        if point is not None:
            placed += 1
            placed_on[on] = placed_on.get(on, 0) + 1
            track["point"] = [round(float(v), 3) for v in point]
            track["placedOn"] = on
            rel = point - lead.org
            track["bearingDeg"] = _bearing(rel)
            track["rangeM"] = round(float(np.linalg.norm(rel)), 2)
        else:
            unplaced += 1
            if lead.org is not None:
                track["bearingDeg"] = _bearing(lead.dir)
        others = sorted((m for m in tr.members if m is not lead), key=lambda m: (m.t, m.index))
        sightings = []
        for m in others[:MAX_SIGHTINGS]:
            s: dict[str, Any] = {"t": m.det["frame"]["t"], "bbox": m.det["bbox"]}
            if m.score is not None:
                s["confidence"] = m.score
            if m.det.get("id"):
                s["id"] = m.det["id"]
            sightings.append(s)
        track["sightings"] = sightings
        if len(others) > MAX_SIGHTINGS:
            track["sightingsOmitted"] = len(others) - MAX_SIGHTINGS
        first = min(m.index for m in tr.members)
        for m in tr.members:
            replaced[m.index] = None
        replaced[first] = {**lead.det, "track": track}
    out = [replaced.get(i, d) for i, d in enumerate(expanded)]
    out = [d for d in out if d is not None]
    progress(1.0, None)
    stats = {
        "objects": len(tracks),
        "merged": merged,
        "placed": placed,
        "placedOn": placed_on,
        "unplaced": unplaced,
    }
    return out, stats
