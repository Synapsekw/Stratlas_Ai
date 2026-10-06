"""drawing.import: a DXF plot plan in its units, placed by control points. DWG is not supported.

Parameters as ``DrawingImportParams`` in ``@aio/schema``. Steps:

- ``read``: parse the DXF (``dxf.py``), settle the units, apply the ``layers`` filter;
- ``place``: the placement from drawing units to the local frame (``place.py``);
- ``write``: stage the DXF copy, ``placement.json``, the candidate parts
  (``parts.procmodel.json``), the plan PNG and one GeoJSON per DXF layer;
- ``commit``: move the files into ``drawings/`` and add or update the manifest layers (last,
  with ``manifest.json.bak``).
"""

from __future__ import annotations

import json
import re
import shutil
from pathlib import Path
from typing import Any

from ..params import known_keys, text
from ..runtime import JobError, Step, StepContext, atomic_write_json, commit_files, now_iso, safe_project_path
from .dxf import UNIT_M, read_dxf

UNITS = ("mm", "cm", "m", "in", "ft", "us-ft")
PLACEMENT_SCHEMA = "aio.drawingplacement/1"
PROCMODEL_SCHEMA = "aio.procmodel/1"


def stem_of(src: str) -> str:
    s = re.sub(r"[^A-Za-z0-9_-]+", "-", Path(src).stem).strip("-_")[:80]
    return s if s and s[0].isalnum() else f"drawing{('-' + s) if s else ''}"[:80]


def _manifest(ctx: StepContext) -> dict[str, Any]:
    p = ctx.project / "manifest.json"
    try:
        m = json.loads(p.read_text("utf-8"))
    except (OSError, ValueError) as e:
        raise JobError(f"Could not read the project manifest {p}: {e}") from e
    if not isinstance(m, dict):
        raise JobError(f"{p} is not a project manifest.")
    return m


