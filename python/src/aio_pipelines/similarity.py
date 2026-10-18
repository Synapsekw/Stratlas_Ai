"""2D similarity (shift + small turn + scale about a pivot) for date line-ups.

About pivot P in the project CRS, with ``a = scale*cos(rot)`` and ``b = scale*sin(rot)``
(counter-clockwise, east towards north)::

    E' = Pe + a(E-Pe) - b(N-Pn) + eastM
    N' = Pn + b(E-Pe) + a(N-Pn) + northM

Heights are never changed. The local frame is ``x = E - origin[0]``, ``z = origin[1] - N``.
"""

from __future__ import annotations

import math
from collections.abc import Sequence
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:  # pragma: no cover
    import rasterio

_SHIFT_EPS = 0.0005
_ROT_EPS = 1e-6
_SCALE_EPS = 1e-7


@dataclass(frozen=True)
class Similarity:
    east_m: float
    north_m: float
    rotation_deg: float = 0.0
    scale: float = 1.0
    pivot_e: float = 0.0
    pivot_n: float = 0.0

    def _ab(self) -> tuple[float, float]:
        r = math.radians(self.rotation_deg)
        return self.scale * math.cos(r), self.scale * math.sin(r)

    def has_turn(self) -> bool:
        return abs(self.rotation_deg) > _ROT_EPS or abs(self.scale - 1.0) > _SCALE_EPS

    def is_identity(self) -> bool:
        return abs(self.east_m) <= _SHIFT_EPS and abs(self.north_m) <= _SHIFT_EPS and not self.has_turn()

    def apply_en(self, e: Any, n: Any) -> tuple[Any, Any]:
        a, b = self._ab()
        de = e - self.pivot_e
        dn = n - self.pivot_n
        return (
            self.pivot_e + a * de - b * dn + self.east_m,
            self.pivot_n + b * de + a * dn + self.north_m,
        )

    def apply_local(self, x: Any, z: Any, origin: Sequence[float]) -> tuple[Any, Any]:
        a, b = self._ab()
        px = self.pivot_e - origin[0]
        pz = origin[1] - self.pivot_n
        dx = x - px
        dz = z - pz
        return (
            px + a * dx + b * dz + self.east_m,
            pz - b * dx + a * dz - self.north_m,
        )

    def inverse(self) -> Similarity:
        return Similarity(
            -self.east_m,
            -self.north_m,
            -self.rotation_deg,
            1.0 / self.scale,
            self.pivot_e + self.east_m,
            self.pivot_n + self.north_m,
        )

    def then(self, other: Similarity) -> Similarity:
        """``other`` applied after ``self``, kept about ``other``'s pivot."""
        pe, pn = other.pivot_e, other.pivot_n
        e, n = other.apply_en(*self.apply_en(pe, pn))
        return Similarity(
            e - pe,
            n - pn,
            self.rotation_deg + other.rotation_deg,
            self.scale * other.scale,
            pe,
            pn,
        )

    def crs_affine(self) -> rasterio.Affine:
        """Affine mapping stored CRS coordinates to placed CRS coordinates."""
        from rasterio import Affine

        a, b = self._ab()
        c = self.pivot_e - a * self.pivot_e + b * self.pivot_n + self.east_m
        d = self.pivot_n - b * self.pivot_e - a * self.pivot_n + self.north_m
        return Affine(a, -b, c, b, a, d)

    def mat4_local(self, origin: Sequence[float]) -> list[float]:
        """Column-major 4x4 to premultiply a local transform (y untouched)."""
        a, b = self._ab()
        px = self.pivot_e - origin[0]
        pz = origin[1] - self.pivot_n
        tx = px - a * px - b * pz + self.east_m
        tz = pz + b * px - a * pz - self.north_m
        return [
            a, 0.0, 0.0 - b, 0.0,
            0.0, 1.0, 0.0, 0.0,
            b, 0.0, a, 0.0,
            tx, 0.0, tz, 1.0,
        ]  # fmt: skip

    def max_move(self, box_en: tuple[float, float, float, float]) -> float:
        """Largest horizontal move over the 4 corners of (minE, minN, maxE, maxN)."""
        e0, n0, e1, n1 = box_en
        worst = 0.0
        for e, n in ((e0, n0), (e0, n1), (e1, n0), (e1, n1)):
            e2, n2 = self.apply_en(e, n)
            worst = max(worst, math.hypot(e2 - e, n2 - n))
        return worst

    def to_turn(self) -> dict | None:
        if not self.has_turn():
            return None
        return {
            "rotationDeg": self.rotation_deg,
            "scale": self.scale,
            "pivotE": self.pivot_e,
            "pivotN": self.pivot_n,
        }

    @staticmethod
    def from_line_up(line_up: dict | None, turn: dict | None) -> Similarity:
        lu = line_up or {}
        t = turn or {}
        return Similarity(
            float(lu.get("eastM", 0.0)),
            float(lu.get("northM", 0.0)),
            float(t.get("rotationDeg", 0.0)),
            float(t.get("scale", 1.0)),
            float(t.get("pivotE", 0.0)),
            float(t.get("pivotN", 0.0)),
        )
