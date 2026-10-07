"""road.build: a road survey from raw inputs, ready for the road workspace.

Orthomosaic GeoTIFF(s) to a kit pyramid, the centreline with chainage, defect polygons to issues
with close-ups, ASTM D6433 sample units with deducts and PCI under the Low, Medium and High
severity assumptions, density grids and 250 m sections: ``road.json`` (``aio.road/1``,
data-conventions section 9), ``road/centreline.geojson``, ``road/pci-units.geojson``,
``issues.json`` and the layers in ``manifest.json``.

Issues are merged by id as the Ring Road importer does: an issue the builder wrote replaces the
saved one only while nobody changed it; issues people added, and builder issues someone edited,
are always kept. ``manifest.json`` and ``issues.json`` keep a ``.bak`` of the previous file.
"""

from __future__ import annotations

import json
import shutil
from pathlib import Path
from typing import Any

from ..params import known_keys, number, numbers, text
from ..runtime import (
    JobError,
    Step,
    StepContext,
    atomic_write_json,
    commit_files,
    commit_tree,
    now_iso,
    safe_project_path,
)
from . import catalogue as cat
from .pci import RATINGS, SEVERITIES, weighted

KEYS = {
    "centreline",
    "centrelineEpsg",
    "ortho",
    "orthoCm",
    "defects",
    "defectsEpsg",
    "pavement",
    "units",
    "unitLength",
    "lanes",
    "laneWidth",
    "gridOrigin",
    "closeups",
    "name",
}
ASTM_UNIT_M2 = 225.0
SHP_SIDECARS = (".dbf", ".shx", ".prj", ".cpg")
ORTHO_LAYER = "ortho"
CLOSEUPS_LAYER = "closeups"
OVERLAYS = {"centreline": "road/centreline.geojson", "pciUnits": "road/pci-units.geojson"}


def _paths(v: Any, key: str) -> list[str]:
    if v is None:
        return []
    items = [v] if isinstance(v, str) else v
    if not isinstance(items, list) or not items or not all(isinstance(x, str) and x.strip() for x in items):
        raise JobError(f"{key} must be a file path or a list of file paths.")
    return list(items)


