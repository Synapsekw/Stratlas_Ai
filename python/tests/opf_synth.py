"""Synthetic OPF test data (no client data): a fictional desert site in UTM zone 39N.

- ``make_project``: an empty Stratlas project (EPSG:32639, origin 500000 E, 3200000 N).
- ``make_run``: a processed run in a project, as stream G2/G3 leave it: original photos in a
  folder outside the project, ``photogrammetry/<run>/run.json``, a COLMAP text sparse model as
  ``photo.align`` writes it (grid frame, ``frame.json``, ``photos.json``), ``gcp.json`` with control
  and check points and marks, and a small orthomosaic and DSM (COG-sized GeoTIFFs) listed in the
  run's outputs.
- ``write_opf``: a hand-written OPF 1.0 project following the specification (CC-BY-4.0, Pix4D):
  photos beside it, input and calibrated cameras, control points, a dense OPF glTF point cloud
  and an orthomosaic and DSM item; written as plain JSON, independently of pyopf's writer.

``python opf_synth.py <folder>`` writes ``write_opf`` into ``<folder>`` (the e2e fixture) and prints
its project path.
"""

from __future__ import annotations

import json
import math
import sys
from pathlib import Path

import numpy as np
from PIL import Image

EPSG = 32639
ORIGIN = (500000.0, 3200000.0, 0.0)
W, H = 640, 480
FOCAL = 520.0
RNG_SEED = 7


def make_project(root: Path, name: str = "OPF test project") -> Path:
    root.mkdir(parents=True, exist_ok=True)
    manifest = {
        "schema": "aio.project/1",
        "id": root.name,
        "name": name,
        "crs": {"epsg": EPSG},
        "origin": list(ORIGIN),
        "captures": [],
        "layers": [],
        "severityModels": [],
        "classCatalogues": [],
    }
    (root / "manifest.json").write_text(json.dumps(manifest, indent=2), "utf-8")
    return root