class DrawingImport:
    name = "drawing.import"
    title = "Drawing import (DXF)"
    description = "A DXF plot plan placed by control points: vector layers, a plan raster and height hints."
    keys = frozenset({"src", "units", "layers", "control", "out"})

    def validate(self, params: dict[str, Any]) -> dict[str, Any]:
        known_keys(params, set(self.keys), self.name)
        src = text(params, "src", required=True)
        assert src is not None
        if Path(src).suffix.lower() == ".dwg":
            raise JobError("DWG is not supported. Save the drawing as DXF and import again.")
        if Path(src).suffix.lower() != ".dxf":
            raise JobError(f'"{Path(src).name}" is not a DXF file. Choose a .dxf drawing and import again.')
        out: dict[str, Any] = {"src": src, "out": text(params, "out", "drawings")}
        units = params.get("units")
        if units is not None:
            if units not in UNITS:
                raise JobError(f"units must be one of {', '.join(UNITS)}.")
            out["units"] = units
        layers = params.get("layers")
        if layers is not None:
            if not isinstance(layers, list) or not all(isinstance(x, str) and x for x in layers):
                raise JobError("layers must be a list of DXF layer names.")
            out["layers"] = layers
        control = params.get("control")
        if control is not None:
            if not isinstance(control, list):
                raise JobError("control must be a list of control points.")
            for i, c in enumerate(control):
                ok = (
                    isinstance(c, dict)
                    and set(c) <= {"drawing", "lonLat", "local"}
                    and isinstance(c.get("drawing"), list)
                    and len(c["drawing"]) == 2
                    and (("lonLat" in c) != ("local" in c))
                )
                if not ok:
                    raise JobError(
                        f"Control point {i + 1} needs drawing [x, y] and either lonLat [lon, lat] or "
                        "local [x, y, z]."
                    )
            out["control"] = control
        return out

    def inputs(self, params: dict[str, Any]) -> list[str]:
        return [params["src"]]

    def plan(self, params: dict[str, Any]) -> list[Step]:
        out_dir = str(params["out"]).replace("\\", "/").strip("/")
        stem = stem_of(params["src"])
        fname = Path(params["src"]).name

        def load(ctx: StepContext):
            src = ctx.input(params["src"])
            if src.read_bytes()[:4] == b"AC10":
                raise JobError("DWG is not supported. Save the drawing as DXF and import again.")
            doc = read_dxf(src)
            units = doc.units
            given = params.get("units")
            if units is None and given is None:
                raise JobError(
                    f'"{fname}" has no drawing units. Set the drawing units (mm, cm, m, in, ft or US '
                    "survey ft) and import again."
                )
            if units is None:
                units = given
            elif given and given != units:
                ctx.log(f'"{fname}" states its units as {units}; the units {given} are ignored.', "warn")
            ents = doc.entities
            if params.get("layers"):
                want = set(params["layers"])
                ents = [e for e in ents if e.layer in want]
                if not ents:
                    raise JobError(
                        f'"{fname}" has nothing on the layers {", ".join(sorted(want))}. Its layers are: '
                        f"{', '.join(doc.layers) or 'none'}. Choose some of these and import again."
                    )
            if not ents:
                raise JobError(
                    f'"{fname}" has no lines, shapes or text to import. Check the file and try again.'
                )
            return doc, ents, units

        def read(ctx: StepContext) -> dict[str, Any]:
            doc, ents, units = load(ctx)
            if doc.skipped:
                ctx.log("Skipped " + ", ".join(f"{n} {k}" for k, n in doc.skipped.items()))
            counts: dict[str, int] = {}
            for e in ents:
                counts[e.type] = counts.get(e.type, 0) + 1
            ctx.log(f"{fname}: {len(ents)} entities in {units}.")
            return {"units": units, "entities": dict(sorted(counts.items())), "skipped": doc.skipped}

        def place_step(ctx: StepContext) -> dict[str, Any]:
            from .place import place
            from .render import drawing_bounds

            _, ents, units = load(ctx)
            m = _manifest(ctx)
            epsg = (m.get("crs") or {}).get("epsg")
            p = place(
                params.get("control"),
                UNIT_M[units],
                m.get("origin") or [0, 0, 0],
                epsg if isinstance(epsg, int) else None,
                drawing_bounds(ents),
                ctx.log,
            )
            return {
                "matrix": list(p.matrix),
                "baseY": p.base_y,
                "scale": p.scale,
                "rotationDeg": p.rotation_deg,
                "rmsM": p.rms_m,
                "provisional": p.provisional,
                "far": p.far,
            }

        def write(ctx: StepContext) -> dict[str, Any]:
            from .parts import build_parts
            from .place import Placement
            from .render import geojson_layers, layer_colour, render_plan, slug

            _, ents, units = load(ctx)
            po = ctx.outputs("place")
            pl = Placement(
                tuple(po["matrix"]),  # type: ignore[arg-type]
                po["baseY"],
                po["scale"],
                po["rotationDeg"],
                po["rmsM"],
                po["provisional"],
                po.get("far", False),
            )
            m = _manifest(ctx)
            epsg = (m.get("crs") or {}).get("epsg")
            dxf_rel = f"{out_dir}/{stem}.dxf"
            shutil.copyfile(ctx.input(params["src"]), ctx.stage("out/drawing.dxf"))
            atomic_write_json(
                ctx.stage("out/placement.json"),
                {
                    "schema": PLACEMENT_SCHEMA,
                    "file": dxf_rel,
                    "units": units,
                    "unitM": UNIT_M[units],
                    "matrix": po["matrix"],
                    "baseY": po["baseY"],
                    "rmsM": po["rmsM"],
                    "control": params.get("control") or [],
                    "provisional": po["provisional"],
                },
            )
            parts, hints = build_parts(ents, pl, dxf_rel, ctx.log)
            t = now_iso()
            atomic_write_json(
                ctx.stage("out/parts.procmodel.json"),
                {
                    "schema": PROCMODEL_SCHEMA,
                    "id": stem,
                    "name": fname,
                    "createdAt": t,
                    "updatedAt": t,
                    "sources": [{"kind": "drawing", "ref": dxf_rel}],
                    "parts": parts,
                },
            )
            ctx.check()
            corners, size = render_plan(ents, pl, ctx.stage("out/plan.png"))
            vectors: list[dict[str, Any]] = []
            if isinstance(epsg, int):
                by_layer = geojson_layers(ents, pl, m.get("origin") or [0, 0, 0], epsg)
                taken: set[str] = set()
                for layer, fc in by_layer.items():
                    s, i = slug(layer), 2
                    base = s
                    while s in taken or s == "parts" or s == "plan" or s == "placement":
                        s, i = f"{base}-{i}", i + 1
                    taken.add(s)
                    atomic_write_json(ctx.stage(f"out/layers/{s}.geojson"), fc, indent=None)
                    vectors.append(
                        {
                            "slug": s,
                            "layer": layer,
                            "color": layer_colour(layer, [e for e in ents if e.layer == layer]),
                        }
                    )
            else:
                ctx.log(
                    "The project CRS has no EPSG code, so the drawing layers are not written as map "
                    "layers; the plan image and the parts are.",
                    "warn",
                )
            return {
                "corners": corners,
                "planSize": list(size),
                "vectors": vectors,
                "parts": len(parts),
                "hints": hints,
            }

        def commit(ctx: StepContext) -> dict[str, Any]:
            w = ctx.outputs("write")
            sub = f"{out_dir}/{stem}"
            moves = [
                ("out/drawing.dxf", f"{out_dir}/{stem}.dxf"),
                ("out/placement.json", f"{sub}/placement.json"),
                ("out/parts.procmodel.json", f"{sub}/parts.procmodel.json"),
                ("out/plan.png", f"{sub}/plan.png"),
            ]
            moves += [(f"out/layers/{v['slug']}.geojson", f"{sub}/{v['slug']}.geojson") for v in w["vectors"]]
            commit_files(ctx, moves)
            mpath = safe_project_path(ctx.project, "manifest.json")
            manifest = json.loads(mpath.read_text("utf-8"))
            layers = manifest.setdefault("layers", [])
            plan_id = f"plan-{stem}"
            new = [
                {
                    "kind": "raster",
                    "id": plan_id,
                    "name": f"{fname} plan",
                    "visible": True,
                    "role": "plan",
                    "format": "image",
                    "src": {"path": f"{sub}/plan.png"},
                    "corners": w["corners"],
                }
            ]
            vector_ids = []
            for v in w["vectors"]:
                lid = f"drawing-{stem}-{v['slug']}"
                vector_ids.append(lid)
                new.append(
                    {
                        "kind": "vector",
                        "id": lid,
                        "name": f"{fname} {v['layer']}",
                        "visible": True,
                        "src": {"path": f"{sub}/{v['slug']}.geojson"},
                        "format": "geojson",
                        "style": {"line": {"color": v["color"], "width": 1.5}, "label": {"field": "text"}},
                    }
                )
            for layer in new:
                i = next((k for k, x in enumerate(layers) if x.get("id") == layer["id"]), None)
                if i is None:
                    layers.append(layer)
                else:
                    keep = {k: layers[i][k] for k in ("visible", "capture") if k in layers[i]}
                    layers[i] = {**layer, **keep}
            shutil.copyfile(mpath, mpath.with_name("manifest.json.bak"))
            atomic_write_json(mpath, manifest, indent=2)
            r = ctx.outputs("read")
            p = ctx.outputs("place")
            return {
                "drawing": f"{out_dir}/{stem}.dxf",
                "parts": f"{sub}/parts.procmodel.json",
                "placement": f"{sub}/placement.json",
                "plan": f"{sub}/plan.png",
                "planLayer": plan_id,
                "vectorLayers": vector_ids,
                "units": r["units"],
                "scale": p["scale"],
                "rmsM": p["rmsM"],
                "entities": r["entities"],
                "hints": w["hints"],
                "partCount": w["parts"],
            }

        return [
            Step("read", "Read the drawing", read),
            Step("place", "Place the drawing", place_step, weight=0.5),
            Step("write", "Write the plan, layers and parts", write, weight=3),
            Step("commit", "Add the layers to the project", commit, weight=0.5),
        ]