class RoadBuild:
    name = "road.build"
    title = "Road survey"
    description = (
        "Ortho tiles, chainage from the centreline, defect polygons, ASTM D6433 sample units, "
        "deducts and PCI, opened in the road workspace."
    )

    # ------------------------------------------------------------------ params

    def validate(self, params: dict[str, Any]) -> dict[str, Any]:
        known_keys(params, KEYS, self.name)
        out: dict[str, Any] = {"centreline": text(params, "centreline", required=True)}
        orthos = _paths(params.get("ortho"), "ortho")
        if orthos:
            for p in orthos:
                if Path(p).suffix.lower() not in (".tif", ".tiff", ".vrt"):
                    raise JobError(f"The orthomosaic {Path(p).name} must be a GeoTIFF.")
            out["ortho"] = orthos
        for k in ("defects", "pavement", "name"):
            v = text(params, k)
            if v is not None:
                out[k] = v
        for k in ("centrelineEpsg", "defectsEpsg"):
            v = number(params, k, None, 1024, 999999, integer=True)
            if v is not None:
                out[k] = v
        units = params.get("units", "chainage")
        if units not in ("chainage", "grid"):
            raise JobError("units must be chainage (along the road) or grid (square cells).")
        out["units"] = units
        out["lanes"] = number(params, "lanes", 2, 1, 12, integer=True)
        out["laneWidth"] = number(params, "laneWidth", 3.65, 2.0, 6.0)
        width = out["lanes"] * out["laneWidth"]
        default_len = 15.0 if units == "grid" else max(5.0, round(ASTM_UNIT_M2 / width))
        out["unitLength"] = number(params, "unitLength", default_len, 5.0, 200.0)
        cm = number(params, "orthoCm", None, 0.5, 100.0)
        if cm is not None:
            out["orthoCm"] = cm
        go = numbers(params, "gridOrigin", 2)
        if go is not None:
            out["gridOrigin"] = go
        closeups = params.get("closeups", True)
        if not isinstance(closeups, bool):
            raise JobError("closeups must be true or false.")
        out["closeups"] = closeups
        return out

    def inputs(self, params: dict[str, Any]) -> list[str]:
        files = [params["centreline"], *params.get("ortho", [])]
        for k in ("defects", "pavement"):
            if k in params:
                files.append(params[k])
        d = params.get("defects")
        if d and Path(d).suffix.lower() == ".shp":
            files += [str(Path(d).with_suffix(s)) for s in SHP_SIDECARS if Path(d).with_suffix(s).exists()]
        return files

    # ------------------------------------------------------------------ shared reads

    def _manifest(self, ctx: StepContext) -> dict[str, Any]:
        p = safe_project_path(ctx.project, "manifest.json")
        try:
            return json.loads(p.read_text("utf-8"))
        except (OSError, json.JSONDecodeError) as e:
            raise JobError(f"The project manifest could not be read: {e}") from e

    def _load(self, ctx: StepContext) -> dict[str, Any]:
        """Centreline and defects in the project CRS (read once per run)."""
        cache = getattr(ctx.job, "_road_inputs", None)
        if cache is not None:
            return cache
        from .sources import project_crs, read_centreline, read_defects

        m = self._manifest(ctx)
        crs = project_crs(m)
        cl = read_centreline(ctx.input(ctx.params["centreline"]), crs, ctx.params.get("centrelineEpsg"))
        defects: list[Any] = []
        warnings = list(cl.warnings)
        if "defects" in ctx.params:
            defects, w = read_defects(ctx.input(ctx.params["defects"]), crs, ctx.params.get("defectsEpsg"))
            warnings += w
        cache = {"manifest": m, "crs": crs, "centreline": cl, "defects": defects, "warnings": warnings}
        ctx.job._road_inputs = cache  # type: ignore[attr-defined]
        return cache

    # ------------------------------------------------------------------ steps

    def plan(self, params: dict[str, Any]) -> list[Step]:
        def read(ctx: StepContext) -> dict[str, Any]:
            data = self._load(ctx)
            cl = data["centreline"]
            for w in data["warnings"][:20]:
                ctx.log(w, "warn")
            if len(data["warnings"]) > 20:
                ctx.log(f"... and {len(data['warnings']) - 20} more warnings like these.", "warn")
            by: dict[str, int] = {}
            for d in data["defects"]:
                by[d.cls.label] = by.get(d.cls.label, 0) + 1
            ctx.log(
                f"Centreline {cl.length_km:.3f} km ({len(cl.xy)} vertices"
                + (", chainage from the file" if cl.given else "")
                + f"); {len(data['defects'])} defects"
                + (
                    ": " + ", ".join(f"{n} {k}" for k, n in sorted(by.items(), key=lambda x: -x[1]))
                    if by
                    else ""
                )
            )
            unknown = sorted({d.type_name for d in data["defects"] if d.cls.distress is None})
            if unknown:
                ctx.log(f"Not counted in PCI (no ASTM D6433 curve): {', '.join(unknown)}.", "warn")
            no_stage = sum(1 for d in data["defects"] if d.stage is None)
            if no_stage:
                ctx.log(f"{no_stage} defects have no stage; their issues are graded Low.", "warn")
            return {"lengthKm": round(cl.length_km, 3), "defects": len(data["defects"])}

        def ortho(ctx: StepContext) -> dict[str, Any]:
            if "ortho" not in params:
                ctx.log("No orthomosaic given; the project keeps its rasters.")
                return {"skipped": True}
            from .ortho import build_pyramid, open_sources, plan_pyramid, stamp

            data = self._load(ctx)
            srcs = open_sources([str(ctx.input(p)) for p in params["ortho"]], data["crs"])
            try:
                cm = params.get("orthoCm")
                plan = plan_pyramid(srcs, cm / 100 if cm else None)
                st = stamp([s.path for s in srcs], plan)
                current = ctx.out("rasters/ortho/tiles.json")
                if current.exists():
                    try:
                        if json.loads(current.read_text("utf-8")).get("stamp") == st:
                            ctx.log("The project already has this orthomosaic tiled; kept.")
                            return {"reused": True, "stamp": st}
                    except (OSError, json.JSONDecodeError):
                        pass
                res = build_pyramid(
                    srcs,
                    plan,
                    ctx.stage("rasters/ortho"),
                    ctx.check,
                    ctx.progress,
                    ctx.log,
                )
                from .ortho import tiles_json

                epsg = (data["manifest"].get("crs") or {}).get("epsg")
                names = ", ".join(Path(s.path).name for s in srcs)
                atomic_write_json(
                    ctx.stage("rasters/ortho/tiles.json"),
                    tiles_json(plan, data["manifest"]["origin"], epsg, names, st),
                )
                ctx.log(f"Ortho: {res['tiles']} tiles, {res['blank']} blank slots filled.")
                return {
                    "stamp": st,
                    "res": plan.res,
                    "levels": plan.levels,
                    "tiles": res["tiles"],
                }
            finally:
                for s in srcs:
                    s.close()

        def closeups(ctx: StepContext) -> dict[str, Any]:
            data = self._load(ctx)
            if "ortho" not in params or not params.get("closeups", True) or not data["defects"]:
                return {"skipped": True}
            from .ortho import closeup, closeup_box, image_polygon, open_sources, save_webp

            srcs = open_sources([str(ctx.input(p)) for p in params["ortho"]], data["crs"])
            index_path = ctx.stage("work/closeups.json")
            index: dict[str, Any] = json.loads(index_path.read_text("utf-8")) if index_path.exists() else {}
            try:
                native = min(min(abs(s.ds.res[0]), abs(s.ds.res[1])) for s in srcs)
                n = len(data["defects"])
                for k, d in enumerate(data["defects"]):
                    ctx.check()
                    pid = photo_id(d.fid)
                    if pid in index:
                        continue
                    box = closeup_box(d.geom)
                    im = closeup(srcs, box, native)
                    if im is not None:
                        save_webp(im, ctx.stage(f"photos/closeups/{pid}.webp"), quality=78)
                        index[pid] = {
                            "width": im.width,
                            "height": im.height,
                            "polygon": image_polygon(d.geom, box, im.size),
                        }
                    else:
                        index[pid] = None
                    if k % 50 == 49:
                        atomic_write_json(index_path, index, indent=None)
                    ctx.progress((k + 1) / n, f"Close-ups {k + 1} of {n}")
            finally:
                for s in srcs:
                    s.close()
            atomic_write_json(index_path, index, indent=None)
            made = sum(1 for v in index.values() if v)
            if made < len(index):
                ctx.log(
                    f"{len(index) - made} defects lie outside the orthomosaic and have no close-up.", "warn"
                )
            return {"closeups": made}

        def pci(ctx: StepContext) -> dict[str, Any]:
            data = self._load(ctx)
            doc, overlays, units_out = build_road(ctx, data, params)
            atomic_write_json(ctx.stage("road.json"), doc, indent=None)
            atomic_write_json(ctx.stage(OVERLAYS["centreline"]), overlays["centreline"], indent=None)
            atomic_write_json(ctx.stage(OVERLAYS["pciUnits"]), overlays["pciUnits"], indent=None)
            closeups_index = {}
            ci = ctx.stage("work/closeups.json")
            if ci.exists():
                closeups_index = json.loads(ci.read_text("utf-8"))
            issues = build_issues(data, units_out, closeups_index, params)
            atomic_write_json(ctx.stage("work/issues.json"), issues, indent=None)
            net = doc["pci"]["network"]
            ctx.log(
                f"{len(doc['pci']['units'])} sample units ({doc['pci'].get('layout', 'grid')}), "
                f"network PCI {net['low']} / {net['medium']} / {net['high']} (Low / Medium / High severity assumed), "
                f"{doc['pci'].get('coveragePct', 0)} % of the pavement in units."
            )
            return {"units": len(doc["pci"]["units"]), "network": net, "issues": len(issues)}

        def commit(ctx: StepContext) -> dict[str, Any]:
            data = self._load(ctx)
            built_ortho = (
                "ortho" in params
                and not ctx.outputs("ortho").get("reused")
                and not ctx.outputs("ortho").get("skipped")
            )
            if built_ortho:
                old = ctx.out("rasters/ortho")
                staged = ctx.staging / "rasters" / "ortho"
                if old.exists() and staged.exists():
                    # an earlier ortho of this project: kept in the job folder, never mixed in
                    keep = ctx.job.dir / "replaced" / "rasters-ortho"
                    if keep.exists():
                        shutil.rmtree(keep)
                    keep.parent.mkdir(parents=True, exist_ok=True)
                    shutil.move(str(old), str(keep))
                    ctx.log("The previous ortho tiles were moved to the job folder (replaced/).")
                commit_tree(ctx, "rasters/ortho", "rasters/ortho")
            commit_tree(ctx, "photos/closeups", "photos/closeups")
            commit_files(
                ctx,
                [
                    (OVERLAYS["centreline"], OVERLAYS["centreline"]),
                    (OVERLAYS["pciUnits"], OVERLAYS["pciUnits"]),
                ],
            )
            # issues before road.json and the manifest: the app finds the road last
            issues = json.loads(ctx.stage("work/issues.json").read_text("utf-8"))
            kept = merge_issues(ctx, issues)
            if kept:
                ctx.log(f"{kept} issues added or edited in the app were kept.")
            commit_files(ctx, [("road.json", "road.json")])
            update_manifest(ctx, data, params)
            write_thumbnail(ctx)
            return {"issuesKept": kept}

        return [
            Step("read", "Read the centreline and defects", read, weight=1),
            Step("ortho", "Tile the orthomosaic", ortho, weight=12),
            Step("closeups", "Cut defect close-ups", closeups, weight=3),
            Step("pci", "Sample units, deducts and PCI", pci, weight=3),
            Step("commit", "Write to the project", commit, weight=0.5),
        ]


