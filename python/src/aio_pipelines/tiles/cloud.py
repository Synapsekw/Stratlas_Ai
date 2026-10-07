"""tiles.cloud: a COPC point cloud to a 3D Tiles points tileset following its octree.

Parameters as ``TilesCloudParams`` in ``@aio/schema`` ``jobs.ts``. For the Globe; the site view keeps
its own COPC renderer. Writes ``tiles/<id>/tileset.json`` and one glTF points file per node, then
adds the entry to ``tilesets.json`` (``.bak`` kept).

The tree mirrors the COPC octree: the same cube (the COPC info record's centre and half size, or
the cloud's bounds for a plain LAS), the same ``D-X-Y-Z`` node keys, and the same sampling (a node
at depth D keeps one point per cell of ``spacing / 2^D`` and hands the rest to its children; a node
with few enough points keeps them all), so every point appears exactly once and refinement is
``ADD``. Points go to ECEF through the project CRS in float64 like meshes (``transform.py``).

Reading: a COPC (LAZ-compressed) file goes through PDAL (``pointcloud.find_pdal``) to a plain LAS
1.4 in the job folder; a plain LAS 1.4 (formats 6 to 8) is read directly.
"""

from __future__ import annotations

import json
import struct
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np

from ..params import known_keys, number, text
from ..runtime import JobError, Step, StepContext, atomic_write_bytes, atomic_write_json
from .gltf import Part, write_glb
from .tileset import Tile, is_tileset_id, replace_folder, safe_tileset_id, tileset_json, upsert_tileset
from .transform import SiteFrame, box_of, enu_to_gltf

KEYS = {"layer", "id", "name", "maxPointsPerTile"}
DEFAULT_MAX_POINTS = 100_000
MAX_DEPTH = 16
GENERATOR = "Stratlas tiles.cloud"
COPC_USER = "copc"


@dataclass(frozen=True)
class Cube:
    centre: np.ndarray  # CRS x, y, z
    half: float
    spacing: float


def las_header(path: Path) -> tuple[bool, dict[tuple[str, int], bytes], tuple[float, ...]]:
    """(compressed, VLRs by (user, record), bounds minx maxx miny maxy minz maxz) without the points."""
    with open(path, "rb") as f:
        head = f.read(375)
        if len(head) < 227 or head[:4] != b"LASF":
            raise JobError(f"{path.name} is not a LAS or COPC file.")
        header_size = struct.unpack_from("<H", head, 94)[0]
        n_vlrs = struct.unpack_from("<I", head, 100)[0]
        compressed = bool(head[104] & 0xC0)
        bounds = struct.unpack_from("<6d", head, 179)
        f.seek(header_size)
        vlrs: dict[tuple[str, int], bytes] = {}
        for _ in range(n_vlrs):
            vh = f.read(54)
            if len(vh) < 54:
                break
            user = vh[2:18].split(b"\0", 1)[0].decode("ascii", "replace")
            rid, length = struct.unpack_from("<HH", vh, 18)
            vlrs[(user, rid)] = f.read(length)
    # LAS header bounds are max x, min x, max y, min y, max z, min z.
    maxx, minx, maxy, miny, maxz, minz = bounds
    return compressed, vlrs, (minx, maxx, miny, maxy, minz, maxz)


def cube_of(vlrs: dict[tuple[str, int], bytes], bounds: tuple[float, ...]) -> Cube:
    info = vlrs.get((COPC_USER, 1))
    if info is not None and len(info) >= 40:
        cx, cy, cz, half, spacing = struct.unpack_from("<5d", info, 0)
        if half > 0 and spacing > 0:
            return Cube(np.array([cx, cy, cz]), half, spacing)
    minx, maxx, miny, maxy, minz, maxz = bounds
    lo = np.array([minx, miny, minz])
    hi = np.array([maxx, maxy, maxz])
    half = max(float((hi - lo).max()) / 2, 0.5)
    # PDAL's COPC writer: 128 cells across the root.
    return Cube((lo + hi) / 2, half, 2 * half / 128)


