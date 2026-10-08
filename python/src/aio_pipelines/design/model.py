"""What a design file holds once read: surfaces, linework, points and alignments, in file units.

The readers (``landxml.py``, ``dxf.py``, ``twelve_da.py``, ``csv_points.py``) return a ``Design``
with coordinates as (E, N, Z) in the file's own length unit and CRS. ``importer.py`` scales them to
metres, places them in the project CRS and writes the normalised layers (data-conventions
section 28).

Limits (``DESIGN_LIMITS`` in ``@aio/schema`` ``designs.ts``) and the hostile-input caps live here, so
every reader refuses the same way: a ``JobError`` naming the file and the line or entity.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import numpy as np

from ..runtime import JobError

#: ``DESIGN_LIMITS`` of ``@aio/schema``
MAX_TRIANGLES = 2_000_000
MAX_FILE_BYTES = 500 * 1024 * 1024
#: Caps against unbounded allocation from hostile files (not contract limits).
MAX_VERTICES = 4_000_000
MAX_POINTS = 2_000_000
MAX_LINE_VERTICES = 4_000_000
MAX_ENTITIES = 4_000_000
MAX_ALIGNMENT_ELEMENTS = 10_000
MAX_EQUATIONS = 100
MAX_LAYERS = 1000

#: Length units of ``DesignSourceUnits`` to metres (the US survey foot is exactly 1200/3937 m).
UNIT_M: dict[str, float] = {
    "m": 1.0,
    "mm": 0.001,
    "cm": 0.01,
    "ft": 0.3048,
    "us-ft": 1200 / 3937,
    "in": 0.0254,
}

#: Chain kinds in a ``.tin`` file (``chainsAt``): breaklines and boundaries.
CHAIN_BREAKLINE = 0
CHAIN_OUTER = 1
CHAIN_VOID = 2
CHAIN_OTHER_BOUNDARY = 3


@dataclass
class Surface:
    name: str
    #: (n, 3) float64, E N Z
    vertices: np.ndarray
    #: (m, 3) uint32 vertex indices
    triangles: np.ndarray
    #: (kind, (k, 3) float64 E N Z) breaklines and boundaries, matched to vertices when written
    chains: list[tuple[int, np.ndarray]] = field(default_factory=list)


@dataclass
class Line:
    #: (k, 3) float64 E N Z
    coords: np.ndarray
    closed: bool = False
    name: str | None = None
    #: breakline, boundary or line
    role: str = "line"


@dataclass
class Linework:
    name: str
    lines: list[Line] = field(default_factory=list)


@dataclass
class Point:
    id: str
    e: float
    n: float
    z: float
    code: str | None = None


@dataclass
class Points:
    name: str
    points: list[Point] = field(default_factory=list)


@dataclass
class AlignmentSource:
    """A horizontal alignment as ``aio.alignment/1`` elements, in file units (scaled on import)."""

    name: str
    start_station: float
    elements: list[dict[str, Any]]
    equations: list[dict[str, float]] = field(default_factory=list)


@dataclass
class Design:
    format: str
    #: the file's length unit when it states one (``INSUNITS``, LandXML ``Units``)
    units: str | None = None
    #: a CRS the file states (LandXML ``CoordinateSystem epsgCode``)
    crs: dict[str, Any] | None = None
    surfaces: list[Surface] = field(default_factory=list)
    linework: list[Linework] = field(default_factory=list)
    points: list[Points] = field(default_factory=list)
    alignments: list[AlignmentSource] = field(default_factory=list)
    #: source layer names, for the ``layers`` filter and its refusal
    source_layers: list[str] = field(default_factory=list)
    #: entities counted but not imported, by type
    skipped: dict[str, int] = field(default_factory=dict)

    def empty(self) -> bool:
        return not (self.surfaces or self.linework or self.points or self.alignments)


def refuse(path: Path, where: str | None, why: str) -> JobError:
    """A refusal that names the file and the line or entity: ``"x.dxf" line 12: ...``."""
    at = f" {where}" if where else ""
    return JobError(f'"{path.name}"{at}: {why}')


def check_size(path: Path) -> int:
    size = path.stat().st_size
    if size > MAX_FILE_BYTES:
        raise refuse(
            path,
            None,
            f"the file is {size / 1024 / 1024:,.0f} MB, above the limit of 500 MB for one design file. "
            "Split the design or thin the surface and import again.",
        )
    return size


def check_triangles(path: Path, name: str, count: int, where: str | None = None) -> None:
    if count > MAX_TRIANGLES:
        raise refuse(
            path,
            where,
            f'the surface "{name}" has more than {MAX_TRIANGLES:,} triangles, the limit for one '
            "surface layer. Thin the surface or split it and import again.",
        )


def triangulate_polygon(n: int, base: int = 0) -> list[tuple[int, int, int]]:
    """A fan over a convex polygon's corners ``base .. base + n - 1``."""
    return [(base, base + i, base + i + 1) for i in range(1, n - 1)]