# ---------------------------------------------------------------------- road model


def photo_id(fid: int) -> str:
    return f"f{fid:04d}"


def defect_code(fid: int) -> str:
    """D0000 to D9999, then E0000 ... (issue codes are a letter and up to four digits)."""
    return f"{chr(ord('D') + fid // 10000)}{fid % 10000:04d}"


def build_road(ctx: StepContext, data: dict[str, Any], params: dict[str, Any]):
    """road.json, the two overlays and the units (with their polygons for the issues)."""
    from shapely.geometry import LineString

    from .units import (
        MaskFootprint,
        PolygonFootprint,
        chainage_units,
        density_grids,
        grid_units,
        sections,
    )

    m = data["manifest"]
    cl = data["centreline"]
    defects = data["defects"]
    width = params["lanes"] * params["laneWidth"]
    if "pavement" in params:
        fp: Any = MaskFootprint(str(ctx.input(params["pavement"])), data["crs"])
        if "gridOrigin" in params:
            ctx.log(
                "A pavement raster sets the grid origin (its top-left corner); gridOrigin is ignored.", "warn"
            )
    else:
        fp = PolygonFootprint(LineString(cl.xy).buffer(width / 2, cap_style="flat"))
        if "gridOrigin" in params:
            fp.origin = (params["gridOrigin"][0], params["gridOrigin"][1])

    def step_progress(lo: float, hi: float):
        return lambda f, msg=None: ctx.progress(lo + (hi - lo) * f, msg)

    try:
        if isinstance(fp, MaskFootprint):
            ctx.progress(0, "Reading the pavement raster")
            sizes = [10.0, 20.0, 50.0] + ([params["unitLength"]] if params["units"] == "grid" else [])
            fp.prepare(sizes, ctx.check, step_progress(0, 0.3))
        if params["units"] == "grid":
            res = grid_units(fp, defects, cl, params["unitLength"], ctx.check, step_progress(0.3, 0.6))
        else:
            res = chainage_units(
                fp, defects, cl, params["unitLength"], width, ctx.check, step_progress(0, 0.6)
            )
        ctx.progress(0.6, "Density grids")
        dens = density_grids(fp, defects, ctx.check)
    finally:
        fp.close()
    ctx.progress(0.9, "Road model")
    units = res["units"]
    origin = m["origin"]
    ox, oy = fp.origin
    res["originEN"] = fp.origin

    def local(e: float, n: float) -> list[float]:
        return [round(e - origin[0], 3), 0, round(-(n - origin[1]), 3)]

    network = {k: weighted(units, i) for i, k in enumerate(SEVERITIES)}
    secs = sections(units, cl.length_km)
    doc = {
        "schema": "aio.road/1",
        "name": params.get("name") or m.get("name") or "Road",
        "centreline": {
            "points": [local(float(e), float(n)) for e, n in cl.xy],
            "chainageKm": [round(float(v), 4) for v in cl.ch],
            "lengthKm": round(cl.length_km, 4),
        },
        "pci": {
            "standard": "ASTM D6433",
            "severities": ["Low", "Medium", "High"],
            "headline": "medium",
            "network": network,
            "coveragePct": res["coveragePct"],
            "ratings": RATINGS,
            "grid": {"cellM": res["unitM"], "origin": local(ox, oy)},
            "layout": res["layout"],
            "sections": [
                {
                    "fromKm": s[0],
                    "toKm": round(s[0] + 0.25, 3),
                    "pavementM2": s[1],
                    "pci": {"low": s[2], "medium": s[3], "high": s[4]},
                }
                for s in secs
            ],
            "units": [
                {
                    "id": u["id"],
                    "pavementM2": u["pavementM2"],
                    "pci": {"low": u["pci"][0], "medium": u["pci"][1], "high": u["pci"][2]},
                    "km": u["km"],
                    **({"fromKm": u["fromKm"], "toKm": u["toKm"]} if "fromKm" in u else {}),
                    "deducts": [{"distress": d[0], "densityPct": d[1], "deduct": d[2]} for d in u["deducts"]],
                    "cells": u["cells"],
                }
                for u in units
            ],
        },
        "density": {
            "gridOrigin": local(ox, oy),
            "sizes": {
                size: [
                    {
                        "i": c[0],
                        "j": c[1],
                        "pavementM2": c[2],
                        "defects": c[3],
                        "defectM2": c[4],
                        "coverPct": c[5],
                    }
                    for c in cells
                ]
                for size, cells in dens.items()
            },
        },
        "overlays": OVERLAYS,
        "builder": {
            "pipeline": "road.build",
            "units": res["layout"],
            "unitM": res["unitM"],
            **({"widthM": res["widthM"]} if "widthM" in res else {}),
            "builtAt": now_iso(),
        },
    }
    overlays = {
        "centreline": centreline_geojson(cl, data["crs"]),
        "pciUnits": units_geojson(units, res, fp.origin, data["crs"]),
    }
    return doc, overlays, res


