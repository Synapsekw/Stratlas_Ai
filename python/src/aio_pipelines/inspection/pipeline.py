"""inspection.run: a native inspection project through the Asset Inspection Kit, as a resumable job.

Steps (each keeps its manifest, so a cancelled or crashed job resumes at the next one):

  read        manifest, photos with poses, meshes -> a kit job in staging (kit frame, cameras.json, model.glb)
  sheets      contact sheets with photo ids burned in, and their layout (aik.contact)
  detections  aio.detections/1, kit, COCO and YOLO inputs -> the kit assessment (aik.detections)
  place       back-projection of every box onto the model (aik.project, point placement)
  cluster     defect groups, heights, zones, sides, stats, register and CSV (aik.records) -> issues
  commit      outputs into ``<out>/``, then the issues merged into issues.json (backup kept)

Outputs: ``<out>/contact/sheet-NN.jpg`` and ``layout.json``, ``<out>/detections.json`` (what
counted), ``<out>/records.json`` (kit records summary and stats, ``aio.aik-records/1``),
``<out>/findings.csv`` (kit CSV), ``<out>/issues-map.json`` and ``issues.json``.
"""

from __future__ import annotations

import json
import os
import shutil
from pathlib import Path
from typing import Any

from ..params import known_keys, number, text
from ..runtime import (
    JobError,
    Step,
    StepContext,
    atomic_write_bytes,
    atomic_write_json,
    commit_files,
    commit_tree,
    safe_project_path,
)

ISSUES_SCHEMA = "aio.issues/1"


def profile_for(asset_type: str | None) -> str:
    """The kit vertical profile (zones, sides) closest to a class catalogue's asset type."""
    t = (asset_type or "").lower()
    if "tank" in t or "silo" in t:
        return "tank"
    if "telecom" in t or "mast" in t:
        return "telecom-tower"
    if "ohtl" in t or "pylon" in t or "line" in t:
        return "ohtl-tower"
    return "stack"


def _paths(params: dict[str, Any]) -> list[str]:
    v = params.get("detections", "detections")
    return [v] if isinstance(v, str) else list(v)