def read_points(ctx: StepContext, path: Path) -> tuple[np.ndarray, np.ndarray | None, Cube]:
    """Points in the file CRS (float64), colours (uint8 RGB) or None, and the octree cube."""
    from ..change.las import LasError, read_las

    compressed, vlrs, bounds = las_header(path)
    cube = cube_of(vlrs, bounds)
    plain = path
    if compressed:
        plain = _decompress(ctx, path)
    try:
        las = read_las(plain)
    except LasError as e:
        raise JobError(f"{path.name}: {e}") from e
    finally:
        if plain != path:
            plain.unlink(missing_ok=True)
    xyz = las.xyz
    rgb = None
    if las.pdrf in (7, 8):
        c = np.stack([las.field("Red"), las.field("Green"), las.field("Blue")], axis=1)
        rgb = (c >> 8).astype(np.uint8) if c.max(initial=0) > 255 else c.astype(np.uint8)
    return xyz, rgb, cube


def _decompress(ctx: StepContext, path: Path) -> Path:
    from ..change.cloud import _pdal
    from ..pointcloud import PDAL_MISSING, find_pdal

    pdal = find_pdal()
    if not pdal:
        raise JobError(PDAL_MISSING)
    work = ctx.job.dir / "work"
    work.mkdir(parents=True, exist_ok=True)
    out = work / "points.las"
    pipe = work / "read.json"
    pipe.write_text(
        json.dumps(
            {
                "pipeline": [
                    {"type": "readers.copc", "filename": str(path)},
                    {
                        "type": "writers.las",
                        "filename": str(out),
                        "minor_version": 4,
                        "dataformat_id": 7,
                        "scale_x": 0.001,
                        "scale_y": 0.001,
                        "scale_z": 0.001,
                        "offset_x": "auto",
                        "offset_y": "auto",
                        "offset_z": "auto",
                    },
                ]
            }
        ),
        "utf-8",
    )
    _pdal(ctx, [pdal, "pipeline", str(pipe)], f"read {path.name}")
    return out


class CloudTiler:
    """The COPC-style octree over points already in the root's east-north-up frame."""

    def __init__(
        self,
        crs_xyz: np.ndarray,
        enu: np.ndarray,
        rgb: np.ndarray | None,
        cube: Cube,
        max_points: int,
        out: Path,
        ctx: StepContext | None = None,
        seed: int = 7,
    ):
        self.crs = crs_xyz
        self.enu = enu
        self.rgb = rgb
        self.cube = cube
        self.max_points = max_points
        self.out = out
        self.ctx = ctx
        self.order = np.random.default_rng(seed).permutation(len(crs_xyz))
        self.written = 0

    def run(self) -> Tile:
        lo = self.cube.centre - self.cube.half
        size = 2 * self.cube.half
        if not np.all((self.crs >= lo) & (self.crs <= lo + size)):
            # Points outside the stated cube (a hand-made file): a cube around the points instead.
            lo = self.crs.min(axis=0)
            size = max(float((self.crs.max(axis=0) - lo).max()), 1.0)
        return self._node(0, (0, 0, 0), lo, size, self.order)

    def _node(self, d: int, xyz: tuple[int, int, int], lo: np.ndarray, size: float, idx: np.ndarray) -> Tile:
        if self.ctx is not None:
            self.ctx.check()
        key = f"{d}-{xyz[0]}-{xyz[1]}-{xyz[2]}"
        cell = self.cube.spacing / (2**d)
        if len(idx) <= self.max_points or d >= MAX_DEPTH:
            keep, rest = idx, idx[:0]
        else:
            k = np.floor((self.crs[idx] - lo) / cell).astype(np.int64)
            _, first = np.unique(k, axis=0, return_index=True)
            first = np.sort(first)  # in the shuffled order: an even sample
            if len(first) > self.max_points:
                first = first[: self.max_points]
            mask = np.zeros(len(idx), dtype=bool)
            mask[first] = True
            keep, rest = idx[mask], idx[~mask]
        box = box_of(self.enu[idx], pad=1e-3)
        content = None
        if len(keep):
            content = f"content/{key}.glb"
            centre = np.asarray(box_of(self.enu[keep])[:3])
            c_gltf = enu_to_gltf(centre[None])[0]
            pos = (enu_to_gltf(self.enu[keep]) - c_gltf).astype(np.float32)
            part = Part(positions=pos, colors=self.rgb[keep] if self.rgb is not None else None)
            atomic_write_bytes(self.out / content, write_glb([part], c_gltf))
            self.written += len(keep)
            if self.ctx is not None:
                self.ctx.progress(
                    self.written / max(1, len(self.crs)), f"{self.written} of {len(self.crs)} points"
                )
        tile = Tile(key=key, box=box, error=0.0 if not len(rest) else cell, content=content, count=len(keep))
        if len(rest):
            half = size / 2
            p = self.crs[rest]
            bits = (p >= lo + half).astype(np.int64)
            code = bits[:, 0] | bits[:, 1] << 1 | bits[:, 2] << 2
            for c in range(8):
                sub = rest[code == c]
                if not len(sub):
                    continue
                bx, by, bz = c & 1, c >> 1 & 1, c >> 2 & 1
                child_lo = lo + half * np.array([bx, by, bz])
                tile.children.append(
                    self._node(
                        d + 1, (2 * xyz[0] + bx, 2 * xyz[1] + by, 2 * xyz[2] + bz), child_lo, half, sub
                    )
                )
        return tile


