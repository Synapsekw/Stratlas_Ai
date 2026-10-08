"""design.import: LandXML, DXF, 12da or CSV designs to TIN surfaces, linework, alignments and points.

Parameters as ``DesignImportParams`` in ``@aio/schema`` ``jobs.ts``; files as data-conventions
section 28. Steps:

- ``read``: refuse what this import does not take (over 500 MB, DWG, binary DXF, TTM, hostile
  XML), read the file (``landxml.py``, ``dxf.py``, ``twelve_da.py``, ``csv_points.py``), settle the
  units (the file's own, else the ``units`` given), scale to metres, place the coordinates in the
  project CRS (from ``crs``, the CRS the file states, or the site calibration with
  ``useCalibration``) and stage the original byte for byte with one normalised file per layer;
- ``display``: a display GLB per surface layer, in the scene frame of section 1 (Y up, origin the
  manifest ``origin``), every face turned up;
- ``commit``: move the folder into ``survey/designs/<id>/`` and append the ``DesignEntry`` to
  ``survey/designs.json`` (atomic, with ``designs.json.bak``).
"""

from __future__ import annotations

import hashlib
import importlib
import io
import json
import math
import re
import shutil
from collections.abc import Callable
from pathlib import Path
from typing import Any

import numpy as np

from ..params import known_keys
from ..runtime import JobError, Step, StepContext, atomic_write_bytes, atomic_write_json, commit_tree, now_iso
from .alignment import bearing, check_continuity, element_point, regions
from .model import (
    CHAIN_BREAKLINE,
    UNIT_M,
    AlignmentSource,
    Design,
    Surface,
    check_size,
    check_triangles,
)
from .tin_io import chain_indices, encode_tin, read_tin

DESIGNS_FILE = "survey/designs.json"
DESIGNS_DIR = "survey/designs"
DESIGNS_SCHEMA = "aio.designs/1"
ALIGNMENT_SCHEMA = "aio.alignment/1"
POINTS_SCHEMA = "aio.design-points/1"
FORMATS = ("landxml", "dxf", "12da", "csv", "ttm")
UNITS = tuple(UNIT_M)
DESIGN_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$")
DESIGN_FILE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9 ._()-]{0,199}$")
EXTENSIONS = {
    ".xml": "landxml",
    ".landxml": "landxml",
    ".dxf": "dxf",
    ".12da": "12da",
    ".csv": "csv",
    ".txt": "csv",
    ".pnezd": "csv",
    ".ttm": "ttm",
}

Transform = Callable[[np.ndarray], np.ndarray]


def slug(name: str, fallback: str = "design") -> str:
    s = re.sub(r"[^A-Za-z0-9._-]+", "-", name).strip("-._")[:80]
    return s if s and s[0].isalnum() else fallback


def safe_file_name(name: str) -> str:
    s = re.sub(r"[^A-Za-z0-9 ._()-]+", "_", name)[:200]
    return s if s and s[0].isalnum() else f"design{s}"[:200]


def detect_format(path: Path) -> str:
    with open(path, "rb") as f:
        head = f.read(512)
    if head.startswith(b"AutoCAD Binary DXF"):
        return "dxf"  # refused by the reader with its message
    if head[:4] == b"AC10":
        raise JobError(f'"{path.name}" is a DWG drawing. Save it as an ASCII DXF and import again.')
    text = head.lstrip(b"\xef\xbb\xbf").lstrip()
    if text.startswith(b"<?xml") or b"<LandXML" in head:
        return "landxml"
    by_ext = EXTENSIONS.get(path.suffix.lower())
    if by_ext:
        return by_ext
    if path.suffix.lower() == ".dwg":
        raise JobError(f'"{path.name}" is a DWG drawing. Save it as an ASCII DXF and import again.')
    raise JobError(
        f'"{path.name}" is not a design this import reads (LandXML .xml, DXF, 12da or CSV points). '
        "Choose the format and import again."
    )


def read_design(path: Path, fmt: str) -> Design:
    if fmt == "ttm":
        raise JobError(
            f'"{path.name}" is a Trimble TIN (TTM), which this import cannot read: there is no published '
            "specification. Export the surface as LandXML from Trimble Business Center and import that."
        )
    if fmt == "landxml":
        from .landxml import read_landxml

        return read_landxml(path)
    if fmt == "dxf":
        from .dxf import read_dxf

        return read_dxf(path)
    if fmt == "12da":
        from .twelve_da import read_12da

        return read_12da(path)
    from .csv_points import read_csv_points

    return read_csv_points(path)


