"""What the walk's COLMAP child needs: its progress channel, the pycolmap import and the model export
(moved from photo/colmap_io.py, 14 Oct 2026)."""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

from ..runtime import JobError

PYTHON_ENV = "AIO_COLMAP_PYTHON"


class Out:
    def __init__(self):
        self.path = os.environ.get("AIO_COLMAP_PROGRESS")

    def send(self, **msg) -> None:
        line = json.dumps(msg)
        if self.path:
            with open(self.path, "a", encoding="utf-8") as f:
                f.write(line + "\n")
        else:
            print(line, flush=True)


def utf8_paths() -> bool:
    """Make COLMAP open photos whose paths have letters outside the ANSI code page (Windows).

    COLMAP reads images through the C runtime's narrow file functions, which take a path in the
    ANSI code page: a photo below ``Média`` fails with "BITMAP_ERROR: Failed to read the image
    file format". With the C runtime's character type set to UTF-8 (the pack builds COLMAP
    against the shared UCRT, ``VCPKG_CRT_LINKAGE dynamic``; Windows 10 1803 and later) those
    functions take UTF-8, which is what COLMAP passes. Only ``LC_CTYPE``: numbers keep the "C"
    format. Other systems take UTF-8 already."""
    if os.name != "nt":
        return False
    try:
        import ctypes

        ucrt = ctypes.CDLL("ucrtbase")
        ucrt.setlocale.restype = ctypes.c_char_p
        ucrt.setlocale.argtypes = [ctypes.c_int, ctypes.c_char_p]
        return bool(ucrt.setlocale(2, b".UTF-8"))  # LC_CTYPE
    except (OSError, AttributeError):
        return False


def import_pycolmap(out: Out):
    utf8_paths()
    try:
        import pycolmap
    except Exception as e:
        raise JobError(
            "Photo alignment needs COLMAP (pycolmap), which is not in this pipeline pack "
            f"({type(e).__name__})."
        ) from None
    return pycolmap


def export_model(pc, rec, path: Path) -> dict[str, Any]:
    """A pycolmap reconstruction as ``model.npz`` (``photo/model.py``)."""
    import numpy as np

    cams = sorted(rec.cameras.items())
    cam_params = []
    for _, c in cams:
        p = np.asarray(c.params, dtype=np.float64)
        cam_params.append(np.pad(p, (0, 12 - len(p))))
    reg = sorted(rec.reg_image_ids())
    names, cids, Rs, ts, counts, xys, p3d = [], [], [], [], [], [], []
    for iid in reg:
        im = rec.images[iid]
        cfw = im.cam_from_world() if callable(im.cam_from_world) else im.cam_from_world
        m = np.asarray(cfw.matrix())
        obs = im.get_observation_points2D()
        names.append(im.name)
        cids.append(im.camera_id)
        Rs.append(m[:, :3])
        ts.append(m[:, 3])
        counts.append(len(obs))
        xys.append(np.array([p.xy for p in obs], dtype=np.float64).reshape(-1, 2))
        p3d.append(np.array([p.point3D_id for p in obs], dtype=np.int64))
    pids = sorted(rec.point3D_ids())
    pts = [rec.points3D[i] for i in pids]
    np.savez(
        path,
        cam_ids=np.array([c for c, _ in cams], np.int64),
        cam_models=np.array([c.model.name for _, c in cams]),
        cam_sizes=np.array([[c.width, c.height] for _, c in cams], np.int64).reshape(-1, 2),
        cam_params=np.array(cam_params).reshape(-1, 12),
        img_ids=np.array(reg, np.int64),
        img_names=np.array(names),
        img_cams=np.array(cids, np.int64),
        img_R=np.array(Rs).reshape(-1, 3, 3),
        img_t=np.array(ts).reshape(-1, 3),
        img_counts=np.array(counts, np.int64),
        xys=np.concatenate(xys) if xys else np.zeros((0, 2)),
        p3d=np.concatenate(p3d) if p3d else np.zeros(0, np.int64),
        point_ids=np.array(pids, np.int64),
        xyz=np.array([p.xyz for p in pts], dtype=np.float64).reshape(-1, 3),
        rgb=np.array([p.color for p in pts], dtype=np.uint8).reshape(-1, 3),
        error=np.array([p.error for p in pts], dtype=np.float64),
    )
    return {"path": str(path), "images": len(reg), "points": len(pids)}


def src_root() -> Path:
    return Path(__file__).resolve().parents[2]


def first_octave(max_image_size: int) -> int:
    """SIFT's first octave: -1 (upsample) only for small images, where fine detail needs it."""
    return -1 if max_image_size < 1600 else 0