class InspectionRun:
    name = "inspection.run"
    title = "Inspection: detections to issues"
    description = (
        "Contact sheets, detections placed on the model, grouped into issues, and the stats for the report."
    )

    def validate(self, params: dict[str, Any]) -> dict[str, Any]:
        from ..aik.config import profile_ids

        known_keys(
            params,
            {"detections", "includeDrafts", "minConfidence", "clusterM", "hfovDeg", "profile",
             "sheetsPer", "sheetWidth", "yoloNames", "out"},
            self.name,
        )  # fmt: skip
        det = params.get("detections", "detections")
        if isinstance(det, str):
            det = [text(params, "detections", "detections")]
        elif not (isinstance(det, list) and det and all(isinstance(x, str) and x.strip() for x in det)):
            raise JobError("detections must be a file or folder, or a list of them.")
        drafts = params.get("includeDrafts", False)
        if not isinstance(drafts, bool):
            raise JobError("includeDrafts must be true or false.")
        out: dict[str, Any] = {
            "detections": det,
            "includeDrafts": drafts,
            "minConfidence": number(params, "minConfidence", None, 0, 1),
            "clusterM": number(params, "clusterM", None, 0.01, 1000),
            "hfovDeg": number(params, "hfovDeg", 70.0, 1, 179),
            "sheetsPer": number(params, "sheetsPer", 12, 1, 64, integer=True),
            "sheetWidth": number(params, "sheetWidth", 1800, 400, 8000, integer=True),
            "out": text(params, "out", "inspection"),
        }
        if params.get("profile") is not None:
            if params["profile"] not in profile_ids():
                raise JobError(f"profile must be one of {', '.join(profile_ids())}.")
            out["profile"] = params["profile"]
        names = params.get("yoloNames")
        if names is not None:
            if isinstance(names, str):
                names = [n.strip() for n in names.split(",") if n.strip()]
            if not (isinstance(names, list) and names and all(isinstance(n, str) for n in names)):
                raise JobError("yoloNames must list the class of each YOLO class index.")
            out["yoloNames"] = names
        safe_project_path(Path("."), out["out"])
        return {k: v for k, v in out.items() if v is not None}

    def inputs(self, params: dict[str, Any]) -> list[str]:
        # what the job reads: the manifest, review copies and models (builder layout), detections
        return ["manifest.json", "photos", "models", *_paths(params)]

    def plan(self, params: dict[str, Any]) -> list[Step]:
        out_dir = params["out"].replace("\\", "/").strip("/")

        def kit_job(ctx: StepContext):
            from ..aik.config import KitJob

            raw = json.loads(ctx.stage("kit/job.json").read_text("utf-8"))
            return KitJob(raw, ctx.staging / "kit")

        def read_state(ctx: StepContext) -> dict[str, Any]:
            return json.loads(ctx.stage("read.json").read_text("utf-8"))

        # ------------------------------------------------------------ read
        def read(ctx: StepContext) -> dict[str, Any]:
            from PIL import Image

            from . import frame as Fr
            from .detections import Catalogue

            manifest = Fr.read_manifest(ctx.project)
            cat = Catalogue(manifest)
            ctx.progress(0.05, "Reading the models")
            parts = Fr.load_meshes(ctx.project, Fr.mesh_layers(manifest), ctx.log)
            ctx.check()
            fp = Fr.footprint(parts)
            ax = (fp["min"][0] + fp["max"][0]) / 2
            az = (fp["min"][2] + fp["max"][2]) / 2
            frame = Fr.Frame(ax, az)
            height = float(fp["max"][1])
            nodes = Fr.write_kit_model(parts, frame, ctx.stage("kit/model.glb"))
            ctx.log(
                f"{len(parts)} model parts from {len({n['layer'] for n in nodes})} mesh layers; "
                f"asset axis at x {ax:.2f}, z {az:.2f}; top {height:.2f} m"
            )
            ctx.progress(0.4, "Reading the photos")

            photos: list[dict[str, Any]] = []
            unplaced: list[str] = []
            missing: list[str] = []
            for layer in Fr.photo_layers(manifest):
                for item in layer.get("items", []):
                    path = Fr.asset_path(ctx.project, item.get("src"))
                    if path is None or not path.exists():
                        missing.append(item.get("id", "?"))
                        continue
                    if not item.get("pos"):
                        unplaced.append(item["id"])
                        continue
                    photos.append({**item, "_layer": layer["id"], "_file": str(path)})
            if missing:
                ctx.log(
                    f"{len(missing)} photos are missing from the project folder: {', '.join(missing[:8])}",
                    "warn",
                )
            if unplaced:
                ctx.log(
                    f"{len(unplaced)} photos have no position and cannot place detections: {', '.join(unplaced[:8])}"
                    + (" ..." if len(unplaced) > 8 else ""),
                    "warn",
                )
            if not photos:
                raise JobError("No photo in this project has a position. Import geotagged photos first.")
            ids = [p["id"] for p in photos]
            dup = {i for i in ids if ids.count(i) > 1}
            geo = Fr.wgs84(manifest, [p["pos"] for p in photos])
            cams = []
            index: dict[str, Any] = {}
            for n, (p, g) in enumerate(zip(photos, geo, strict=True)):
                ctx.check()
                cid = f"{p['_layer']}-{p['id']}" if p["id"] in dup else p["id"]
                with Image.open(p["_file"]) as im:
                    size = im.size
                if g:
                    p["_lat"], p["_lon"], p["_alt"] = g
                name = os.path.basename(p["src"]["path"])
                if p["id"] in dup:
                    name = f"{p['_layer']}-{name}"
                cams.append(Fr.kit_camera(cid, name, p, size, frame, params["hfovDeg"], height, ctx.log))
                index[cid] = {"layer": p["_layer"], "photo": p["id"], "name": name, "path": p["_file"],
                              "pw": size[0], "ph": size[1]}  # fmt: skip
                ctx.progress(0.4 + 0.55 * (n + 1) / len(photos))
            aimed = sum(1 for c in cams if c["orientation_source"] != "pose")
            if aimed:
                ctx.log(
                    f"{aimed} photos have no orientation; they are aimed at the asset axis (kit rule)", "warn"
                )
            atomic_write_json(ctx.stage("kit/cameras.json"), {"photos": cams, "alignment": {
                "model_axes": "X north, Y up above the project origin height, Z east",
                "axis": [round(ax, 4), round(az, 4)], "accuracy": "project photo poses"}})  # fmt: skip

            profile = params.get("profile") or profile_for(cat.asset_type)
            levels: dict[int, dict[str, Any]] = {}
            for m in manifest.get("severityModels", []):
                for lv in m.get("levels", []):
                    levels.setdefault(int(lv["value"]), {"level": int(lv["value"]), "label": lv["label"],
                                                         "color": lv.get("color", "#ff7a2d")})  # fmt: skip
            classes = [
                {"id": i + 1, "key": c["id"], "label": c["label"], "color": c.get("color", "#ff7a2d")}
                for i, c in enumerate(cat.classes.values())
            ]
            prof_over: dict[str, Any] = {
                "finding_unit": "region",
                "placement": "point",
                "classes": classes,
                "severity": [levels[k] for k in sorted(levels)],
            }
            if params.get("clusterM") is not None:
                prof_over["cluster_m"] = params["clusterM"]
            kit = {
                "job": {"id": "inspection", "title": manifest.get("name", ""), "profile": profile},
                "inputs": {"model": "model.glb", "cameras": "cameras.json", "assessment": "assessment.json",
                           "surface": "surface.json", "masks": "masks"},
                "asset": {},
                "profile": prof_over,
            }  # fmt: skip
            atomic_write_json(ctx.stage("kit/job.json"), kit)
            atomic_write_json(
                ctx.stage("read.json"),
                {"axis": [ax, az], "height": height, "footprint": fp, "nodes": nodes, "cameras": index,
                 "profile": profile, "unplaced": unplaced, "missing": missing},
            )  # fmt: skip
            ctx.log(f"{len(cams)} placed photos; kit profile {profile}")
            return {"photos": len(cams), "unplaced": len(unplaced), "missing": len(missing), "profile": profile,
                    "layers": sorted({n["layer"] for n in nodes})}  # fmt: skip

        # ------------------------------------------------------------ sheets
        def sheets(ctx: StepContext) -> dict[str, Any]:
            from ..aik import contact as Ct

            st = read_state(ctx)
            cells = [{"id": cid, "layer": c["layer"], "photo": c["photo"], "path": c["path"],
                      "pw": c["pw"], "ph": c["ph"]} for cid, c in st["cameras"].items()]  # fmt: skip
            layout = Ct.sheet_layout(cells, int(params["sheetsPer"]), int(params["sheetWidth"]))
            done = Ct.sheets(layout, str(ctx.stage("contact/layout.json").parent), ctx.check, ctx.progress)
            public = [
                {"name": s["name"], "file": f"{out_dir}/contact/{s['name']}.jpg", "size": s["size"],
                 "cells": [{k: c[k] for k in ("id", "layer", "photo", "x", "y", "w", "h", "pw", "ph")}
                           for c in s["cells"]]}
                for s in layout
            ]  # fmt: skip
            atomic_write_json(
                ctx.stage("contact/layout.json"),
                {"schema": "aio.contact-sheets/1", "per": params["sheetsPer"], "width": params["sheetWidth"],
                 "sheets": public},
            )  # fmt: skip
            ctx.log(f"{len(done)} contact sheets of {len(cells)} photos")
            return {"sheets": len(done)}

        # ------------------------------------------------------------ detections
        def detections(ctx: StepContext) -> dict[str, Any]:
            from ..aik import detections as D
            from . import frame as Fr
            from .detections import Catalogue, Reader, detection_files

            st = read_state(ctx)
            cat = Catalogue(Fr.read_manifest(ctx.project))
            layout = json.loads(ctx.stage("contact/layout.json").read_text("utf-8"))["sheets"]
            files = detection_files(ctx.project, _paths(params), bool(params.get("yoloNames")))
            reader = Reader(cat, st["cameras"], layout, ctx.log)
            reader.read(files, params)
            ctx.check()
            job = kit_job(ctx)
            if reader.assessed is None:
                skip: tuple[str, ...] = ()
            else:
                skip = tuple(c["name"] for cid, c in st["cameras"].items() if cid not in reader.assessed)
            D.convert_list(
                job,
                [dict(d) for d in reader.dets],
                f"detections imported ({len(files)} files)",
                skip=skip,
                out=str(ctx.stage("kit/assessment.json")),
                log=lambda m: ctx.log(m),
            )
            counted = [
                {"id": d["id"], "photo": st["cameras"][d["image"]]["photo"],
                 "layer": st["cameras"][d["image"]]["layer"], "class": d["class"],
                 "severity": "uncertain" if reader.meta[d["id"]]["uncertain"] else d["severity"],
                 "bbox": [round(v, 1) for v in d["bbox"]], "space": "preview",
                 **({"confidence": d["confidence"]} if d.get("confidence") is not None else {}),
                 **({"note": d["note"]} if d.get("note") else {}),
                 **({"component": d["component"]} if d.get("component") else {}),
                 "source": reader.meta[d["id"]]["source"], "file": reader.meta[d["id"]]["file"]}
                for d in reader.dets
            ]  # fmt: skip
            atomic_write_json(
                ctx.stage("out/detections.json"),
                {"schema": "aio.detections/1", "source": "import", "producer": "inspection.run",
                 "assessed": "all" if reader.assessed is None else sorted(st["cameras"][c]["photo"] for c in reader.assessed),
                 "detections": counted},
            )  # fmt: skip
            atomic_write_json(ctx.stage("meta.json"), {"meta": reader.meta, "skipped": reader.skipped})
            if not files:
                ctx.log(
                    "No detections yet. Review the contact sheets or run a detection pass, save the boxes to "
                    "detections/ as aio.detections/1, then run this job again.",
                    "warn",
                )
            if reader.skipped:
                ctx.log(
                    "Not counted: " + ", ".join(f"{n} {why}" for why, n in sorted(reader.skipped.items()))
                )
            ctx.log(f"{len(reader.dets)} detections from {len(files)} files")
            return {"files": len(files), "detections": len(reader.dets), "skipped": reader.skipped}

        # ------------------------------------------------------------ place
        def place(ctx: StepContext) -> dict[str, Any]:
            from ..aik import project as P

            n = ctx.outputs("detections").get("detections", 0)
            if not n:
                surface = {
                    "version": 1,
                    "method": "kit back-projection",
                    "patches": [],
                    "points": [],
                    "unmapped": [],
                }
            else:
                surface = P.run(
                    kit_job(ctx),
                    grid=48,
                    log=ctx.log,
                    check=ctx.check,
                    progress=lambda f, m=None: ctx.progress(f, m),
                )
            atomic_write_bytes(ctx.stage("kit/surface.json"), json.dumps(surface).encode("utf-8"))
            return {"points": len(surface["points"]), "unmapped": len(surface["unmapped"])}

        # ------------------------------------------------------------ cluster
        def cluster(ctx: StepContext) -> dict[str, Any]:
            from ..aik import records as R_
            from . import frame as Fr
            from .detections import Catalogue
            from .issues import proposals

            st = read_state(ctx)
            cat = Catalogue(Fr.read_manifest(ctx.project))
            meta = json.loads(ctx.stage("meta.json").read_text("utf-8"))
            frame = Fr.Frame(*st["axis"])
            job = kit_job(ctx)
            ctx.progress(0.1, "Grouping findings")
            R = R_.build(job)
            ctx.check()
            uncertain_fixups(R, meta["meta"], job.profile)
            layer_of = layer_finder(ctx.stage("kit/model.glb"), st["nodes"])
            props = proposals(R, meta["meta"], cat, frame, st["cameras"], layer_of)
            summary = R_.summary(R)
            summary["stats"]["detections"] = len(R["findings"])
            summary["stats"]["skipped"] = meta["skipped"]
            summary["stats"]["unplaced_photos"] = len(st["unplaced"])
            summary["frame"] = {
                "axis": st["axis"],
                "note": "findings are in the kit frame; issues in the project frame",
            }
            atomic_write_json(ctx.stage("out/records.json"), json.loads(json.dumps(summary, default=str)))
            atomic_write_bytes(ctx.stage("out/findings.csv"), R_.csv_text(R).encode("utf-8"))
            atomic_write_json(ctx.stage("proposals.json"), props)
            s = R["stats"]
            ctx.log(
                f"{s['findings']} findings in {len(props)} groups ({s['mapped']} placed on the model), "
                f"{s['photos_with_findings']} of {s['photos']} photos with findings"
            )
            return {"findings": s["findings"], "groups": len(props), "mapped": s["mapped"]}

        # ------------------------------------------------------------ commit
        def commit(ctx: StepContext) -> dict[str, Any]:
            from .issues import merge, now_iso

            commit_tree(ctx, "contact", f"{out_dir}/contact")
            commit_files(ctx, [("out/detections.json", f"{out_dir}/detections.json"),
                               ("out/findings.csv", f"{out_dir}/findings.csv")])  # fmt: skip
            props = json.loads(ctx.stage("proposals.json").read_text("utf-8"))
            issues_path = ctx.out("issues.json")
            current: list[dict[str, Any]] = []
            if issues_path.exists():
                try:
                    doc = json.loads(issues_path.read_text("utf-8"))
                except ValueError as e:
                    raise JobError(
                        f"issues.json cannot be read ({e}); fix or restore it, then resume."
                    ) from e
                current = list(doc.get("issues") or [])
            map_path = ctx.out(f"{out_dir}/issues-map.json")
            old_map = json.loads(map_path.read_text("utf-8")) if map_path.exists() else None
            issues, new_map, counts = merge(current, old_map, props, now_iso())
            # records: which issue each defect became
            rec_path = ctx.stage("out/records.json")
            if rec_path.exists():
                rec = json.loads(rec_path.read_text("utf-8"))
                by_det = {d: iid for iid, e in new_map["issues"].items() for d in e.get("detections") or []}
                codes = {i["id"]: i.get("code") for i in issues}
                rec["issues"] = {}
                for f in rec.get("findings", []):
                    iid = by_det.get(f["key"])
                    if iid and f.get("defect"):
                        rec["issues"][f["defect"]] = {"id": iid, "code": codes.get(iid)}
                atomic_write_json(rec_path, rec)
            commit_files(ctx, [("out/records.json", f"{out_dir}/records.json")])
            # the map first: a crash before issues.json is written leaves a map that still names
            # every pipeline issue, and the next run recognises them by id
            atomic_write_json(map_path, new_map)
            if issues_path.exists():
                shutil.copyfile(issues_path, issues_path.with_name("issues.json.bak"))
            atomic_write_json(issues_path, {"schema": ISSUES_SCHEMA, "issues": issues}, indent=2)
            ctx.artifact("issues.json")
            ctx.log(
                f"Issues: {counts['new']} new, {counts['updated']} updated, {counts['unchanged']} unchanged, "
                f"{counts['kept_edited']} edited by a person and kept as they are, {counts['user']} others kept"
                + (
                    f", {counts['stale']} earlier ones no longer backed by detections (kept for review)"
                    if counts["stale"]
                    else ""
                )
            )
            return {**counts, "issues": len(issues)}

        return [
            Step("read", "Read the project", read, weight=1),
            Step("sheets", "Contact sheets", sheets, weight=2),
            Step("detections", "Read detections", detections, weight=0.5),
            Step("place", "Place detections on the model", place, weight=4),
            Step("cluster", "Group into issues and stats", cluster, weight=1),
            Step("commit", "Write to the project", commit, weight=0.3),
        ]