def _manifest(project: Path) -> dict[str, Any] | None:
    p = project / "manifest.json"
    if not p.exists():
        return None
    try:
        m = json.loads(p.read_text("utf-8"))
    except (OSError, ValueError) as e:
        raise JobError(f"Could not read the project manifest {p}: {e}") from e
    return m if isinstance(m, dict) else None


def read_designs(project: Path) -> dict[str, Any]:
    p = project / DESIGNS_FILE
    if not p.exists():
        return {"schema": DESIGNS_SCHEMA, "designs": []}
    try:
        f = json.loads(p.read_text("utf-8"))
    except (OSError, ValueError) as e:
        raise JobError(f"Could not read {DESIGNS_FILE}: {e}") from e
    if not isinstance(f, dict) or f.get("schema") != DESIGNS_SCHEMA or not isinstance(f.get("designs"), list):
        raise JobError(f"{DESIGNS_FILE} is not an aio.designs/1 file; fix or remove it and import again.")
    return f


def _same_crs(a: dict[str, Any] | None, b: dict[str, Any] | None) -> bool:
    return a is not None and b is not None and json.dumps(a, sort_keys=True) == json.dumps(b, sort_keys=True)


def crs_transform(src: dict[str, Any], dst: dict[str, Any]) -> Transform:
    """Horizontal transform with PROJ (through rasterio); heights pass as they are."""
    from rasterio.crs import CRS
    from rasterio.warp import transform

    def to_crs(c: dict[str, Any]) -> Any:
        return CRS.from_epsg(c["epsg"]) if "epsg" in c else CRS.from_wkt(c["wkt"])

    s, d = to_crs(src), to_crs(dst)

    def run(xyz: np.ndarray) -> np.ndarray:
        out = np.array(xyz, dtype=np.float64, copy=True)
        if len(out) == 0:
            return out
        xs, ys = transform(s, d, out[:, 0].tolist(), out[:, 1].tolist())
        out[:, 0], out[:, 1] = xs, ys
        if not np.isfinite(out[:, :2]).all():
            raise JobError("Some design coordinates fall outside the area the CRS can transform.")
        return out

    return run


def calibration_transform(project: Path, project_crs: dict[str, Any]) -> Transform:
    """Local coordinates to the project CRS through the applied site calibration (section 25).

    The calibration arithmetic is ``aio_pipelines.geodesy.site`` (stream G1). Until that module is in
    the pack, a calibrated import is refused with a clear message instead of guessing.
    """
    p = project / "survey" / "calibration.json"
    if not p.exists():
        raise JobError(
            "This site has no calibration. Import or compute one in Site settings, or choose the CRS "
            "of the design, and import again."
        )
    try:
        cal = json.loads(p.read_text("utf-8"))
    except (OSError, ValueError) as e:
        raise JobError(f"Could not read survey/calibration.json: {e}") from e
    if not isinstance(cal, dict) or not cal.get("appliedAt"):
        raise JobError(
            "The site calibration is a draft. Check its residuals and apply it in Site settings, then "
            "import again."
        )
    try:
        site = importlib.import_module("aio_pipelines.geodesy.site")
        fn = site.local_to_project
    except (ImportError, AttributeError):
        raise JobError(
            "Placing a design through the site calibration needs the site geodesy of a newer pipeline "
            "pack. Choose the CRS of the design and import again."
        ) from None

    def run(xyz: np.ndarray) -> np.ndarray:
        return np.asarray(fn(cal, project_crs, np.asarray(xyz, dtype=np.float64)), dtype=np.float64)

    return run


def _nan_heights_from(surface: Surface, chain: np.ndarray) -> np.ndarray:
    """A 2D boundary takes each point's height from the nearest surface vertex."""
    miss = np.isnan(chain[:, 2])
    if not miss.any():
        return chain
    out = chain.copy()
    if len(surface.vertices) == 0:
        out[miss, 2] = 0.0
        return out
    from scipy.spatial import cKDTree

    _, idx = cKDTree(surface.vertices[:, :2]).query(out[miss, :2])
    out[miss, 2] = surface.vertices[idx, 2]
    return out


