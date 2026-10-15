"""Bentley's camera model and poses in Quadrion AI's conventions (data-conventions 1, 21, 35).

- **Rotation**: BlocksExchange ``M`` maps the block SRS to the camera, camera axes x right,
  y down, z forward: COLMAP's own convention, so ``R_colmap = M`` (``x_cam = M (X - C)``). The
  photos layer's camera frame (three.js: x right, y up, looking along -z) is ``M.T @ FLIP``.
- **Frame**: the block SRS must be a projected CRS with an EPSG code. It is read through
  ``opf.geometry.SceneFrame`` with a zero shift, a unit scale and the label "block", so a block in
  another CRS than the project is reprojected horizontally and its camera axes turn with the grid,
  exactly as ``opf.import`` does; heights are used as they are. The frame's notes speak of the
  block, never of OPF.
- **Lens**: focal and principal point in pixels; Bentley's Brown model on normalised
  coordinates. Its tangential terms are taken to be in the other order from OpenCV's
  (``TANGENTIAL_SWAP``); see the known limit there.
"""

from __future__ import annotations

from dataclasses import dataclass
from types import SimpleNamespace
from typing import Any

import numpy as np

from ..opf.geometry import FLIP, Lens, SceneFrame, local_pose, opf_to_colmap, project_crs, read_crs
from ..runtime import JobError
from .blocks import Block, BlockPhoto, Photogroup

#: Bentley's documented model is ``x_d = x(1 + K1 r² + K2 r⁴ + K3 r⁶) + P1 (r² + 2x²) + 2 P2 x y``,
#: so its P1 is OpenCV's p2 and its P2 OpenCV's p1. Known limit: this swap is an assumption from
#: the documentation, not verified against tie points (no export with tie points is available).
#: With P1, P2 of a few 1e-4 a wrong order moves image points by well under a pixel.
TANGENTIAL_SWAP = True

#: How the frame's notes and messages name the source.
FRAME_LABEL = "block"


def lens_of(g: Photogroup) -> Lens:
    """The photogroup's lens, tangential terms in OpenCV order (p1, p2)."""
    p1, p2 = (g.p[1], g.p[0]) if TANGENTIAL_SWAP else g.p
    return Lens(g.width, g.height, g.focal_px, g.cx, g.cy, g.k, (p1, p2))


def lens_record(lens: Lens) -> dict[str, Any]:
    """The photos layer's ``lens``: the pinhole model plus the principal point and distortion."""
    k1, k2, k3 = lens.radial
    p1, p2 = lens.tangential
    return {**lens.pinhole(), "cx": lens.cx, "cy": lens.cy, "k1": k1, "k2": k2, "k3": k3, "p1": p1, "p2": p2}


def block_frame(block: Block, manifest: dict[str, Any]) -> SceneFrame:
    """The block SRS to the project's E, N, H; refuses a block SRS that is not a projected EPSG CRS."""
    definition = block.srs.definition.strip() if block.srs else ""
    info = read_crs(definition) if definition.upper().startswith("EPSG:") else None
    if info is None or info.arbitrary or info.horizontal is None or not info.horizontal.is_projected:
        raise JobError(
            f"The block's SRS ({definition or 'none'}) is not a projected CRS with an EPSG code. "
            "Export the AT again in a projected CRS, such as the project's UTM zone."
        )
    srf = SimpleNamespace(
        crs=SimpleNamespace(definition=definition),
        base_to_canonical=SimpleNamespace(shift=(0.0, 0.0, 0.0), scale=(1.0, 1.0, 1.0), swap_xy=False),
    )
    origin = [float(v) for v in (manifest.get("origin") or [0, 0, 0])]
    return SceneFrame(srf, project_crs(manifest), origin, label=FRAME_LABEL)


@dataclass
class Pose:
    pos: list[float]  # photos layer local frame
    q: list[float]  # three.js x, y, z, w
    qvec: list[float]  # COLMAP w, x, y, z, project CRS
    tvec: list[float]
    enh: np.ndarray  # project easting, northing, height


def camera_pose(photo: BlockPhoto, frame: SceneFrame, origin) -> Pose:
    """An aligned photo's pose in the project frame, for the photos layer and for COLMAP."""
    if photo.rotation is None or photo.centre is None:
        raise JobError(f"The photo {photo.id} is not aligned.")
    enh = frame.to_project(photo.centre)[0]
    r_enu = frame.axes_at(photo.centre) @ (photo.rotation.T @ FLIP)
    pos, q = local_pose(r_enu, enh, origin)
    qvec, tvec = opf_to_colmap(r_enu, enh)
    return Pose(pos, q, qvec, tvec, enh)