def _to_lonlat(crs, xs: list[float], ys: list[float]) -> list[list[float]]:
    from .sources import WGS84, to_crs

    lon, lat = to_crs(crs, _wgs(WGS84), xs, ys)
    return [[round(a, 7), round(b, 7)] for a, b in zip(lon, lat, strict=True)]


def _wgs(s: str):
    from rasterio.crs import CRS

    return CRS.from_string(s)


def centreline_geojson(cl: Any, crs: Any) -> dict[str, Any]:
    coords = _to_lonlat(crs, [float(v) for v in cl.xy[:, 0]], [float(v) for v in cl.xy[:, 1]])
    ticks = []
    km = 0.0
    last = cl.length_km
    first = float(cl.ch[0])
    km = round(first * 2 + 0.4999) / 2  # first half kilometre at or after the start
    pts = []
    while km <= last + 1e-9:
        # vertex at or after the tick, as the importer places them
        k = next((i for i, v in enumerate(cl.ch) if v >= km - 1e-9), len(cl.ch) - 1)
        pts.append((km, coords[k]))
        km = round(km + 0.5, 6)
    for k, at in pts:
        ticks.append(
            {
                "type": "Feature",
                "geometry": {"type": "Point", "coordinates": at},
                "properties": {"kind": "chainage", "km": round(k, 1), "label": f"km {k:.1f}"},
            }
        )
    return {
        "type": "FeatureCollection",
        "features": [
            {
                "type": "Feature",
                "geometry": {"type": "LineString", "coordinates": coords},
                "properties": {"kind": "centreline", "chainageKm": [round(float(v), 4) for v in cl.ch]},
            },
            *ticks,
        ],
    }