def _scale_alignment(al: AlignmentSource, k: float, place: Transform | None) -> dict[str, Any]:
    """An ``aio.alignment/1`` body: lengths times k, points scaled then placed in the project CRS."""
    els = []
    for el in al.elements:
        e = dict(el)
        for key in ("start", "end", "center"):
            if key in e:
                e[key] = [e[key][0] * k, e[key][1] * k]
        e["length"] = el["length"] * k
        if "radius" in e:
            e["radius"] = el["radius"] * k
        for key in ("radiusStart", "radiusEnd"):
            if key in e and e[key] is not None:
                e[key] = e[key] * k
        els.append(e)
    if place is not None:
        placed = []
        for e in els:
            p = dict(e)
            keys = [key for key in ("start", "end", "center") if key in e]
            xyz = place(np.asarray([[*e[key], 0.0] for key in keys]))
            for key, row in zip(keys, xyz, strict=True):
                p[key] = [float(row[0]), float(row[1])]
            if p["type"] == "line":
                p["length"] = math.hypot(p["end"][0] - p["start"][0], p["end"][1] - p["start"][1])
            elif p["type"] == "arc":
                p["radius"] = math.hypot(p["start"][0] - p["center"][0], p["start"][1] - p["center"][1])
            else:
                a = element_point(e, min(0.01, e["length"]))
                q = place(np.asarray([[*e["start"], 0.0], [a[0], a[1], 0.0]]))
                p["dirStart"] = bearing((q[0][0], q[0][1]), (q[1][0], q[1][1]))
            placed.append(p)
        els = placed
    return {
        "name": al.name,
        "startStation": al.start_station * k,
        "elements": [{**e, "start": list(e["start"]), "end": list(e["end"])} for e in els],
        "equations": [{"back": q["back"] * k, "ahead": q["ahead"] * k} for q in al.equations],
    }


