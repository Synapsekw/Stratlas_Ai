"""A small binary glTF 2.0 (GLB) writer and reader for 3D Tiles content.

One node, one mesh, one primitive per part: triangles with normals, texture coordinates and an
embedded image, or points with colours. The node's translation (a JSON double) carries the tile
centre, so positions stay small float32 offsets (relative to centre, as 3D Tiles content should).
"""

from __future__ import annotations

import json
import struct
from dataclasses import dataclass, field
from typing import Any

import numpy as np

FLOAT = 5126
UBYTE = 5121
UINT = 5125
ARRAY_BUFFER = 34962
ELEMENT_ARRAY_BUFFER = 34963
TRIANGLES = 4
POINTS = 0


@dataclass
class Part:
    positions: np.ndarray  # (n, 3) float32, relative to the node translation
    indices: np.ndarray | None = None  # (m, 3) uint32; None for points
    normals: np.ndarray | None = None
    uvs: np.ndarray | None = None
    colors: np.ndarray | None = None  # (n, 3 or 4) uint8
    image: bytes | None = None
    mime: str = "image/jpeg"
    base_color: tuple[float, float, float, float] = (1.0, 1.0, 1.0, 1.0)
    extras: dict[str, Any] = field(default_factory=dict)


class _Bin:
    def __init__(self) -> None:
        self.data = bytearray()
        self.views: list[dict[str, Any]] = []
        self.accessors: list[dict[str, Any]] = []

    def view(self, raw: bytes, target: int | None = None) -> int:
        while len(self.data) % 4:
            self.data.append(0)
        v: dict[str, Any] = {"buffer": 0, "byteOffset": len(self.data), "byteLength": len(raw)}
        if target is not None:
            v["target"] = target
        self.data += raw
        self.views.append(v)
        return len(self.views) - 1

    def accessor(
        self,
        arr: np.ndarray,
        ctype: int,
        kind: str,
        target: int,
        normalized: bool = False,
        bounds: bool = False,
    ) -> int:
        view = self.view(np.ascontiguousarray(arr).tobytes(), target)
        a: dict[str, Any] = {
            "bufferView": view,
            "componentType": ctype,
            "count": int(arr.shape[0]),
            "type": kind,
        }
        if normalized:
            a["normalized"] = True
        if bounds:
            a["min"] = [float(v) for v in arr.min(axis=0)]
            a["max"] = [float(v) for v in arr.max(axis=0)]
        self.accessors.append(a)
        return len(self.accessors) - 1


