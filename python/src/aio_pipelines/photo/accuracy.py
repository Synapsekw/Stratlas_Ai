"""The accuracy report (``aio.photo-accuracy/1``): residuals, RMSE per role, camera residuals.

Honest by construction:

- every control and check point is listed with its residual, including outliers left out of the
  adjustment and points with too few marks (with a warning, never dropped silently);
- checkpoints are measured through the adjusted cameras only; ``checkpointsInAdjustment`` is
  always false, and ``report`` refuses to write anything else;
- a run without ground control says that its absolute accuracy is only the GNSS accuracy.

Every listed point says ``usedInAdjustment``: true for a control point that constrained the
adjustment, false for checkpoints, for control points left out as outliers, and for every point of
a GNSS-only alignment (disabled points are not measured and not listed).

Residuals are ``measured - surveyed`` in the run's grid frame (project CRS easting, northing and
height, metres), where *measured* is the point triangulated from its confirmed marks through the
adjusted cameras. RMSE horizontal is ``sqrt(mean(dx^2 + dy^2))``, vertical ``sqrt(mean(dz^2))``.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import numpy as np

from ..runtime import JobError
from .model import SparseModel

ACCURACY_SCHEMA = "aio.photo-accuracy/1"
#: A GNSS camera height this far from the control-adjusted one is flagged (the Al-Zour lesson).
GNSS_HEIGHT_LIMIT_M = 1.0


@dataclass
class PointResidual:
    id: str
    role: str
    d: np.ndarray  # dx, dy, dz metres (grid frame)
    reproj_px: float
    marks: int
    used: bool = True  # in the adjustment (control points only)


@dataclass
class Warning_:
    code: str
    message: str
    point: str | None = None

    def record(self) -> dict[str, Any]:
        out: dict[str, Any] = {"code": self.code, "message": self.message[:500]}
        if self.point:
            out["point"] = self.point
        return out


def rmse(residuals: list[np.ndarray]) -> dict[str, Any] | None:
    """``{ n, horizontalM, verticalM }`` of residual vectors, or None when there are none."""
    if not residuals:
        return None
    d = np.asarray(residuals, dtype=np.float64).reshape(-1, 3)
    return {
        "n": len(d),
        "horizontalM": round(float(np.sqrt(np.mean(d[:, 0] ** 2 + d[:, 1] ** 2))), 4),
        "verticalM": round(float(np.sqrt(np.mean(d[:, 2] ** 2))), 4),
    }


def camera_residuals(adjusted: np.ndarray, gnss: np.ndarray) -> dict[str, float] | None:
    """Adjusted camera centres against their GNSS positions (both in the grid frame)."""
    if len(adjusted) == 0:
        return None
    d = np.asarray(adjusted) - np.asarray(gnss)
    n = np.linalg.norm(d, axis=1)
    return {
        "medianM": round(float(np.median(n)), 4),
        "maxM": round(float(n.max()), 4),
        "rmseHorizontalM": round(float(np.sqrt(np.mean(d[:, 0] ** 2 + d[:, 1] ** 2))), 4),
        "rmseVerticalM": round(float(np.sqrt(np.mean(d[:, 2] ** 2))), 4),
    }


def gsd_cm(model: SparseModel) -> float | None:
    """Median ground sample distance: depth of each photo's points over its focal length."""
    img, pts, _ = model.observations()
    if len(pts) == 0:
        return None
    values = []
    for iid in np.unique(img):
        im = model.images[int(iid)]
        X = model.xyz[pts[img == iid]]
        depth = (X - im.centre) @ im.R[2]
        depth = depth[depth > 0]
        if len(depth):
            values.append(float(np.median(depth)) / model.cameras[im.camera_id].focal)
    return round(float(np.median(values)) * 100, 3) if values else None


def overlap_counts(model: SparseModel) -> np.ndarray:
    """Images per tie point (track length), the overlap measure of the report."""
    return model.track_lengths()