class DesignImport:
    name = "design.import"
    title = "Import design"
    description = (
        "LandXML, DXF, 12da or CSV designs to TIN surfaces, linework, alignments and points, "
        "keeping the original file."
    )
    keys = frozenset({"src", "format", "id", "name", "crs", "useCalibration", "units", "layers"})
    required = frozenset({"src"})
    choices = {  # noqa: RUF012 - read only
        "format": frozenset(FORMATS),
        "units": frozenset(UNITS),
    }

    def validate(self, params: dict[str, Any]) -> dict[str, Any]:
        known_keys(params, set(self.keys), self.name)
        missing = sorted(k for k in self.required if params.get(k) is None)
        if missing:
            raise JobError(f"{self.name} needs: {', '.join(missing)}.")
        for key, allowed in self.choices.items():
            if key in params and params[key] not in allowed:
                raise JobError(f"{key} must be one of: {', '.join(sorted(allowed))}.")
        src = params["src"]
        if not isinstance(src, str) or not src.strip():
            raise JobError("src must be the design file.")
        if not Path(src).is_absolute():
            raise JobError("src must be an absolute path.")
        if "id" in params and (not isinstance(params["id"], str) or not DESIGN_ID.match(params["id"])):
            raise JobError("id is letters, digits, dot, dash or _ (at most 80).")
        if "name" in params and (not isinstance(params["name"], str) or not params["name"].strip()):
            raise JobError("name must be a non-empty text.")
        crs = params.get("crs")
        if crs is not None:
            ok = isinstance(crs, dict) and (
                (set(crs) == {"epsg"} and isinstance(crs["epsg"], int) and not isinstance(crs["epsg"], bool))
                or (set(crs) == {"wkt"} and isinstance(crs["wkt"], str) and crs["wkt"])
            )
            if not ok:
                raise JobError("crs must be { epsg } or { wkt }.")
        if "useCalibration" in params and not isinstance(params["useCalibration"], bool):
            raise JobError("useCalibration must be true or false.")
        if params.get("useCalibration") and crs is not None:
            raise JobError("Give a CRS or use the site calibration, not both.")
        layers = params.get("layers")
        if layers is not None and (
            not isinstance(layers, list) or not layers or not all(isinstance(x, str) and x for x in layers)
        ):
            raise JobError("layers must be a list of source layer names.")
        return dict(params)

    def inputs(self, params: dict[str, Any]) -> list[str]:
        return [params["src"]]

    def plan(self, params: dict[str, Any]) -> list[Step]:
        def read(ctx: StepContext) -> dict[str, Any]:
            src = ctx.input(params["src"])
            if not src.is_file():
                raise JobError(f'"{src.name}" is not a file.')
            size = check_size(src)
            fmt = params.get("format") or detect_format(src)
            ctx.progress(0.05, "Reading the design")
            design = read_design(src, fmt)
            ctx.check()
            warnings: list[str] = []

            # units
            given = params.get("units")
            units = design.units
            if units is None:
                if given is None and fmt == "dxf":
                    raise JobError(
                        f'"{src.name}" has no drawing units ($INSUNITS). Choose the units (m, mm, cm, ft, '
                        "US ft or in) and import again."
                    )
                units = given or "m"
            elif given and given != units:
                warnings.append(f'"{src.name}" states its units as {units}; the units {given} are ignored.')
            k = UNIT_M[units]

            # layers filter
            want = params.get("layers")
            if want:
                missing = [x for x in want if x not in design.source_layers]
                if missing:
                    raise JobError(
                        f'"{src.name}" has no layer {", ".join(missing)}. Its layers are: '
                        f"{', '.join(design.source_layers) or 'none'}."
                    )
                keep = set(want)

                def chosen(name: str) -> bool:
                    return name in keep or name.removesuffix(" breaklines") in keep

                design.surfaces = [s for s in design.surfaces if chosen(s.name)]
                design.linework = [x for x in design.linework if chosen(x.name)]
                design.points = [x for x in design.points if chosen(x.name)]
                design.alignments = [x for x in design.alignments if chosen(x.name)]

            # where the coordinates go
            manifest = _manifest(ctx.project)
            project_crs = (manifest or {}).get("crs") or params.get("crs") or design.crs
            if not isinstance(project_crs, dict):
                raise JobError("The project has no CRS; set the project CRS or give the design's CRS.")
            calibrated = bool(params.get("useCalibration"))
            src_crs: dict[str, Any] | None = None
            place: Transform | None = None
            if calibrated:
                place = calibration_transform(ctx.project, project_crs)
            else:
                src_crs = params.get("crs") or design.crs or project_crs
                if not _same_crs(src_crs, project_crs):
                    assert src_crs is not None
                    place = crs_transform(src_crs, project_crs)
            geo = design.crs == {"epsg": 4326} and fmt == "csv"

            def to_project(xyz: np.ndarray) -> np.ndarray:
                a = np.asarray(xyz, dtype=np.float64).reshape(-1, 3).copy()
                if geo:
                    a[:, 2] *= k
                else:
                    a *= k
                return place(a) if place is not None else a

            design_id = params.get("id") or slug(Path(src).stem)
            existing = {d.get("id") for d in read_designs(ctx.project)["designs"] if isinstance(d, dict)}
            if params.get("id") and design_id in existing:
                raise JobError(f'The site already has a design "{design_id}". Choose another id.')
            base_id, n = design_id, 2
            while design_id in existing:
                design_id = f"{base_id[:76]}-{n}"
                n += 1

            src_name = safe_file_name(src.name)
            used: set[str] = set()

            def layer_id(name: str, suffix: str = "") -> str:
                b = slug(name, "layer")[: 80 - len(suffix)] + suffix
                lid, i = b, 2
                while lid.lower() in used:
                    lid = f"{b[:76]}-{i}"
                    i += 1
                used.add(lid.lower())
                return lid

            layers: list[dict[str, Any]] = []
            total = max(
                1, len(design.surfaces) + len(design.linework) + len(design.points) + len(design.alignments)
            )
            done = 0

            def tick() -> None:
                nonlocal done
                done += 1
                ctx.check()
                ctx.progress(0.2 + 0.8 * done / total)

            for s in design.surfaces:
                check_triangles(src, s.name, len(s.triangles))
                lid = layer_id(s.name)
                chains = [(kind, _nan_heights_from(s, c)) for kind, c in s.chains]
                verts = to_project(s.vertices)
                chains = [(kind, to_project(c)) for kind, c in chains]
                tris = s.triangles.astype(np.uint32)
                verts, idx = chain_indices(verts, chains)
                atomic_write_bytes(ctx.stage(f"out/{lid}.tin"), encode_tin(verts, tris, project_crs, idx))
                counts = {"triangles": len(tris), "vertices": len(verts)}
                if idx:
                    counts["breaklines"] = sum(1 for kd, _ in idx if kd == CHAIN_BREAKLINE)
                    counts["boundaries"] = sum(1 for kd, _ in idx if kd != CHAIN_BREAKLINE)
                layers.append(_layer(lid, s.name, "surface", f"{lid}.tin", counts))
                tick()
            for lw in design.linework:
                lid = layer_id(lw.name)
                feats = []
                nverts = 0
                for line in lw.lines:
                    xyz = to_project(line.coords)
                    nverts += len(xyz)
                    coords = [[float(x), float(y), float(z)] for x, y, z in xyz]
                    if line.closed and coords[0] != coords[-1]:
                        coords.append(coords[0])
                    props: dict[str, Any] = {"layer": lw.name, "role": line.role, "closed": line.closed}
                    if line.name:
                        props["name"] = line.name
                    feats.append(
                        {
                            "type": "Feature",
                            "properties": props,
                            "geometry": {"type": "LineString", "coordinates": coords},
                        }
                    )
                atomic_write_json(
                    ctx.stage(f"out/{lid}.geojson"),
                    {"type": "FeatureCollection", "crs": project_crs, "features": feats},
                    indent=None,
                )
                layers.append(
                    _layer(
                        lid, lw.name, "linework", f"{lid}.geojson", {"lines": len(feats), "vertices": nverts}
                    )
                )
                tick()
            for pts in design.points:
                lid = layer_id(pts.name)
                xyz = to_project(np.asarray([[p.e, p.n, p.z] for p in pts.points], dtype=np.float64))
                body = {
                    "schema": POINTS_SCHEMA,
                    "crs": project_crs,
                    "points": [
                        {
                            "id": p.id,
                            **({"code": p.code} if p.code else {}),
                            "e": float(r[0]),
                            "n": float(r[1]),
                            "z": float(r[2]),
                        }
                        for p, r in zip(pts.points, xyz, strict=True)
                    ],
                }
                atomic_write_json(ctx.stage(f"out/{lid}.points.json"), body, indent=None)
                codes = {p.code for p in pts.points if p.code}
                layers.append(
                    _layer(
                        lid,
                        pts.name,
                        "points",
                        f"{lid}.points.json",
                        {"points": len(pts.points), "codes": len(codes)},
                    )
                )
                tick()
            for al in design.alignments:
                lid = layer_id(al.name)
                body = {"schema": ALIGNMENT_SCHEMA, "crs": project_crs, **_scale_alignment(al, k, place)}
                try:
                    regions(body)
                except ValueError as e:
                    raise JobError(f'"{src.name}": the alignment "{al.name}": {e}.') from None
                for issue in check_continuity(body):
                    warnings.append(f'The alignment "{al.name}": {issue}.')
                atomic_write_json(ctx.stage(f"out/{lid}.alignment.json"), body, indent=1)
                kinds = [e["type"] for e in body["elements"]]
                layers.append(
                    _layer(
                        lid,
                        al.name,
                        "alignment",
                        f"{lid}.alignment.json",
                        {
                            "elements": len(kinds),
                            "lines": kinds.count("line"),
                            "arcs": kinds.count("arc"),
                            "spirals": kinds.count("spiral"),
                            "equations": len(body["equations"]),
                        },
                    )
                )
                tick()
            if not layers:
                raise JobError(f'"{src.name}" has nothing to import on the chosen layers.')
            files = {x["file"].lower() for x in layers}
            if src_name.lower() in files or src_name.lower().endswith(".glb"):
                src_name = safe_file_name(f"source {src_name}")
            digest = hashlib.sha256()
            with open(src, "rb") as f:
                for chunk in iter(lambda: f.read(1 << 20), b""):
                    digest.update(chunk)
            shutil.copyfile(src, ctx.stage(f"out/{src_name}"))
            for w in warnings:
                ctx.log(w, "warn")
            if design.skipped:
                ctx.log("Skipped: " + ", ".join(f"{k} {n}" for k, n in design.skipped.items()) + ".")
            entry: dict[str, Any] = {
                "id": design_id,
                "name": (params.get("name") or Path(src).stem or design_id)[:200],
                "src": src_name,
                "sha256": digest.hexdigest(),
                "bytes": size,
                "format": fmt,
                "units": units,
                "calibrated": calibrated,
                "layers": layers,
            }
            if not calibrated and src_crs is not None:
                entry["crs"] = src_crs
            return {"entry": entry, "warnings": warnings}

        def display(ctx: StepContext) -> dict[str, Any]:
            entry = ctx.outputs("read")["entry"]
            manifest = _manifest(ctx.project) or {}
            origin = manifest.get("origin")
            surfaces = [x for x in entry["layers"] if x["kind"] == "surface"]
            glbs: dict[str, str] = {}
            for i, layer in enumerate(surfaces):
                ctx.check()
                tin = read_tin(ctx.stage(f"out/{layer['file']}"))
                if len(tin.triangles) == 0:
                    continue
                o = np.asarray(
                    origin if isinstance(origin, list) and len(origin) == 3 else tin.vertices.min(axis=0)
                )
                atomic_write_bytes(
                    ctx.stage(f"out/{layer['id']}.glb"), display_glb(tin.vertices, tin.triangles, o)
                )
                glbs[layer["id"]] = f"{layer['id']}.glb"
                ctx.progress((i + 1) / max(1, len(surfaces)))
            return {"glbs": glbs}

        def commit(ctx: StepContext) -> dict[str, Any]:
            entry = dict(ctx.outputs("read")["entry"])
            glbs = ctx.outputs("display")["glbs"]
            entry["layers"] = [
                ({**x, "glb": glbs[x["id"]]} if x["id"] in glbs else x) for x in entry["layers"]
            ]
            folder = f"{DESIGNS_DIR}/{entry['id']}"
            designs = read_designs(ctx.project)
            if any(isinstance(d, dict) and d.get("id") == entry["id"] for d in designs["designs"]):
                raise JobError(f'The site already has a design "{entry["id"]}". Import again.')
            if ctx.out(folder).exists() and any(ctx.out(folder).iterdir()):
                raise JobError(f"The folder {folder} is already there; import again.")
            commit_tree(ctx, "out", folder)
            entry["importedAt"] = now_iso()
            designs["designs"].append(entry)
            path = ctx.out(DESIGNS_FILE)
            if path.exists():
                shutil.copyfile(path, path.with_name("designs.json.bak"))
            atomic_write_json(path, designs, indent=1)
            ctx.artifact(DESIGNS_FILE)
            return {
                "design": entry["id"],
                "folder": folder,
                "layers": [x["id"] for x in entry["layers"]],
                "warnings": ctx.outputs("read")["warnings"],
            }

        return [
            Step("read", "Read the design", read, weight=3),
            Step("display", "Write display meshes", display, weight=1),
            Step("commit", "Add the design to the site", commit, weight=0.5),
        ]