def write_glb(
    parts: list[Part], translation: np.ndarray | list[float], *, extras: dict[str, Any] | None = None
) -> bytes:
    b = _Bin()
    primitives: list[dict[str, Any]] = []
    materials: list[dict[str, Any]] = []
    textures: list[dict[str, Any]] = []
    images: list[dict[str, Any]] = []
    uses_unlit = False
    for part in parts:
        pos = np.asarray(part.positions, dtype=np.float32).reshape(-1, 3)
        if not len(pos):
            continue
        attrs = {"POSITION": b.accessor(pos, FLOAT, "VEC3", ARRAY_BUFFER, bounds=True)}
        if part.normals is not None:
            attrs["NORMAL"] = b.accessor(np.asarray(part.normals, np.float32), FLOAT, "VEC3", ARRAY_BUFFER)
        if part.uvs is not None:
            attrs["TEXCOORD_0"] = b.accessor(np.asarray(part.uvs, np.float32), FLOAT, "VEC2", ARRAY_BUFFER)
        if part.colors is not None:
            c = np.asarray(part.colors, np.uint8)
            attrs["COLOR_0"] = b.accessor(
                c, UBYTE, "VEC4" if c.shape[1] == 4 else "VEC3", ARRAY_BUFFER, normalized=True
            )
        mat: dict[str, Any] = {
            "pbrMetallicRoughness": {
                "baseColorFactor": list(part.base_color),
                "metallicFactor": 0.0,
                "roughnessFactor": 1.0,
            },
            "doubleSided": True,
        }
        if part.image is not None:
            img_view = b.view(part.image)
            images.append({"bufferView": img_view, "mimeType": part.mime})
            textures.append({"source": len(images) - 1, "sampler": 0})
            mat["pbrMetallicRoughness"]["baseColorTexture"] = {"index": len(textures) - 1}
        prim: dict[str, Any] = {"attributes": attrs, "material": len(materials)}
        if part.indices is None:
            prim["mode"] = POINTS
            mat["extensions"] = {"KHR_materials_unlit": {}}
            uses_unlit = True
        else:
            idx = np.asarray(part.indices, dtype=np.uint32).reshape(-1)
            prim["indices"] = b.accessor(idx, UINT, "SCALAR", ELEMENT_ARRAY_BUFFER)
            prim["mode"] = TRIANGLES
        materials.append(mat)
        primitives.append(prim)
    t = [float(v) for v in translation]
    gltf: dict[str, Any] = {
        "asset": {"version": "2.0", "generator": "Quadrion AI pipeline pack"},
        "scene": 0,
        "scenes": [{"nodes": [0]}],
        "nodes": [{"mesh": 0, "translation": t}],
        "meshes": [{"primitives": primitives}],
        "materials": materials,
        "buffers": [{"byteLength": 0}],
        "bufferViews": b.views,
        "accessors": b.accessors,
    }
    if images:
        gltf["images"] = images
        gltf["textures"] = textures
        gltf["samplers"] = [{"magFilter": 9729, "minFilter": 9987, "wrapS": 33071, "wrapT": 33071}]
    if uses_unlit:
        gltf["extensionsUsed"] = ["KHR_materials_unlit"]
    if extras:
        gltf["extras"] = extras
    while len(b.data) % 4:
        b.data.append(0)
    gltf["buffers"][0]["byteLength"] = len(b.data)
    js = json.dumps(gltf, separators=(",", ":")).encode("utf-8")
    js += b" " * ((4 - len(js) % 4) % 4)
    total = 12 + 8 + len(js) + 8 + len(b.data)
    return b"".join(
        [
            struct.pack("<4sII", b"glTF", 2, total),
            struct.pack("<I4s", len(js), b"JSON"),
            js,
            struct.pack("<I4s", len(b.data), b"BIN\x00"),
            bytes(b.data),
        ]
    )


_DTYPES = {FLOAT: np.float32, UBYTE: np.uint8, UINT: np.uint32, 5123: np.uint16}
_WIDTH = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4}


def read_glb(data: bytes) -> tuple[dict[str, Any], list[dict[str, np.ndarray]]]:
    """The JSON and, per primitive, its attribute arrays (``indices`` too), for tests and checks."""
    magic, version, _ = struct.unpack_from("<4sII", data, 0)
    if magic != b"glTF" or version != 2:
        raise ValueError("not a GLB 2.0 file")
    jlen, _ = struct.unpack_from("<I4s", data, 12)
    gltf = json.loads(data[20 : 20 + jlen])
    blen, _ = struct.unpack_from("<I4s", data, 20 + jlen)
    binary = data[28 + jlen : 28 + jlen + blen]

    def arr(i: int) -> np.ndarray:
        a = gltf["accessors"][i]
        v = gltf["bufferViews"][a["bufferView"]]
        dt = _DTYPES[a["componentType"]]
        w = _WIDTH[a["type"]]
        raw = np.frombuffer(
            binary, dtype=dt, count=a["count"] * w, offset=v.get("byteOffset", 0) + a.get("byteOffset", 0)
        )
        return raw.reshape(-1, w) if w > 1 else raw

    prims = []
    for p in gltf["meshes"][0]["primitives"]:
        out = {k: arr(i) for k, i in p["attributes"].items()}
        if "indices" in p:
            out["indices"] = arr(p["indices"])
        prims.append(out)
    return gltf, prims
