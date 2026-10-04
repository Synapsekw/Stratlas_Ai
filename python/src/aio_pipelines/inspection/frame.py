"""A native project as a kit job: photos, poses and meshes in the Asset Inspection Kit's model frame.

Project local frame (data-conventions section 1): metres, Y up, X east, Z south, origin at the
manifest ``origin``. Kit model frame (kit README): Y up above the ground datum, X north, Z east,
origin at the asset base centre. The two differ by a turn about Y and a shift to the asset axis:

    kit = (-(z - az), y, x - ax)        local = (kit_z + ax, kit_y, -kit_x + az)

with ``(ax, az)`` the asset axis: the centre of the meshes' footprint. It is a proper rotation, so
the kit's ray maths (cross products, bearings) is unchanged.

Camera poses: a photo's ``q`` is the camera orientation (looking along -Z, +Y up in the image);
the kit camera is ``position``, ``target``, ``up``, ``hfov``, ``vfov``. The target is the point on
the view ray nearest the asset axis, as in kit ``cameras.py``. Photos without ``q`` are aimed at
the asset axis at the camera height (kit ``cameras.py``), photos without a lens get the kit's 70
degree default, and ``vfov`` follows from ``hfov`` and the frame (square pixels).
"""

from __future__ import annotations

import json
import math
import os
from pathlib import Path
from typing import Any

import numpy as np

from ..runtime import JobError

KIT_DEFAULT_HFOV = 70.0  # kit cameras.py: no focal length -> 70 degrees


def rotate(q, v):
    """Rotate ``v`` by the unit quaternion ``q`` = [x, y, z, w] (three.js order)."""
    qx, qy, qz, qw = q
    vx, vy, vz = v
    tx = 2 * (qy * vz - qz * vy)
    ty = 2 * (qz * vx - qx * vz)
    tz = 2 * (qx * vy - qy * vx)
    return [
        vx + qw * tx + (qy * tz - qz * ty),
        vy + qw * ty + (qz * tx - qx * tz),
        vz + qw * tz + (qx * ty - qy * tx),
    ]


def layer_matrix(transform) -> np.ndarray:
    """A layer ``transform`` (column-major 4 x 4, three.js ``Matrix4.elements``) as a numpy matrix."""
    if transform is None:
        return np.eye(4)
    m = np.asarray(transform, float)
    if m.shape != (16,):
        raise JobError("A mesh layer transform must have 16 numbers.")
    return m.reshape(4, 4).T


class Frame:
    """Local frame <-> kit frame around the asset axis ``(ax, az)``."""

    def __init__(self, ax: float, az: float):
        self.ax, self.az = float(ax), float(az)

    def to_kit(self, p):
        return [-(p[2] - self.az), p[1], p[0] - self.ax]

    def dir_to_kit(self, d):
        return [-d[2], d[1], d[0]]

    def to_local(self, k):
        return [k[2] + self.ax, k[1], -k[0] + self.az]

    def dir_to_local(self, d):
        return [d[2], d[1], -d[0]]

    def matrix_to_kit(self) -> np.ndarray:
        return np.array(
            [[0, 0, -1, self.az], [0, 1, 0, 0], [1, 0, 0, -self.ax], [0, 0, 0, 1]],
            float,
        )


def read_manifest(project: Path) -> dict[str, Any]:
    p = project / "manifest.json"
    try:
        m = json.loads(p.read_text("utf-8"))
    except (OSError, ValueError) as e:
        raise JobError(f"Could not read the project manifest {p}: {e}") from e
    if not isinstance(m, dict) or m.get("schema") != "aio.project/1":
        raise JobError(f"{p} is not a project manifest (aio.project/1).")
    return m


def asset_path(project: Path, ref: Any) -> Path | None:
    """A layer ``AssetRef`` with a path, resolved inside the project (hash refs are not used here)."""
    if not isinstance(ref, dict) or not isinstance(ref.get("path"), str):
        return None
    rel = ref["path"].replace("\\", "/")
    if rel.startswith("/") or ".." in rel.split("/") or (len(rel) > 1 and rel[1] == ":"):
        return None
    return project.joinpath(*rel.split("/"))


def mesh_layers(manifest: dict[str, Any], ids: list[str] | None = None) -> list[dict[str, Any]]:
    out = [layer for layer in manifest.get("layers", []) if layer.get("kind") == "mesh"]
    if ids:
        out = [layer for layer in out if layer.get("id") in ids]
    return out


def photo_layers(manifest: dict[str, Any], ids: list[str] | None = None) -> list[dict[str, Any]]:
    out = [layer for layer in manifest.get("layers", []) if layer.get("kind") == "photos"]
    if ids:
        out = [layer for layer in out if layer.get("id") in ids]
    return out