def crs_to_local(xyz: np.ndarray, origin: np.ndarray) -> np.ndarray:
    """Project CRS (E, N, H) to the local frame (x east, y up, z south)."""
    return np.stack([xyz[:, 0] - origin[0], xyz[:, 2] - origin[2], origin[1] - xyz[:, 1]], axis=1)


class TilesCloud:
    name = "tiles.cloud"
    title = "Point cloud to 3D Tiles"
    description = "A COPC point cloud to a 3D Tiles points tileset, for the Globe."

    def validate(self, params: dict[str, Any]) -> dict[str, Any]:
        known_keys(params, KEYS, self.name)
        if params.get("layer") is None:
            raise JobError(f"{self.name} needs: layer.")
        text(params, "layer", required=True)
        text(params, "name")
        tid = params.get("id")
        if tid is not None and not is_tileset_id(tid):
            raise JobError("id must be letters, digits, dot, dash or underscore.")
        number(params, "maxPointsPerTile", None, lo=1000, hi=5_000_000, integer=True)
        return dict(params)

    def plan(self, params: dict[str, Any]) -> list[Step]:
        def read(ctx: StepContext) -> dict[str, Any]:
            from ..change.derived import find_layer, layer_file, read_manifest

            m = read_manifest(ctx.project)
            layer = find_layer(m, params["layer"], "pointcloud", "point cloud layer")
            path = layer_file(ctx.project, layer)
            return {
                "path": str(path),
                "id": params.get("id") or safe_tileset_id(f"{layer['id']}-tiles"),
                "name": params.get("name") or layer.get("name") or layer["id"],
                "capture": layer.get("capture"),
            }

        def tile(ctx: StepContext) -> dict[str, Any]:
            from ..change.derived import read_manifest

            info = ctx.outputs("read")
            m = read_manifest(ctx.project)
            frame = SiteFrame.of(m)
            t0 = time.monotonic()
            xyz, rgb, cube = read_points(ctx, Path(info["path"]))
            if not len(xyz):
                raise JobError("The point cloud has no points.")
            enu = frame.local_to_enu(crs_to_local(xyz, frame.origin))
            out = ctx.stage(f"tiles/{info['id']}/tileset.json").parent
            tiler = CloudTiler(
                xyz, enu, rgb, cube, int(params.get("maxPointsPerTile", DEFAULT_MAX_POINTS)), out, ctx
            )
            root = tiler.run()
            ts = tileset_json(
                root,
                transform=frame.root_transform(),
                refine="ADD",
                generator=GENERATOR,
                extras=frame.extras(m),
            )
            atomic_write_json(out / "tileset.json", ts)
            tiles = root.walk()
            ctx.log(f"{len(tiles)} tiles, {tiler.written} points, in {time.monotonic() - t0:.1f} s")
            return {"tiles": len(tiles), "points": tiler.written}

        def commit(ctx: StepContext) -> dict[str, Any]:
            from ..runtime import commit_tree

            info = ctx.outputs("read")
            rel = f"tiles/{info['id']}"
            replace_folder(ctx.project, rel)
            commit_tree(ctx, rel, rel)
            entry: dict[str, Any] = {
                "id": info["id"],
                "name": info["name"],
                "kind": "points",
                "src": f"{rel}/tileset.json",
                "from": params["layer"],
                "visible": True,
            }
            if info.get("capture"):
                entry["capture"] = info["capture"]
            upsert_tileset(ctx.project, entry)
            ctx.artifact("tilesets.json")
            return {"tileset": entry, **ctx.outputs("tile")}

        return [
            Step("read", "Find the point cloud", read, 0.02),
            Step("tile", "Make the tiles", tile, 0.93),
            Step("commit", "Add the tileset", commit, 0.05),
        ]