@dataclass
class ReportInput:
    run: str
    created_at: str
    crs: dict[str, Any]
    heights: dict[str, Any] | None
    images_total: int
    images_registered: int
    mean_reproj_px: float
    gsd_cm: float | None
    points: list[PointResidual] = field(default_factory=list)
    cameras: dict[str, float] | None = None
    overlap: str | None = None
    warnings: list[Warning_] = field(default_factory=list)


def report(inp: ReportInput) -> dict[str, Any]:
    """The ``aio.photo-accuracy/1`` record. RMSE per role counts only control points used in the
    adjustment and every checkpoint; every point is listed."""
    control = [p.d for p in inp.points if p.role == "control" and p.used]
    check = [p.d for p in inp.points if p.role == "check"]
    rm: dict[str, Any] = {}
    if control:
        rm["control"] = rmse(control)
    if check:
        rm["check"] = rmse(check)
    out: dict[str, Any] = {
        "schema": ACCURACY_SCHEMA,
        "run": inp.run,
        "createdAt": inp.created_at,
        "crs": inp.crs,
        "images": {"total": int(inp.images_total), "registered": int(inp.images_registered)},
        "meanReprojPx": round(float(max(inp.mean_reproj_px, 0.0)), 4),
        "points": [
            {
                "id": p.id,
                "role": p.role,
                "dxM": round(float(p.d[0]), 4),
                "dyM": round(float(p.d[1]), 4),
                "dzM": round(float(p.d[2]), 4),
                "reprojPx": round(float(max(p.reproj_px, 0.0)), 3),
                "marks": int(p.marks),
                "usedInAdjustment": bool(p.used and p.role == "control"),
            }
            for p in inp.points
        ],
        "rmse": rm,
        "checkpointsInAdjustment": False,
        "warnings": [w.record() for w in inp.warnings][:1000],
    }
    if inp.heights:
        out["heights"] = inp.heights
    if inp.gsd_cm:
        out["gsdCm"] = inp.gsd_cm
    if inp.cameras:
        out["cameraResiduals"] = inp.cameras
    if inp.overlap:
        out["overlap"] = inp.overlap
    if out["checkpointsInAdjustment"] is not False:  # pragma: no cover - a guard, never reached
        raise JobError("Checkpoints must never be used in the adjustment.")
    return out


def summary(rep: dict[str, Any]) -> dict[str, Any]:
    """The run's ``accuracy`` summary (``AccuracySummary``) from a full report."""
    out: dict[str, Any] = {"meanReprojPx": rep["meanReprojPx"], "warnings": len(rep.get("warnings") or [])}
    for role in ("control", "check"):
        if role in rep.get("rmse", {}):
            out[role] = rep["rmse"][role]
    if rep.get("gsdCm"):
        out["gsdCm"] = rep["gsdCm"]
    return out


def unmeasured_warnings(points: list[PointResidual]) -> list[Warning_]:
    """Points that could not be measured (fewer than two confirmed marks in aligned photos)."""
    return [
        Warning_(
            "few-marks",
            f"{p.id} is not measured: it has {p.marks} confirmed marks in aligned photos; mark it in at least 3.",
            p.id,
        )
        for p in points
    ]


def point_warnings(points: list[PointResidual], gsd_m: float | None) -> list[Warning_]:
    """Few marks, and points far off (more than ten GSD or 10 cm)."""
    out: list[Warning_] = []
    limit = max(0.10, 10 * (gsd_m or 0.0))
    for p in points:
        if p.marks < 3:
            out.append(
                Warning_(
                    "few-marks", f"{p.id} has {p.marks} confirmed marks; mark it in at least 3 photos.", p.id
                )
            )
        dist = float(np.linalg.norm(p.d))
        if p.role == "check" and dist > limit:
            out.append(
                Warning_(
                    "other", f"Checkpoint {p.id} is {dist:.2f} m off; check its coordinates or marks.", p.id
                )
            )
    return out