def load_meshes(project: Path, layers: list[dict[str, Any]], log=print):
    """Every mesh layer's geometry in the local frame: ``[(layer id, node name, trimesh)]``."""
    import trimesh

    parts = []
    for layer in layers:
        path = asset_path(project, layer.get("src"))
        if path is None or not path.exists():
            log(
                f'The model of layer "{layer.get("name")}" ({layer.get("src")}) was not found; skipped.',
                "warn",
            )
            continue
        try:
            sc = trimesh.load(path, force="scene")
        except Exception as e:  # a broken file should name itself
            raise JobError(f"Could not read the model {path.name}: {e}") from e
        L = layer_matrix(layer.get("transform"))
        for node in sc.graph.nodes_geometry:
            T, gname = sc.graph[node]
            g = sc.geometry[gname]
            if not hasattr(g, "faces") or len(g.faces) == 0:
                continue
            m = trimesh.Trimesh(
                vertices=np.asarray(g.vertices, float), faces=np.asarray(g.faces), process=False
            )
            m.apply_transform(L @ T)
            parts.append((layer["id"], str(node), m))
    if not parts:
        raise JobError("The project has no model to place findings on. Import a GLB or OBJ model first.")
    return parts


def write_kit_model(parts, frame: Frame, out: Path) -> list[dict[str, str]]:
    """The meshes in the kit frame as one GLB (no textures); returns node -> layer."""
    import trimesh

    scene = trimesh.Scene()
    K = frame.matrix_to_kit()
    nodes = []
    used: set[str] = set()
    for layer_id, node, m in parts:
        km = m.copy()
        km.apply_transform(K)
        name = node or layer_id
        base, n = name, 2
        while name in used:  # kit component_name drops trailing numbers, so "shell 2" is still "Shell"
            name = f"{base} {n}"
            n += 1
        used.add(name)
        scene.add_geometry(km, node_name=name, geom_name=name)
        nodes.append({"node": name, "layer": layer_id})
    out.parent.mkdir(parents=True, exist_ok=True)
    tmp = out.with_name(out.name + ".partial")
    tmp.write_bytes(scene.export(file_type="glb"))
    os.replace(tmp, out)
    return nodes


def footprint(parts) -> dict[str, Any]:
    lo = np.min([m.bounds[0] for _, _, m in parts], axis=0)
    hi = np.max([m.bounds[1] for _, _, m in parts], axis=0)
    return {"min": lo.round(4).tolist(), "max": hi.round(4).tolist()}


def kit_camera(
    cam_id: str,
    name: str,
    photo: dict[str, Any],
    size: tuple[int, int],
    frame: Frame,
    hfov_default: float,
    asset_height: float,
    log=print,
) -> dict[str, Any]:
    """A kit ``cameras.json`` record for a posed photo (kit ``cameras.pose`` maths for the target)."""
    W, H = size
    x, y, z = frame.to_kit(photo["pos"])
    lens = photo.get("lens") or {}
    hf = float(lens.get("hfovDeg") or hfov_default)
    if lens.get("model") == "ftheta":
        log(f"{cam_id}: f-theta lens treated as pinhole with the same field of view", "warn")
        hf = min(hf, 170.0)
    vf = 2 * math.degrees(math.atan(math.tan(math.radians(hf / 2)) * H / W))
    P = [x, y, z]
    q = photo.get("q")
    if q:
        d = frame.dir_to_kit(rotate(q, [0, 0, -1]))
        up = frame.dir_to_kit(rotate(q, [0, 1, 0]))
        source = "pose"
    else:  # aim at the asset axis at the camera height (clamped to the asset)
        ty = min(max(y, 0), asset_height or y)
        d = [-x, ty - y, -z]
        up = [0, 1, 0]
        source = "aimed at asset axis"
    n = math.sqrt(sum(v * v for v in d)) or 1.0
    d = [v / n for v in d]
    hz = d[0] ** 2 + d[2] ** 2
    t = -(x * d[0] + z * d[2]) / hz if hz > 1e-6 else math.hypot(x, z) or 10
    if t <= 0:
        t = math.sqrt(x * x + z * z) or 10
    T = [P[i] + d[i] * t for i in range(3)]
    return {
        "id": cam_id,
        "name": name,
        "source_name": photo["src"]["path"],
        "file": photo["_file"],
        "sequence": photo["_layer"],
        "subject": "",
        "context": False,
        "latitude": photo.get("_lat"),
        "longitude": photo.get("_lon"),
        "altitude": photo.get("_alt"),
        "focal": None,
        "width": W,
        "height": H,
        "time": photo.get("takenAt"),
        "position": [round(v, 4) for v in P],
        "target": [round(v, 4) for v in T],
        "up": [round(v, 5) for v in up],
        "hfov": round(hf, 4),
        "vfov": round(vf, 4),
        "orientation_source": source,
    }


def wgs84(manifest: dict[str, Any], points: list[list[float]]) -> list[tuple[float, float, float] | None]:
    """Latitude, longitude, height of local points (for the kit CSV columns); None when unknown."""
    crs = manifest.get("crs") or {}
    origin = manifest.get("origin") or [0, 0, 0]
    if not points or not isinstance(crs.get("epsg"), int):
        return [None] * len(points)
    try:
        from rasterio.warp import transform

        E = [origin[0] + p[0] for p in points]
        N = [origin[1] - p[2] for p in points]
        lon, lat = transform(f"EPSG:{crs['epsg']}", "EPSG:4326", E, N)
        return [
            (round(la, 8), round(lo, 8), round(origin[2] + p[1], 3))
            for la, lo, p in zip(lat, lon, points, strict=True)
        ]
    except Exception:
        return [None] * len(points)