def _photo(path: Path, seed: int) -> None:
    rng = np.random.default_rng(seed)
    base = rng.integers(60, 200, size=(H // 16, W // 16, 3), dtype=np.uint8)
    im = Image.fromarray(base).resize((W, H), Image.Resampling.BILINEAR)
    path.parent.mkdir(parents=True, exist_ok=True)
    im.save(path, "JPEG", quality=85)


def _rot(omega: float, phi: float, kappa: float) -> np.ndarray:
    w, p, k = (math.radians(v) for v in (omega, phi, kappa))
    rx = np.array([[1, 0, 0], [0, math.cos(w), -math.sin(w)], [0, math.sin(w), math.cos(w)]])
    ry = np.array([[math.cos(p), 0, math.sin(p)], [0, 1, 0], [-math.sin(p), 0, math.cos(p)]])
    rz = np.array([[math.cos(k), -math.sin(k), 0], [math.sin(k), math.cos(k), 0], [0, 0, 1]])
    return rx @ ry @ rz


def cameras(n: int = 6) -> list[dict]:
    """Nadir-ish cameras on two flight lines 60 m up, in the project CRS (E, N, H) with OPK angles."""
    out = []
    for i in range(n):
        line, k = divmod(i, max(1, n // 2))
        e = ORIGIN[0] + 20.0 + 18.0 * k
        nn = ORIGIN[1] + 15.0 + 25.0 * line
        opk = [1.5 * math.sin(i), -2.0 * math.cos(i), 90.0 * line + 3.0 * i]
        out.append({"name": f"flight1/IMG_{i + 1:04d}.JPG", "enh": [e, nn, 62.0 + 0.3 * i], "opk": opk})
    return out


def _quat_wxyz(r: np.ndarray) -> list[float]:
    t = np.trace(r)
    if t > 0:
        s = math.sqrt(t + 1) * 2
        q = [0.25 * s, (r[2, 1] - r[1, 2]) / s, (r[0, 2] - r[2, 0]) / s, (r[1, 0] - r[0, 1]) / s]
    elif r[0, 0] > r[1, 1] and r[0, 0] > r[2, 2]:
        s = math.sqrt(1 + r[0, 0] - r[1, 1] - r[2, 2]) * 2
        q = [(r[2, 1] - r[1, 2]) / s, 0.25 * s, (r[0, 1] + r[1, 0]) / s, (r[0, 2] + r[2, 0]) / s]
    elif r[1, 1] > r[2, 2]:
        s = math.sqrt(1 + r[1, 1] - r[0, 0] - r[2, 2]) * 2
        q = [(r[0, 2] - r[2, 0]) / s, (r[0, 1] + r[1, 0]) / s, 0.25 * s, (r[1, 2] + r[2, 1]) / s]
    else:
        s = math.sqrt(1 + r[2, 2] - r[0, 0] - r[1, 1]) * 2
        q = [(r[1, 0] - r[0, 1]) / s, (r[0, 2] + r[2, 0]) / s, (r[1, 2] + r[2, 1]) / s, 0.25 * s]
    return [-v for v in q] if q[0] < 0 else q


def tie_points(n: int = 200) -> tuple[np.ndarray, np.ndarray]:
    rng = np.random.default_rng(RNG_SEED)
    xyz = np.column_stack(
        [ORIGIN[0] + rng.uniform(0, 80, n), ORIGIN[1] + rng.uniform(0, 60, n), rng.uniform(0, 4, n)]
    )
    rgb = rng.integers(0, 256, size=(n, 3), dtype=np.uint8)
    return xyz, rgb


GCPS = [
    {"id": "GCP1", "role": "control", "enh": [ORIGIN[0] + 25.0, ORIGIN[1] + 20.0, 1.2]},
    {"id": "GCP2", "role": "control", "enh": [ORIGIN[0] + 70.0, ORIGIN[1] + 22.0, 0.8]},
    {"id": "CHK1", "role": "check", "enh": [ORIGIN[0] + 45.0, ORIGIN[1] + 38.0, 2.1]},
]


def _geotiffs(folder: Path) -> tuple[Path, Path]:
    import rasterio
    from rasterio.transform import from_origin

    folder.mkdir(parents=True, exist_ok=True)
    t = from_origin(ORIGIN[0], ORIGIN[1] + 64.0, 0.25, 0.25)
    ortho, dsm = folder / "ortho.tif", folder / "dsm.tif"
    yy, xx = np.mgrid[0:256, 0:320]
    rgb = np.stack([(xx % 256), (yy % 256), ((xx + yy) % 256)]).astype(np.uint8)
    with rasterio.open(
        ortho,
        "w",
        driver="GTiff",
        width=320,
        height=256,
        count=3,
        dtype="uint8",
        crs=f"EPSG:{EPSG}",
        transform=t,
    ) as ds:
        ds.write(rgb)
    z = (2.0 + np.sin(xx / 30.0) + np.cos(yy / 25.0)).astype(np.float32)[None]
    with rasterio.open(
        dsm,
        "w",
        driver="GTiff",
        width=320,
        height=256,
        count=1,
        dtype="float32",
        crs=f"EPSG:{EPSG}",
        transform=t,
        nodata=-9999,
    ) as ds:
        ds.write(z)
    return ortho, dsm


def make_run(
    project: Path, photos: Path, run: str = "20261007-0900", n: int = 6, legacy: bool = False
) -> dict:
    """A processed run (folder source), as described in the module notes. Returns the truth.

    The sparse model is written as ``photo.align`` writes it: in the grid frame (project CRS minus
    the manifest origin) with ``frame.json`` and ``photos.json``. ``legacy``: in the project CRS
    itself without them (a model folder made by hand or by an older import)."""
    cams = cameras(n)
    for i, c in enumerate(cams):
        _photo(photos / c["name"], i)
    rd = project / "photogrammetry" / run
    (rd / "sparse").mkdir(parents=True, exist_ok=True)
    shift = np.zeros(3) if legacy else np.asarray(ORIGIN, dtype=np.float64)
    if not legacy:
        from aio_pipelines.photo import crs as C
        from aio_pipelines.photo.align import LIST_SCHEMA, frame_record

        grid = C.GridFrame(C.crs_of(EPSG), ORIGIN)
        lon, lat, _ = grid.to_geodetic([[0.0, 0.0, 0.0]])
        frame = frame_record(grid, C.EnuFrame(float(lon[0]), float(lat[0]), ORIGIN[2]), {})
        (rd / "sparse" / "frame.json").write_text(json.dumps(frame, indent=1), "utf-8")
        listing = {c["name"]: {"name": c["name"], "width": W, "height": H} for c in cams}
        (rd / "sparse" / "photos.json").write_text(
            json.dumps({"schema": LIST_SCHEMA, "imageRoot": str(photos), "photos": listing}), "utf-8"
        )
    params = [FOCAL, FOCAL * 1.0, W / 2 + 3.25, H / 2 - 1.5, -0.081, 0.012, 0.0004, -0.0007]
    (rd / "sparse" / "cameras.txt").write_text(
        f"1 OPENCV {W} {H} {' '.join(repr(p) for p in params)}\n", "utf-8"
    )
    lines = []
    flip = np.diag([1.0, -1.0, -1.0])
    for i, c in enumerate(cams):
        r = _rot(*c["opk"])
        r_cw = flip @ r.T
        t = -r_cw @ (np.asarray(c["enh"]) - shift)
        q = _quat_wxyz(r_cw)
        lines.append(" ".join([str(i + 1), *(repr(float(v)) for v in (*q, *t)), "1", c["name"]]))
        lines.append("")
    (rd / "sparse" / "images.txt").write_text("\n".join(lines) + "\n", "utf-8")
    xyz, rgb = tie_points()
    xyz = xyz - shift
    pts = [
        f"{i + 1} {x!r} {y!r} {z!r} {r} {g} {b} 0.5"
        for i, ((x, y, z), (r, g, b)) in enumerate(zip(xyz.tolist(), rgb.tolist(), strict=True))
    ]
    (rd / "sparse" / "points3D.txt").write_text("\n".join(pts) + "\n", "utf-8")
    gcp = {
        "schema": "aio.gcp/1",
        "crs": {"epsg": EPSG},
        "points": [
            {
                "id": g["id"],
                "role": g["role"],
                "xyz": g["enh"],
                "accuracy": {"horizontalM": 0.02, "verticalM": 0.03},
                "marks": [
                    {
                        "photo": cams[k]["name"],
                        "px": [100.5 + 10 * k, 200.25 - 5 * k],
                        "by": "person",
                        "at": "2026-10-07T09:00:00Z",
                        "state": "confirmed",
                    }
                    for k in range(3)
                ]
                + [
                    {
                        "photo": cams[3]["name"],
                        "px": [5, 5],
                        "by": "detector",
                        "at": "2026-10-07T09:00:00Z",
                        "state": "draft",
                    }
                ],
            }
            for g in GCPS
        ],
    }
    (rd / "gcp.json").write_text(json.dumps(gcp, indent=1), "utf-8")
    _geotiffs(rd)
    run_json = {
        "schema": "aio.photo-run/1",
        "id": run,
        "createdAt": "2026-10-07T09:00:00Z",
        "status": "done",
        "preset": "standard",
        "photos": {"source": {"folders": [str(photos)]}, "count": n, "registered": n},
        "cameras": [
            {"id": "cam-1", "model": "SYN-20", "widthPx": W, "heightPx": H, "sensorWidthMm": 6.4, "photos": n}
        ],
        "crs": {"epsg": EPSG},
        "stages": [],
        "outputs": {
            "layers": [],
            "tilesets": [],
            "files": [f"photogrammetry/{run}/ortho.tif", f"photogrammetry/{run}/dsm.tif"],
        },
        "versions": {"pack": "test"},
    }
    (rd / "run.json").write_text(json.dumps(run_json, indent=1), "utf-8")
    return {"cameras": cams, "params": params, "tie": (xyz, rgb), "gcps": GCPS}


# ---------------------------------------------------------------- a hand-written OPF project


def _item(iid: str, kind: str, resources: list, sources: list | None = None, name: str | None = None) -> dict:
    out = {"id": iid, "type": kind, "resources": resources, "sources": sources or []}
    if name:
        out["name"] = name
    return out


def write_gltf_cloud(folder: Path, proc: np.ndarray, rgb: np.ndarray, name: str = "dense") -> str:
    """An OPF glTF point cloud (Z-up node matrix, float positions, RGBA colours) in ``folder``."""
    folder.mkdir(parents=True, exist_ok=True)
    pos = proc.astype("<f4")
    col = np.column_stack([rgb, np.full(len(rgb), 255)]).astype(np.uint8)
    (folder / f"{name}-positions.bin").write_bytes(pos.tobytes())
    (folder / f"{name}-colors.bin").write_bytes(col.tobytes())
    doc = {
        "asset": {"version": "2.0", "extensions": {"OPF_asset_version": {"version": "1.0"}}},
        "extensionsUsed": ["KHR_materials_unlit", "OPF_asset_version"],
        "extensionsRequired": ["KHR_materials_unlit"],
        "scene": 0,
        "scenes": [{"nodes": [0]}],
        "nodes": [{"mesh": 0, "matrix": [1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1]}],
        "materials": [{"extensions": {"KHR_materials_unlit": {}}}],
        "meshes": [{"primitives": [{"attributes": {"POSITION": 0, "COLOR_0": 1}, "mode": 0, "material": 0}]}],
        "buffers": [
            {"uri": f"{name}-positions.bin", "byteLength": pos.nbytes},
            {"uri": f"{name}-colors.bin", "byteLength": col.nbytes},
        ],
        "bufferViews": [
            {"buffer": 0, "byteOffset": 0, "byteLength": pos.nbytes},
            {"buffer": 1, "byteOffset": 0, "byteLength": col.nbytes},
        ],
        "accessors": [
            {
                "bufferView": 0,
                "componentType": 5126,
                "count": len(pos),
                "type": "VEC3",
                "min": pos.min(axis=0).tolist(),
                "max": pos.max(axis=0).tolist(),
            },
            {"bufferView": 1, "componentType": 5121, "count": len(col), "type": "VEC4", "normalized": True},
        ],
    }
    (folder / f"{name}.gltf").write_text(json.dumps(doc), "utf-8")
    return f"{name}.gltf"


def write_opf(folder: Path, n: int = 6, absolute_photos: bool = False, with_outputs: bool = True) -> Path:
    """A hand-written OPF 1.0 project in ``folder``; returns ``folder/project.opf``."""
    folder.mkdir(parents=True, exist_ok=True)
    cams = cameras(n)
    shift = [-ORIGIN[0] - 40.0, -ORIGIN[1] - 30.0, 0.0]
    for i, c in enumerate(cams):
        _photo(folder / "images" / c["name"], 100 + i)
    uri = (
        (lambda c: (folder / "images" / c["name"]).resolve().as_uri())
        if absolute_photos
        else (lambda c: f"images/{c['name']}")
    )
    camera_list = {
        "format": "application/opf-camera-list+json",
        "version": "1.0",
        "cameras": [{"id": 1000 + i, "uri": uri(c)} for i, c in enumerate(cams)],
    }
    internals = {
        "type": "perspective",
        "principal_point_px": [W / 2 + 2.0, H / 2 - 1.0],
        "focal_length_px": FOCAL,
        "radial_distortion": [-0.05, 0.01, -0.001],
        "tangential_distortion": [0.0002, -0.0003],
    }
    sensor = {
        "id": 77,
        "name": "SYN-20 synthetic camera",
        "bands": [
            {"name": "Red", "weight": 0.3},
            {"name": "Green", "weight": 0.4},
            {"name": "Blue", "weight": 0.3},
        ],
        "image_size_px": [W, H],
        "internals": internals,
        "pixel_size_um": 10.0,
        "shutter_type": "global",
    }
    input_cameras = {
        "format": "application/opf-input-cameras+json",
        "version": "1.0",
        "sensors": [sensor],
        "captures": [
            {
                "id": 5000 + i,
                "time": f"2026-10-01T08:{10 + i:02d}:00Z",
                "rig_model_source": "not_applicable",
                "reference_camera_id": 1000 + i,
                "height_above_takeoff_m": 60.0,
                "geolocation": {
                    "crs": {"definition": f"EPSG:{EPSG}"},
                    "coordinates": c["enh"],
                    "sigmas": [2, 2, 5],
                },
                "cameras": [
                    {
                        "id": 1000 + i,
                        "sensor_id": 77,
                        "model_source": "database",
                        "pixel_type": "uint8",
                        "pixel_range": {"min": 0, "max": 255},
                    }
                ],
            }
            for i, c in enumerate(cams)
        ],
    }
    srf = {
        "format": "application/opf-scene-reference-frame+json",
        "version": "1.0",
        "crs": {"definition": f"EPSG:{EPSG}"},
        "base_to_canonical": {"scale": [1, 1, 1], "shift": shift, "swap_xy": False},
    }
    calibrated = {
        "format": "application/opf-calibrated-cameras+json",
        "version": "1.0",
        "sensors": [{"id": 77, "internals": internals}],
        "cameras": [
            {
                "id": 1000 + i,
                "sensor_id": 77,
                "position": [c["enh"][k] + shift[k] for k in range(3)],
                "orientation_deg": c["opk"],
            }
            for i, c in enumerate(cams)
        ],
    }
    gcps = {
        "format": "application/opf-input-control-points+json",
        "version": "1.0",
        "gcps": [
            {
                "id": g["id"],
                "geolocation": {
                    "crs": {"definition": f"EPSG:{EPSG}"},
                    "coordinates": g["enh"],
                    "sigmas": [0.02, 0.02, 0.03],
                },
                "is_checkpoint": g["role"] == "check",
                "marks": [
                    {"camera_id": 1000 + k, "position_px": [120.0 + k, 210.5 - k], "accuracy": 1.0}
                    for k in range(3)
                ],
            }
            for g in GCPS
        ],
        "mtps": [
            {
                "id": "MTP1",
                "is_checkpoint": False,
                "marks": [{"camera_id": 1000, "position_px": [1, 2], "accuracy": 1}],
            }
        ],
    }
    for name, doc in (
        ("camera_list.json", camera_list),
        ("input_cameras.json", input_cameras),
        ("scene_reference_frame.json", srf),
        ("calibration/calibrated_cameras.json", calibrated),
        ("input_control_points.json", gcps),
    ):
        (folder / name).parent.mkdir(parents=True, exist_ok=True)
        (folder / name).write_text(json.dumps(doc, indent=2), "utf-8")
    xyz, rgb = tie_points()
    proc = xyz + np.asarray(shift)
    write_gltf_cloud(folder / "calibration", proc[:50], rgb[:50], "tracks")
    write_gltf_cloud(folder / "dense", proc, rgb, "dense")
    items = [
        _item(
            "0bc95642-e37f-46df-a2c6-3ddd65881801",
            "camera_list",
            [{"uri": "camera_list.json", "format": "application/opf-camera-list+json"}],
        ),
        _item(
            "57608ca8-912d-4fee-b097-2648651474c2",
            "input_cameras",
            [{"uri": "input_cameras.json", "format": "application/opf-input-cameras+json"}],
            [{"id": "0bc95642-e37f-46df-a2c6-3ddd65881801", "type": "camera_list"}],
        ),
        _item(
            "83291b5e-d239-4d94-93fb-226f70d7cd33",
            "scene_reference_frame",
            [{"uri": "scene_reference_frame.json", "format": "application/opf-scene-reference-frame+json"}],
        ),
        _item(
            "dad66aa8-6e52-4d7c-8cec-c6fd9da2aae4",
            "input_control_points",
            [{"uri": "input_control_points.json", "format": "application/opf-input-control-points+json"}],
            [{"id": "0bc95642-e37f-46df-a2c6-3ddd65881801", "type": "camera_list"}],
        ),
        _item(
            "6e12d73b-c8c0-4059-9c13-0a5ff2afaed5",
            "calibration",
            [
                {
                    "uri": "calibration/calibrated_cameras.json",
                    "format": "application/opf-calibrated-cameras+json",
                },
                {"uri": "calibration/tracks.gltf", "format": "model/gltf+json"},
                {"uri": "calibration/tracks-positions.bin", "format": "application/gltf-buffer+bin"},
                {"uri": "calibration/tracks-colors.bin", "format": "application/gltf-buffer+bin"},
            ],
            [
                {"id": "57608ca8-912d-4fee-b097-2648651474c2", "type": "input_cameras"},
                {"id": "83291b5e-d239-4d94-93fb-226f70d7cd33", "type": "scene_reference_frame"},
            ],
        ),
        _item(
            "31ee32ac-5095-4507-a342-21cfcf12c546",
            "point_cloud",
            [
                {"uri": "dense/dense.gltf", "format": "model/gltf+json"},
                {"uri": "dense/dense-positions.bin", "format": "application/gltf-buffer+bin"},
                {"uri": "dense/dense-colors.bin", "format": "application/gltf-buffer+bin"},
            ],
            [{"id": "6e12d73b-c8c0-4059-9c13-0a5ff2afaed5", "type": "calibration"}],
            name="Dense cloud",
        ),
    ]
    if with_outputs:
        _geotiffs(folder / "outputs")
        items.append(
            _item(
                "a71bf97a-045c-11ee-be56-0242ac120007",
                "ext_example_orthomosaic",
                [{"uri": "outputs/ortho.tif", "format": "image/tiff"}],
                name="Orthomosaic",
            )
        )
        items.append(
            _item(
                "a71bf97a-045c-11ee-be56-0242ac120008",
                "ext_example_dsm",
                [{"uri": "outputs/dsm.tif", "format": "image/tiff"}],
                name="DSM",
            )
        )
        items.append(
            _item(
                "a71bf97a-045c-11ee-be56-0242ac120009",
                "ext_example_mesh",
                [{"uri": "outputs/mesh.obj", "format": "model/obj"}],
                name="Mesh",
            )
        )
        (folder / "outputs" / "mesh.obj").write_text("v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n", "utf-8")
    project = {
        "format": "application/opf-project+json",
        "version": "1.0",
        "id": "caa7754e-90dc-11ec-b909-0242ac120009",
        "name": "Synthetic OPF site",
        "description": "Hand-written OPF fixture (no client data)",
        "generator": {"name": "Stratlas test fixture", "version": "1"},
        "items": items,
    }
    path = folder / "project.opf"
    path.write_text(json.dumps(project, indent=2), "utf-8")
    return path


if __name__ == "__main__":
    print(write_opf(Path(sys.argv[1])))
