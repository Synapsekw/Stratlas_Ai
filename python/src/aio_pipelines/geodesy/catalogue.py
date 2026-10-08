"""The EPSG catalogue for the CRS search (M11 G1, data-conventions section 25, ADR 0010).

``python -m aio_pipelines.geodesy.catalogue --out <file.json>`` reads PROJ's ``proj.db`` (through
pyproj) and writes one row per EPSG projected, geographic, vertical and compound CRS with the
fields of ``CrsCatalogueEntry`` (``packages/schema/src/geodesy.ts``). For each projected CRS it also
writes a proj4 candidate and 25 sample points (a 5 by 5 grid over the area of use) projected by
PROJ from the CRS's own geographic CRS, so ``tools/geo/build-crs-catalogue.mjs`` can keep the proj4
string only where proj4js reproduces PROJ within 1 mm. The build tool strips the samples and writes
``packages/geo/src/catalogue/epsg.json.gz``.
"""

from __future__ import annotations

import argparse
import json
import math
import sys
import warnings
from pathlib import Path
from typing import Any

#: CRS kinds of the catalogue and the PROJ types behind them.
KINDS = {
    "PROJECTED_CRS": "projected",
    "GEOGRAPHIC_2D_CRS": "geographic",
    "GEOGRAPHIC_3D_CRS": "geographic",
    "VERTICAL_CRS": "vertical",
    "COMPOUND_CRS": "compound",
}
#: Sample grid per axis over the area of use (5 by 5 = 25 points).
SAMPLES = 5


def _r(v: float, nd: int = 4) -> float:
    return round(float(v), nd)


def _unit(crs: Any) -> str:
    try:
        axes = crs.axis_info
        if axes:
            return str(axes[0].unit_name)
    except Exception:
        pass
    return "unknown"


def _datum(crs: Any) -> str | None:
    try:
        if crs.is_compound:
            names = [d.name for d in (s.datum for s in crs.sub_crs_list) if d is not None]
            return " + ".join(names) or None
        d = crs.datum
        return str(d.name) if d is not None else None
    except Exception:
        return None


def _samples(bbox: tuple[float, float, float, float]) -> list[tuple[float, float]]:
    """A 5 by 5 grid of longitudes and latitudes inside the area of use (5 % inset)."""
    w, s, e, n = bbox
    if e < w:  # crosses the antimeridian
        e += 360.0
    dx, dy = (e - w) * 0.05, (n - s) * 0.05
    w, e, s, n = w + dx, e - dx, s + dy, n - dy
    out: list[tuple[float, float]] = []
    for i in range(SAMPLES):
        for j in range(SAMPLES):
            lon = w + (e - w) * i / (SAMPLES - 1)
            lat = s + (n - s) * j / (SAMPLES - 1)
            out.append((((lon + 180.0) % 360.0) - 180.0, lat))
    return out


def _proj4_candidate(crs: Any, bbox: tuple[float, float, float, float] | None) -> dict[str, Any] | None:
    """The proj4 strings and the PROJ-projected samples a proj4js check needs, or None."""
    from pyproj import Transformer

    if bbox is None:
        return None
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            proj4 = crs.to_proj4()
            geog = crs.geodetic_crs
            geog4 = geog.to_proj4() if geog is not None else None
        if not proj4 or not geog4 or "+proj=" not in proj4:
            return None
        if "+nadgrids" in proj4 or "+geoidgrids" in proj4:
            return None
        tr = Transformer.from_crs(geog, crs, always_xy=True)
        pts = _samples(bbox)
        xs, ys = tr.transform([p[0] for p in pts], [p[1] for p in pts], errcheck=False)
        samples = []
        for (lon, lat), x, y in zip(pts, xs, ys, strict=True):
            if not (math.isfinite(x) and math.isfinite(y)):
                return None
            samples.append([lon, lat, float(x), float(y)])
        factor = crs.axis_info[0].unit_conversion_factor if crs.axis_info else 1.0
        return {"proj4": proj4, "geog4": geog4, "toMetre": float(factor), "samples": samples}
    except Exception:
        return None


def build_catalogue() -> list[dict[str, Any]]:
    """Every EPSG CRS of the catalogue kinds, sorted by code (projected ones with proj4 checks)."""
    from pyproj import CRS
    from pyproj.database import query_crs_info
    from pyproj.enums import PJType

    rows: list[dict[str, Any]] = []
    for type_name, kind in KINDS.items():
        infos = query_crs_info(auth_name="EPSG", pj_types=[PJType[type_name]], allow_deprecated=True)
        for info in infos:
            code = int(info.code)
            row: dict[str, Any] = {
                "code": code,
                "name": info.name[:300],
                "kind": kind,
                "deprecated": bool(info.deprecated),
            }
            bbox: tuple[float, float, float, float] | None = None
            area = info.area_of_use
            if area is not None:
                bbox = (area.west, area.south, area.east, area.north)
                row["area"] = (area.name or "")[:500]
                row["bbox"] = [_r(v) for v in bbox]
            try:
                crs = CRS.from_epsg(code)
            except Exception:
                continue
            row["unit"] = _unit(crs)[:80]
            datum = _datum(crs)
            if datum:
                row["datum"] = datum[:200]
            if kind == "projected" and not info.deprecated:
                cand = _proj4_candidate(crs, bbox)
                if cand is not None:
                    row["_check"] = cand
            rows.append(row)
    rows.sort(key=lambda r: (r["code"], r["kind"]))
    # a code is one CRS: keep the first row of each
    seen: set[int] = set()
    out = []
    for r in rows:
        if r["code"] in seen:
            continue
        seen.add(r["code"])
        out.append(r)
    return out


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--out", required=True, help="JSON file to write (rows with proj4 check samples)")
    args = ap.parse_args(argv)
    import pyproj

    rows = build_catalogue()
    meta = {"proj": pyproj.proj_version_str, "pyproj": pyproj.__version__, "rows": rows}
    Path(args.out).write_text(json.dumps(meta, separators=(",", ":")), encoding="utf-8", newline="")
    print(f"{len(rows)} CRSs from PROJ {pyproj.proj_version_str}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
