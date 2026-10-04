"""Canonical photo and finding records and the analytics every output uses.

Ported from Asset Inspection Kit ``kit/records.py``. Inputs (job-relative): cameras.json,
assessment.json, masks/<id>.png, surface.json, model.glb.
"""

from __future__ import annotations

import json
import math
import os
import re
from collections import Counter, OrderedDict

import numpy as np

from . import masks as M

COMPASS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"]
NO_SIDE = "—"


def load_json(p, default=None):
    if p and os.path.exists(p):
        with open(p, encoding="utf-8") as f:
            return json.load(f)
    return default


def mesh_info(glb_path, bins=160):
    """Asset height and a radial silhouette [(y, r)] computed from the model."""
    import trimesh

    sc = trimesh.load(glb_path, force="scene")
    verts = []
    for node in sc.graph.nodes_geometry:
        T, gname = sc.graph[node]
        g = sc.geometry[gname]
        if not hasattr(g, "vertices") or len(g.vertices) == 0:
            continue
        v = np.c_[g.vertices, np.ones(len(g.vertices))] @ T.T
        verts.append(v[:, :3])
    V = np.vstack(verts)
    y0, y1 = float(V[:, 1].min()), float(V[:, 1].max())
    r = np.hypot(V[:, 0], V[:, 2])
    edges = np.linspace(min(0.0, y0), y1, bins + 1)
    idx = np.clip(np.digitize(V[:, 1], edges) - 1, 0, bins - 1)
    prof = []
    for b in range(bins):
        rb = r[idx == b]
        if len(rb):
            prof.append(((edges[b] + edges[b + 1]) / 2, float(np.percentile(rb, 92))))
    ys = [p[0] for p in prof]
    rs = np.array([p[1] for p in prof])
    if len(rs) > 5:
        rs = np.convolve(np.pad(rs, 2, mode="edge"), np.ones(5) / 5, mode="valid")
    return {
        "height": y1,
        "base": y0,
        "silhouette": [[round(y, 3), round(float(rr), 3)] for y, rr in zip(ys, rs, strict=False)],
    }


def resolve_zones(profile, asset, H):
    """Zones in metres, top first. job.asset.zones uses min/max metres; profile zones use height fractions."""
    if asset.get("zones"):
        return [
            {
                "id": z["id"],
                "label": z["label"],
                "min": -1e9 if z.get("min") is None else float(z["min"]),
                "max": 1e9 if z.get("max") is None else float(z["max"]),
            }
            for z in asset["zones"]
        ]
    return [
        {
            "id": z["id"],
            "label": z["label"],
            "min": (-1e9 if z["from"] <= 0 else z["from"] * H),
            "max": (1e9 if z["to"] >= 1 else z["to"] * H),
        }
        for z in profile["zones"]
    ]


def zone_of(zones, h):
    for z in zones:
        if z["min"] <= h < z["max"]:
            return z
    return zones[0] if h >= zones[0]["min"] else zones[-1]


def side_of(profile, asset, bearing):
    if bearing is None:
        return NO_SIDE
    s = profile.get("sides", {"type": "compass"})
    if s.get("type") == "faces":
        az = float(asset.get("line_azimuth_deg", 0))
        labels = s["labels"]
        k = len(labels)
        rel = (bearing - az) % 360
        return labels[round(rel / (360 / k)) % k]
    return COMPASS[round(bearing / 45) % 8]


def outcome_label(profile, outcome):
    if outcome == "na":
        return profile["not_assessed"]["label"]
    if outcome == "u":
        return profile["uncertain"]["label"]
    if outcome == "0":
        return profile["none"]["label"]
    lv = {str(s["level"]): s for s in profile["severity"]}
    return lv[outcome]["label"]