def units_geojson(units: list[dict[str, Any]], res: dict[str, Any], origin, crs) -> dict[str, Any]:
    """Unit outlines in lon/lat: grid cells as a MultiPolygon, chainage units as their polygon."""
    feats = []
    c = res["unitM"]
    ox, oy = origin
    for u in units:
        if u.get("_poly") is not None:
            polys = [u["_poly"]] if u["_poly"].geom_type == "Polygon" else list(u["_poly"].geoms)
            rings = []
            for p in polys:
                xs, ys = p.exterior.coords.xy
                rings.append([_to_lonlat(crs, list(xs), list(ys))])
            geom = {"type": "MultiPolygon", "coordinates": rings}
        else:
            rings = []
            for i, j in u["cells"]:
                e0, n0 = ox + j * c, oy - i * c
                rings.append([_to_lonlat(crs, [e0, e0 + c, e0 + c, e0, e0], [n0, n0, n0 - c, n0 - c, n0])])
            geom = {"type": "MultiPolygon", "coordinates": rings}
        feats.append(
            {
                "type": "Feature",
                "geometry": geom,
                "properties": {
                    "id": u["id"],
                    "pavementM2": u["pavementM2"],
                    "km": u["km"],
                    "pciLow": u["pci"][0],
                    "pciMedium": u["pci"][1],
                    "pciHigh": u["pci"][2],
                },
            }
        )
    return {"type": "FeatureCollection", "features": feats}