def uncertain_fixups(R: dict[str, Any], meta: dict[str, Any], profile: dict[str, Any]) -> None:
    """Uncertain detections are graded at the lowest level for the kit maths; count them apart."""
    from ..aik.records import outcome_label

    unc = {k for k, m in meta.items() if m.get("uncertain")}
    if not unc:
        R["stats"]["uncertain"] = 0
        return
    by_photo: dict[str, list[dict[str, Any]]] = {}
    for f in R["findings"]:
        f["uncertain"] = f["key"] in unc
        if f["uncertain"]:
            f["outcome"] = "u"
            f["label"] = profile["uncertain"]["label"]
        by_photo.setdefault(f["photo"], []).append(f)
    for p in R["photos"]:
        fs = by_photo.get(p["id"]) or []
        graded = [f for f in fs if not f["uncertain"]]
        if fs and not graded:
            p["outcome"] = "u"
            p["uflag"] = True
            p["label"] = outcome_label(profile, "u")
        elif graded:
            p["severity"] = max(f["severity"] for f in graded)
            p["outcome"] = str(p["severity"])
            p["label"] = outcome_label(profile, p["outcome"])
    from collections import Counter

    s = R["stats"]
    s["severity"] = {k: sum(1 for f in R["findings"] if not f["uncertain"] and str(f["severity"]) == k)
                     for k in s["severity"]}  # fmt: skip
    s["uncertain"] = sum(1 for f in R["findings"] if f["uncertain"])
    s["outcome"] = dict(Counter(p["outcome"] for p in R["photos"]))
    s["uncertain_only"] = sum(1 for p in R["photos"] if p["outcome"] == "u")


def layer_finder(model: Path, nodes: list[dict[str, str]]):
    """``points -> mesh layer ids``: the layer whose surface each kit-frame point lies on."""
    layers = sorted({n["layer"] for n in nodes})

    def find(points):
        if not points:
            return []
        if len(layers) == 1:
            return [layers[0]] * len(points)
        import numpy as np
        import trimesh

        sc = trimesh.load(model, force="scene")
        layer_by_node = {n["node"]: n["layer"] for n in nodes}
        best = np.full(len(points), np.inf)
        out = [layers[0]] * len(points)
        P = np.asarray(points, float)
        for node in sc.graph.nodes_geometry:
            T, gname = sc.graph[node]
            g = sc.geometry[gname].copy()
            g.apply_transform(T)
            _, dist, _ = trimesh.proximity.closest_point(g, P)
            for i, d in enumerate(dist):
                if d < best[i]:
                    best[i] = d
                    out[i] = layer_by_node.get(node, layers[0])
        return out

    return find