def build(job):
    prof, asset = job.profile, job.asset
    cams = load_json(job.p(job.inputs.get("cameras", "cameras.json")))
    if cams is None:
        from ..runtime import JobError

        raise JobError("The kit job has no cameras.json. Run Cameras from photos first.")
    ass = load_json(job.p(job.inputs.get("assessment", "assessment.json")), {"photos": {}, "findings": []})
    surf = load_json(job.p(job.inputs.get("surface", "surface.json")), {"patches": []})
    mask_dir = job.p(job.inputs.get("masks", "masks"))
    glb = job.p(job.inputs.get("model", "model.glb"))
    mi = (
        mesh_info(glb)
        if glb and os.path.exists(glb)
        else {"height": asset.get("height", 50), "silhouette": []}
    )
    H = float(asset.get("height") or mi["height"])
    zones = resolve_zones(prof, asset, H)
    classes = {c["id"]: c for c in prof["classes"]}
    class_by_key = {c["key"]: c for c in prof["classes"]}
    sev = {s["level"]: s for s in prof["severity"]}

    photos = []
    pa_by_photo = {}
    for pa in surf.get("patches", []):
        pa_by_photo.setdefault(pa["photo"], []).append(pa)
    for c in cams["photos"]:
        a = ass["photos"].get(c["id"], {"status": "not-assessed"})
        mp = os.path.join(mask_dir, c["id"] + ".png") if mask_dir else None
        ms = M.stats(M.load(mp), prof) if mp and os.path.exists(mp) else None
        rec = dict(c)
        rec.update(
            {
                "status": a.get("status", "not-assessed"),
                "note": a.get("note", ""),
                "mask": bool(ms),
                "coverage": a.get("coverage", ms["coverage"] if ms else 0.0),
                "uncertain": a.get("uncertain", ms["uncertain"] if ms else 0.0),
                "mask_bbox": ms["bbox"] if ms else None,
                "mask_severity": ms["mask_severity"] if ms else 0,
                "severity": a.get("severity", 0),
                "findings": [],
            }
        )
        if ms:
            rec["previewWidth"], rec["previewHeight"] = ms["width"], ms["height"]
        else:
            fp = job.p(c.get("file") or f"photos/{c['id']}.jpg")
            if os.path.exists(fp):
                from PIL import Image

                with Image.open(fp) as im:
                    rec["previewWidth"], rec["previewHeight"] = im.size
        photos.append(rec)
    by_id = OrderedDict((p["id"], p) for p in photos)

    # findings: explicit list, else one per photo with a finding status (photo unit)
    raw = list(ass.get("findings") or [])
    if not raw and prof["finding_unit"] == "photo":
        for p in photos:
            if p["status"] == "finding":
                raw.append({"id": p["id"], "photo": p["id"], "severity": p["severity"] or p["mask_severity"]})
    pts = {pt["finding"]: pt for pt in surf.get("points", [])}
    F = []
    for i, f in enumerate(raw):
        p = by_id.get(f["photo"])
        if not p:
            continue
        cl = f.get("class")
        cdef = class_by_key.get(cl) if isinstance(cl, str) else classes.get(cl) if cl is not None else None
        s = int(f.get("severity") or (cdef or {}).get("severity") or p["severity"] or p["mask_severity"] or 1)
        rec = {
            "key": f.get("id") or f"{p['id']}#{i}",
            "photo": p["id"],
            "severity": s,
            "outcome": str(s),
            "label": sev[s]["label"],
            "class": (cdef or {}).get("key"),
            "classLabel": (cdef or {}).get("label", ""),
            "bbox": f.get("bbox") or p["mask_bbox"],
            "note": f.get("note") or p["note"],
            "component": f.get("component"),
            "component_given": f.get("component"),
            "confidence": f.get("confidence"),
            "placement": "none",
            "center": f.get("center"),
            "normal": f.get("normal"),
        }
        pats = [
            x
            for x in pa_by_photo.get(p["id"], [])
            if x.get("finding") == rec["key"] or ("finding" not in x and prof["finding_unit"] == "photo")
        ]
        pt = pts.get(rec["key"])
        if pt and rec["center"] is None:
            rec["center"], rec["normal"] = pt["center"], pt.get("normal")
            rec["component"] = rec["component"] or pt.get("component")
        if pats and prof["placement"] == "patch":
            pa = pats[0]
            if not f.get("bbox") and pa.get("sourceCrop"):
                rec["bbox"] = pa["sourceCrop"]
            rec.update(
                {
                    "placement": "patch",
                    "center": pa["center"],
                    "normal": pa.get("direction"),
                    "component": rec["component"] or pa.get("component"),
                    "patch": pa,
                }
            )
        elif rec["center"] is not None:
            rec["placement"] = "point"
        if rec["center"] is not None:
            cx, cy, cz = rec["center"]
            rec["height"] = cy
            rec["bearing"] = (math.degrees(math.atan2(cz, cx)) + 360) % 360
        else:
            rec["height"] = p["target"][1]
            rec["bearing"] = None
        rec["mapped"] = rec["placement"] != "none"
        z = zone_of(zones, rec["height"])
        rec["zone"] = z["id"]
        rec["zoneLabel"] = z["label"]
        rec["side"] = side_of(prof, asset, rec["bearing"])
        rec["component"] = (
            rec["component"] or (p.get("subject") if prof["finding_unit"] == "photo" else None) or z["label"]
        )
        if rec["bbox"] and p["mask"] and prof["finding_unit"] == "region":
            rec["coverage"] = M.region_coverage(
                M.load(os.path.join(mask_dir, p["id"] + ".png")), prof, rec["bbox"]
            )
        elif rec["bbox"] and prof["finding_unit"] == "region":
            W = p.get("previewWidth") or 2560
            Hh = p.get("previewHeight") or round(W * p["height"] / p["width"])
            x0, y0, x1, y1 = rec["bbox"]
            rec["coverage"] = 100.0 * (x1 - x0) * (y1 - y0) / (W * Hh)
        else:
            rec["coverage"] = p["coverage"]
        F.append(rec)
    # group repeat sightings: placed findings of the same class within cluster_m are one defect
    if prof["finding_unit"] == "region":
        cm = float(prof.get("cluster_m") or max(0.75, H * 0.02))
        placed = [f for f in F if f["center"] is not None]
        parent = list(range(len(placed)))

        def find(i):
            while parent[i] != i:
                parent[i] = parent[parent[i]]
                i = parent[i]
            return i

        for i in range(len(placed)):
            for j in range(i + 1, len(placed)):
                a, b = placed[i], placed[j]
                if a["class"] == b["class"] and math.dist(a["center"], b["center"]) <= cm:
                    parent[find(i)] = find(j)
        groups = {}
        for i, f in enumerate(placed):
            groups.setdefault(find(i), []).append(f)
        for f in F:
            if f["center"] is None:
                groups[("u", f["key"])] = [f]
        order = sorted(groups.values(), key=lambda g: -max(x["height"] for x in g))
        for k, g in enumerate(order):
            for f in g:
                f["defect"] = f"D{k + 1:02d}"
                f["sightings"] = len(g)
    # number findings from the top of the asset down
    F.sort(key=lambda r: (-r["height"], -r["severity"], r["photo"]))
    width = max(2, len(str(len(F))))
    for i, r in enumerate(F):
        r["fid"] = "F" + str(i + 1).zfill(width)
        if r.get("patch"):
            r["patch"]["fid"] = r["fid"]
        by_id[r["photo"]]["findings"].append(r["fid"])

    # photo outcome
    for p in photos:
        fs = [f for f in F if f["photo"] == p["id"]]
        if fs:
            p["severity"] = max(f["severity"] for f in fs)
            p["outcome"] = str(p["severity"])
        elif p["status"] == "not-assessed":
            p["outcome"] = "na"
        elif p["status"] == "uncertain" or ((p["uncertain"] or 0) > 0 and p["status"] != "none"):
            p["outcome"] = "u"
        else:
            p["outcome"] = "0"
        p["uflag"] = p["outcome"] == "u" or (p["uncertain"] or 0) > 0
        p["label"] = outcome_label(prof, p["outcome"])
        z = zone_of(zones, p["target"][1])
        p["zone"] = z["id"]
        p.pop("mask_bbox", None)

    # sequences (flights)
    seqs = OrderedDict()
    for p in photos:
        s = str(p.get("sequence", "1"))
        if s not in seqs:
            seqs[s] = {"id": s, "label": (job.raw.get("sequences", {}) or {}).get(s, "Flight " + s), "n": 0}
        seqs[s]["n"] += 1
    palette = ["#86cefb", "#f2c270", "#9ddbc6", "#f59fbf", "#c3b1ff", "#a6d96a", "#fdae61"]
    for i, s in enumerate(seqs.values()):
        s["color"] = palette[i % len(palette)]

    times = sorted(p["time"] for p in photos if p.get("time"))
    stats = {
        "photos": len(photos),
        "defects": len({f.get("defect") for f in F if f.get("defect")}) or None,
        "assessed": sum(1 for p in photos if p["outcome"] != "na"),
        "outcome": dict(Counter(p["outcome"] for p in photos)),
        "findings": len(F),
        "photos_with_findings": sum(1 for p in photos if p["findings"]),
        "severity": {str(k): sum(1 for f in F if f["severity"] == k) for k in sev},
        "zone": OrderedDict((z["id"], sum(1 for f in F if f["zone"] == z["id"])) for z in zones),
        "component": OrderedDict(Counter(f["component"] for f in F).most_common()),
        "class": OrderedDict(Counter(f["classLabel"] for f in F if f["classLabel"]).most_common()),
        "mapped": sum(1 for f in F if f["mapped"]),
        "uncertain_only": sum(1 for p in photos if p["outcome"] == "u"),
        "time_first": times[0] if times else None,
        "time_last": times[-1] if times else None,
    }
    return {
        "photos": photos,
        "findings": F,
        "patches": surf.get("patches", []),
        "zones": zones,
        "height": H,
        "silhouette": asset.get("silhouette") or mi["silhouette"],
        "levels": asset.get("levels", []),
        "sequences": list(seqs.values()),
        "stats": stats,
        "unmapped": surf.get("unmapped", []),
    }