def _layer(lid: str, name: str, kind: str, file: str, counts: dict[str, int]) -> dict[str, Any]:
    return {
        "id": lid,
        "name": (name or lid)[:200],
        "kind": kind,
        "file": file,
        "counts": counts,
        "visible": True,
        "archived": False,
        "verticalOffsetM": 0.0,
    }


def display_glb(vertices: np.ndarray, triangles: np.ndarray, origin: np.ndarray) -> bytes:
    """A GLB in the scene frame (x east, y up, z south, about ``origin``), every face turned up."""
    import trimesh

    v = np.asarray(vertices, dtype=np.float64)
    t = np.asarray(triangles, dtype=np.int64).copy()
    a, b, c = v[t[:, 0]], v[t[:, 1]], v[t[:, 2]]
    up = (b[:, 0] - a[:, 0]) * (c[:, 1] - a[:, 1]) - (b[:, 1] - a[:, 1]) * (c[:, 0] - a[:, 0])
    flip = up < 0
    t[flip] = t[flip][:, [0, 2, 1]]
    local = np.empty_like(v)
    local[:, 0] = v[:, 0] - origin[0]
    local[:, 1] = v[:, 2] - origin[2]
    local[:, 2] = -(v[:, 1] - origin[1])
    mesh = trimesh.Trimesh(vertices=local.astype(np.float32), faces=t, process=False)
    buf = io.BytesIO()
    buf.write(mesh.export(file_type="glb"))
    return buf.getvalue()
