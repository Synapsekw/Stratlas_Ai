"""Read a Flyability Inspector 5 export folder into plain, privacy-safe records.

Only the live `<name>.json` files are read (the `*.json.<ms>.backup` revisions never match the
exact names). Operator e-mails (`audit`) and the launch location (`flight.location`) are not read
at all. Clouds are located through `maps/*/map.json` (`parent_type` Flight or Inspection, the
`Asset` relocalisation map is ignored) and named by `point_clouds[].file_path`, never guessed.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import numpy as np


@dataclass(frozen=True)
class Snapshot:
    id: str
    flight_id: str
    time_us: int
    camera_pos: np.ndarray
    camera_q: np.ndarray  # x, y, z, w
    drone_pos: np.ndarray
    drone_q: np.ndarray  # x, y, z, w
    camera_pitch: float | None
    criticality: str | None
    comment: str
    tags: list[str]
    wall_distance: float | None
    photo: Path | None
    annotated: Path | None
    points: list[tuple[float, float, str]]
    image_size: tuple[int, int] | None
    folder: Path


@dataclass(frozen=True)
class Poi:
    id: str
    name: str
    description: str
    tags: list[str]
    snapshots: list[Snapshot] = field(default_factory=list)


@dataclass(frozen=True)
class Flight:
    id: str
    name: str
    transform: np.ndarray | None  # 4x4 row-major flight -> inspection frame; None = identity
    cloud: Path | None
    trajectory: Path | None
    datetime_utc: int | None
    relocalised: bool


@dataclass(frozen=True)
class Inspection:
    id: str
    name: str
    merged_cloud: Path | None
    flights: list[Flight] = field(default_factory=list)
    pois: list[Poi] = field(default_factory=list)


@dataclass(frozen=True)
class Export:
    asset_name: str | None
    generation: str  # '2024-bag', '2025-mcap' or 'unknown'
    inspections: list[Inspection] = field(default_factory=list)


def _load(path: Path) -> dict[str, Any] | None:
    try:
        data = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def _records(root: Path, folder: str, name: str) -> list[tuple[Path, dict[str, Any]]]:
    out: list[tuple[Path, dict[str, Any]]] = []
    base = root / folder
    if not base.is_dir():
        return out
    for d in sorted(p for p in base.iterdir() if p.is_dir()):
        data = _load(d / name)
        if data is not None:
            out.append((d, data))
    return out


def _file(folder: Path, entries: Any) -> Path | None:
    """First listed file (`file_path`) that exists beside the map.json."""
    if not isinstance(entries, list):
        return None
    for entry in entries:
        rel = entry.get("file_path") if isinstance(entry, dict) else None
        if isinstance(rel, str) and rel and (folder / rel).is_file():
            return folder / rel
    return None


def _vec(pose: Any, key: str, names: str) -> np.ndarray:
    src = pose.get(key) if isinstance(pose, dict) else None
    src = src if isinstance(src, dict) else {}
    return np.array([float(src.get(n, 0.0) or 0.0) for n in names], dtype=float)


def _quat(pose: Any) -> np.ndarray:
    q = _vec(pose, "orientation", "xyzw")
    if not (isinstance(pose, dict) and isinstance(pose.get("orientation"), dict)):
        q[3] = 1.0
    return q


def _number(v: Any) -> float | None:
    return float(v) if isinstance(v, int | float) and not isinstance(v, bool) else None


def _str_list(v: Any) -> list[str]:
    return [str(t) for t in v] if isinstance(v, list) else []


def _transform(v: Any) -> np.ndarray | None:
    nums = v.get("v") if isinstance(v, dict) else None
    if not isinstance(nums, list) or len(nums) != 16:
        return None
    return np.array(nums, dtype=float).reshape(4, 4)


def _generation(root: Path) -> str:
    flights = root / "flights"
    if flights.is_dir():
        names = [p.suffix.lower() for p in flights.glob("*/*") if p.is_file()]
        if ".mcap" in names:
            return "2025-mcap"
        if ".bag" in names:
            return "2024-bag"
    return "unknown"


def _snapshot(folder: Path, data: dict[str, Any]) -> Snapshot:
    pic = data.get("picture") if isinstance(data.get("picture"), dict) else {}

    def image(key: str) -> Path | None:
        name = pic.get(key)
        return folder / name if isinstance(name, str) and (folder / name).is_file() else None

    ann = pic.get("annotations")
    raw_points = ann.get("points") if isinstance(ann, dict) else None
    points = [
        (float(p["x"]), float(p["y"]), str(p.get("text") or ""))
        for p in (raw_points or [])
        if isinstance(p, dict) and _number(p.get("x")) is not None and _number(p.get("y")) is not None
    ]
    props = pic.get("properties")
    size = props.get("image_size") if isinstance(props, dict) else None
    image_size = None
    if isinstance(size, dict) and _number(size.get("x")) and _number(size.get("y")):
        image_size = (int(size["x"]), int(size["y"]))
    cam, drone = data.get("camera_pose"), data.get("drone_pose")
    return Snapshot(
        id=str(data.get("id") or folder.name),
        flight_id=str(data.get("flight_id") or ""),
        time_us=int(_number(data.get("time")) or 0),
        camera_pos=_vec(cam, "position", "xyz"),
        camera_q=_quat(cam),
        drone_pos=_vec(drone, "position", "xyz"),
        drone_q=_quat(drone),
        camera_pitch=_number(data.get("camera_pitch")),
        criticality=data["criticality"] if isinstance(data.get("criticality"), str) else None,
        comment=str(data.get("comment") or ""),
        tags=_str_list(data.get("tags")),
        wall_distance=_number(data.get("wall_distance")),
        photo=image("original_rbg"),
        annotated=image("result_annotated"),
        points=points,
        image_size=image_size,
        folder=folder,
    )


def read_export(root: Path) -> Export:
    root = Path(root)
    assets = _records(root, "assets", "asset.json")
    names = [a.get("name") for _, a in assets if isinstance(a.get("name"), str)]
    asset_name = names[0] if names else None

    # maps by (parent type, parent id)
    flight_maps: dict[str, tuple[Path | None, Path | None]] = {}
    inspection_maps: dict[str, Path] = {}
    for mdir, m in _records(root, "maps", "map.json"):
        pid = str(m.get("parent_id") or "")
        if m.get("parent_type") == "Flight":
            found = (_file(mdir, m.get("point_clouds")), _file(mdir, m.get("trajectories")))
            flight_maps.setdefault(pid, found)
        elif m.get("parent_type") == "Inspection":
            cloud = _file(mdir, m.get("point_clouds"))
            if cloud is not None:
                inspection_maps.setdefault(pid, cloud)

    flights_by_insp: dict[str, list[Flight]] = {}
    flight_insp: dict[str, str] = {}
    for _, f in _records(root, "flights", "flight.json"):
        fid, iid = str(f.get("id") or ""), str(f.get("inspection_id") or "")
        cloud, traj = flight_maps.get(fid, (None, None))
        stamp = _number(f.get("datetime_utc"))
        flights_by_insp.setdefault(iid, []).append(
            Flight(
                id=fid,
                name=str(f.get("name") or ""),
                transform=_transform(f.get("transform")),
                cloud=cloud,
                trajectory=traj,
                datetime_utc=None if stamp is None else int(stamp),
                relocalised=bool(f.get("relocalized")),
            )
        )
        flight_insp[fid] = iid
    for fl in flights_by_insp.values():
        fl.sort(key=lambda f: (f.datetime_utc if f.datetime_utc is not None else 0, f.name, f.id))

    inspections = _records(root, "inspections", "inspection.json")
    insp_ids = [str(d.get("id") or p.name) for p, d in inspections]

    poi_records = {str(d.get("id") or p.name): d for p, d in _records(root, "pois", "poi.json")}
    pois_by_insp: dict[str, dict[str, list[Snapshot]]] = {i: {} for i in insp_ids}
    for sdir, s in _records(root, "snapshots", "snapshot.json"):
        snap = _snapshot(sdir, s)
        iid = flight_insp.get(snap.flight_id)
        if iid not in pois_by_insp:
            if len(insp_ids) != 1:
                continue
            iid = insp_ids[0]
        pois_by_insp[iid].setdefault(str(s.get("poi_id") or ""), []).append(snap)

    out: list[Inspection] = []
    for iid, (_, idata) in zip(insp_ids, inspections, strict=True):
        pois: list[Poi] = []
        for poi_id, snaps in pois_by_insp[iid].items():
            snaps.sort(key=lambda s: (s.time_us, s.id))
            rec = poi_records.get(poi_id)
            if rec is None:
                sid = poi_id or snaps[0].id
                pois.append(Poi(sid, f"Snapshot {snaps[0].id[:8]}", "", [], snaps))
            else:
                pois.append(
                    Poi(
                        poi_id,
                        str(rec.get("name") or ""),
                        str(rec.get("description") or ""),
                        _str_list(rec.get("tags")),
                        snaps,
                    )
                )
        pois.sort(key=lambda p: (p.name, p.id))
        out.append(
            Inspection(
                id=iid,
                name=str(idata.get("name") or ""),
                merged_cloud=inspection_maps.get(iid),
                flights=flights_by_insp.get(iid, []),
                pois=pois,
            )
        )
    return Export(asset_name, _generation(root), out)


def read_trajectory(path: Path) -> np.ndarray:
    """N x 8 (t, x, y, z, qx, qy, qz, qw) sorted by t; the `quality` column is dropped."""
    rows: list[list[float]] = []
    for line in Path(path).read_text(encoding="utf-8-sig").splitlines():
        parts = line.split()
        if len(parts) < 8:
            continue
        try:
            rows.append([float(v) for v in parts[:8]])
        except ValueError:
            continue  # header
    if not rows:
        return np.zeros((0, 8))
    arr = np.array(rows, dtype=float)
    return arr[np.argsort(arr[:, 0], kind="stable")]