def csv_text(R):
    head = [
        "finding_id", "defect_id", "photo_id", "file_name", "severity", "severity_label", "class", "component",
        "zone", "height_m_approx", "side_approx", "bearing_deg_approx", "placed_on_model", "coverage_pct_of_photo",
        "note", "subject", "flight", "captured", "gps_lat", "gps_lon", "gps_alt_m",
    ]  # fmt: skip

    def q(v):
        if v is None:
            return ""
        s = str(v)
        return '"' + s.replace('"', '""') + '"' if re.search(r'[",\n]', s) else s

    by = {p["id"]: p for p in R["photos"]}
    rows = [",".join(head)]
    for f in R["findings"]:
        p = by[f["photo"]]
        rows.append(
            ",".join(
                q(v)
                for v in [
                    f["fid"],
                    f.get("defect"),
                    p["id"],
                    p["name"],
                    f["severity"],
                    f["label"],
                    f["classLabel"],
                    f["component"],
                    f["zoneLabel"],
                    f"{f['height']:.2f}",
                    f["side"],
                    "" if f["bearing"] is None else f"{f['bearing']:.0f}",
                    "yes" if f["mapped"] else "no",
                    f"{f['coverage']:.4f}",
                    f["note"],
                    p.get("subject"),
                    p.get("sequence"),
                    p.get("time"),
                    p.get("latitude"),
                    p.get("longitude"),
                    p.get("altitude"),
                ]
            )
        )
    for p in R["photos"]:  # photos without findings, for completeness
        if p["findings"]:
            continue
        rows.append(
            ",".join(
                q(v)
                for v in [
                    "",
                    "",
                    p["id"],
                    p["name"],
                    "",
                    p["label"],
                    "",
                    "",
                    "",
                    f"{p['target'][1]:.2f}",
                    "",
                    "",
                    "no",
                    f"{p.get('coverage') or 0:.4f}",
                    p.get("note"),
                    p.get("subject"),
                    p.get("sequence"),
                    p.get("time"),
                    p.get("latitude"),
                    p.get("longitude"),
                    p.get("altitude"),
                ]
            )
        )
    return "\ufeff" + "\r\n".join(rows) + "\r\n"


def summary(R):
    """records.json: the analytics without the heavy patch textures."""
    findings = [{k: v for k, v in f.items() if k != "patch"} for f in R["findings"]]
    return {
        "schema": "aio.aik-records/1",
        "stats": R["stats"],
        "height": R["height"],
        "zones": R["zones"],
        "sequences": R["sequences"],
        "unmapped": R["unmapped"],
        "findings": findings,
    }