# ---------------------------------------------------------------------- issues


def _fmt(v: float, d: int) -> str:
    return f"{v:,.{d}f}"


def _unit_finder(res: dict[str, Any], origin):
    units = res["units"]
    if res["layout"] == "grid":
        c = res["unitM"]
        ox, oy = origin
        by = {}
        for u in units:
            for i, j in u["cells"]:
                by[(i, j)] = u
        return lambda e, n: by.get((int((oy - n) // c), int((e - ox) // c)))
    from shapely.geometry import Point

    def find(e, n):
        pt = Point(e, n)
        return next((u for u in units if u["_poly"].contains(pt)), None)

    return find


def build_issues(
    data: dict[str, Any], res: dict[str, Any], closeups: dict[str, Any], params: dict[str, Any]
) -> list[dict[str, Any]]:
    from shapely.geometry import mapping

    cl = data["centreline"]
    crs = data["crs"]
    m = data["manifest"]
    find = _unit_finder(res, res["originEN"])
    epsg = (m.get("crs") or {}).get("epsg")
    crs_name = f"EPSG:{epsg}" if epsg else "project CRS"
    author = f"Road builder ({Path(params['defects']).name})" if "defects" in params else "Road builder"
    at = now_iso()
    map_layer = (
        ORTHO_LAYER
        if "ortho" in params
        else next((lyr["id"] for lyr in m.get("layers", []) if lyr.get("kind") == "raster"), ORTHO_LAYER)
    )
    out = []
    for d in data["defects"]:
        c = d.geom.centroid
        km, off = cl.project(c.x, c.y)
        g = mapping(d.geom)
        if g["type"] == "Polygon":
            rings = [list(r) for r in g["coordinates"]]
            ll = [_to_lonlat(crs, [p[0] for p in r], [p[1] for p in r]) for r in rings]
            geojson = {"type": "Polygon", "coordinates": ll}
        else:
            geojson = {
                "type": "MultiPolygon",
                "coordinates": [
                    [_to_lonlat(crs, [p[0] for p in r], [p[1] for p in r]) for r in poly]
                    for poly in g["coordinates"]
                ],
            }
        sightings: list[dict[str, Any]] = [{"on": "map", "layer": map_layer, "geojson": geojson}]
        cu = closeups.get(photo_id(d.fid))
        if cu and len(cu["polygon"]) >= 3:
            sightings.append(
                {
                    "on": "image",
                    "layer": CLOSEUPS_LAYER,
                    "photo": photo_id(d.fid),
                    "geom": {"type": "polygon", "points": cu["polygon"]},
                }
            )
        sev = d.stage or 1
        sev_label = cat.SEVERITY_MODEL["levels"][sev - 1]["label"]
        unit = find(c.x, c.y)
        if unit:
            pci_txt = (
                f"PCI sample unit {unit['id']} ({_fmt(unit['pavementM2'], 0)} m² of pavement, km {unit['km']:.3f}): "
                f"PCI {_fmt(unit['pci'][0], 0)} Low, {_fmt(unit['pci'][1], 0)} Medium, {_fmt(unit['pci'][2], 0)} High severity assumption."
            )
        else:
            pci_txt = "The centroid lies outside the PCI sample units."
        stage_txt = (
            f"Stage: {cat.STAGE_LABEL[d.stage]} (graded {sev_label})."
            if d.stage
            else "No stage in the source; graded Low until reviewed."
        )
        pci_note = "" if d.cls.distress else " Not counted in PCI (no ASTM D6433 deduct curve for this type)."
        note = " ".join(
            [
                stage_txt,
                f"Mapped area {_fmt(d.area, 2)} m², extent {_fmt(d.extent, 1)} m, {_fmt(off, 1)} m from the centreline.",
                pci_txt + pci_note,
                f"{crs_name} {_fmt(c.x, 1)} E, {_fmt(c.y, 1)} N. Feature {d.fid} of the source file.",
            ]
        )
        out.append(
            {
                "id": f"rd-{d.fid:04d}",
                "code": defect_code(d.fid),
                "classId": d.cls.id,
                "severityModelId": cat.SEVERITY_MODEL_ID,
                "severity": sev,
                "status": "reviewed",
                "title": f"{d.cls.label} at km {km:.3f}",
                "note": note,
                "author": author,
                "createdAt": at,
                "updatedAt": at,
                "sightings": sightings,
                "measurements": [
                    {"kind": "area", "value": round(d.area, 4), "unit": "m2"},
                    {"kind": "distance", "value": round(d.extent, 3), "unit": "m"},
                ],
                "source": "import",
            }
        )
    return out


def _untouched_import(i: dict[str, Any]) -> bool:
    return i.get("source") == "import" and i.get("updatedAt") == i.get("createdAt")


def merge_issues(ctx: StepContext, built: list[dict[str, Any]]) -> int:
    """Write issues.json: built issues replace saved ones only while those are untouched imports;
    everything people added or edited is kept (``mergeImportedIssues`` of the importers)."""
    path = ctx.out("issues.json")
    saved: list[dict[str, Any]] = []
    # the document as read: keys this pipeline does not know are written back as they were
    doc: dict[str, Any] = {}
    if path.exists():
        try:
            raw = json.loads(path.read_text("utf-8"))
            doc = raw if isinstance(raw, dict) else {}
            saved = [i for i in doc.get("issues", []) if isinstance(i, dict) and isinstance(i.get("id"), str)]
        except (OSError, json.JSONDecodeError) as e:
            raise JobError(f"issues.json could not be read, so it is left as it is: {e}") from e
    by_id = {i["id"]: i for i in saved}
    out = []
    for i in built:
        s = by_id.get(i["id"])
        out.append(s if s is not None and not _untouched_import(s) else i)
    ids = {i["id"] for i in built}
    kept = 0
    for s in saved:
        if s["id"] not in ids and not _untouched_import(s):
            out.append(s)
            kept += 1
    kept += sum(1 for i in built if i["id"] in by_id and not _untouched_import(by_id[i["id"]]))
    if path.exists():
        shutil.copyfile(path, path.with_name("issues.json.bak"))
    atomic_write_json(path, {**doc, "schema": "aio.issues/1", "issues": out}, indent=None)
    ctx.artifact("issues.json")
    return kept


def update_manifest(ctx: StepContext, data: dict[str, Any], params: dict[str, Any]) -> None:
    """Road severity model and classes, the ortho and close-up layers; written last."""
    path = ctx.out("manifest.json")
    m = json.loads(path.read_text("utf-8"))
    models = m.setdefault("severityModels", [])
    if not any(x.get("id") == cat.SEVERITY_MODEL_ID for x in models):
        models.append(cat.SEVERITY_MODEL)
    extra = []
    seen = set()
    for d in data["defects"]:
        if d.cls.id not in seen:
            seen.add(d.cls.id)
            extra.append(d.cls)
    cats = m.setdefault("classCatalogues", [])
    road = next((c for c in cats if c.get("assetType") == "road"), None)
    if road is None:
        cats.append(cat.catalogue(extra))
    else:
        known = {c.get("id") for c in road.get("classes", [])}
        for c in extra:
            if c.id not in known:
                road.setdefault("classes", []).append(cat.catalogue_entry(c))
                known.add(c.id)
    layers = m.setdefault("layers", [])
    tiles = ctx.out("rasters/ortho/tiles.json")
    if "ortho" in params and tiles.exists():
        t = json.loads(tiles.read_text("utf-8"))
        cm = t.get("metresPerPx", [0])[-1] * 100
        layer = {
            "kind": "raster",
            "id": ORTHO_LAYER,
            "name": f"Orthomosaic ({cm:.2f} cm)",
            "visible": True,
            "src": {"path": "rasters/ortho/tiles.json"},
            "role": "ortho",
            "format": "kit-pyramid",
            "corners": t["corners"],
        }
        layers[:] = [lyr for lyr in layers if lyr.get("id") != ORTHO_LAYER] + [layer]
        layers.sort(key=lambda lyr: 0 if lyr.get("id") == ORTHO_LAYER else 1)
        # a downsampled preview of the same GeoTIFF imported earlier (raw import, one image):
        # kept, but hidden under the full-resolution pyramid
        stems = {Path(p).stem for p in params["ortho"]}
        for lyr in layers:
            if (
                lyr.get("kind") == "raster"
                and lyr.get("format") == "image"
                and lyr.get("name") in stems
                and lyr.get("visible", True)
            ):
                lyr["visible"] = False
                ctx.log(f'The preview layer "{lyr["name"]}" is hidden under the tiled orthomosaic.')
    ci = ctx.stage("work/closeups.json")
    if ci.exists():
        index = json.loads(ci.read_text("utf-8"))
        items = [
            {"id": pid, "src": {"path": f"photos/closeups/{pid}.webp"}}
            for pid, v in sorted(index.items())
            if v
        ]
        if items:
            layer = {
                "kind": "photos",
                "id": CLOSEUPS_LAYER,
                "name": "Defect close-ups",
                "visible": True,
                "items": items,
            }
            layers[:] = [lyr for lyr in layers if lyr.get("id") != CLOSEUPS_LAYER] + [layer]
    m.setdefault("type", "road")
    shutil.copyfile(path, path.with_name("manifest.json.bak"))
    atomic_write_json(path, m, indent=2)
    ctx.artifact("manifest.json")


def write_thumbnail(ctx: StepContext) -> None:
    """A library poster from the coarsest ortho level, unless the project has one already."""
    out = ctx.out("thumbnail.jpg")
    tiles = ctx.out("rasters/ortho/tiles.json")
    if out.exists() or not tiles.exists():
        return
    try:
        from PIL import Image

        t = json.loads(tiles.read_text("utf-8"))
        lv = min(t["levels"], key=lambda lv: lv["z"])
        size = lv["tileSize"]
        im = Image.new("RGB", (lv["cols"] * size, lv["rows"] * size), (20, 29, 45))
        for y in range(lv["rows"]):
            for x in range(lv["cols"]):
                f = ctx.out(
                    lv["pattern"].replace("{z}", str(lv["z"])).replace("{x}", str(x)).replace("{y}", str(y))
                )
                if f.exists():
                    with Image.open(f) as ti:
                        tile = ti.convert("RGBA")
                        if tile.size == (size, size):
                            im.paste(tile, (x * size, y * size), tile)
        im.thumbnail((1280, 1280))
        tmp = out.with_name(".thumbnail.jpg.tmp")
        im.save(tmp, "JPEG", quality=82)
        tmp.replace(out)
    except Exception as e:  # a poster is a nicety; never fail the job for it
        ctx.log(f"No library thumbnail: {e}", "warn")
