"""Rebuild the 1st Ring Road with road.build and compare it with the imported project.

Read only: the source GeoTIFFs, shapefile, heatmap and centreline on the NAS, and the native
project's road.json. Everything is written to a temporary folder given on the command line.

    uv run python scripts/ringroad_rebuild.py <temp folder> [--from-km 3.0 --to-km 3.25]

The ortho is a section of the corridor (cut from the 1.25 cm blocks at 2.5 cm); the PCI runs on
the whole road (the delivered builder's inputs: shapefile, heatmap footprint, kit centreline), so
every sample unit can be compared with the delivered values.
"""

from __future__ import annotations

import argparse
import json
import math
import sys
import threading
import time
from pathlib import Path

import numpy as np

SRC = Path(r"\\DanNas\Work Data\MPW Roads\1st Ring Road")
NATIVE = Path(r"E:\Stratlas Data\projects\ringroad")
BLOCKS = ["1st Ring Road-Block 2.tif", "1st Ring Road-Block 1.tif"]  # the delivered drawing order


def crop_section(raw: Path, bbox: tuple[float, float, float, float], factor: int) -> list[str]:
    import rasterio
    from rasterio.enums import Resampling
    from rasterio.transform import Affine
    from rasterio.windows import Window, from_bounds

    out = []
    for name in BLOCKS:
        with rasterio.open(SRC / "Orthomosaic" / name) as d:
            from rasterio.errors import WindowError

            win = from_bounds(*bbox, d.transform).round_offsets().round_lengths()
            try:
                win = win.intersection(Window(0, 0, d.width, d.height))
            except WindowError:
                continue
            w, h = int(win.width) // factor, int(win.height) // factor
            data = d.read(window=win, out_shape=(4, h, w), resampling=Resampling.average)
            if not data[3].any():
                continue
            t = d.window_transform(win) * Affine.scale(win.width / w, win.height / h)
            path = raw / f"section-{name}"
            with rasterio.open(
                path,
                "w",
                driver="GTiff",
                width=w,
                height=h,
                count=4,
                dtype="uint8",
                crs=d.crs,
                transform=t,
                photometric="RGB",
                alpha="YES",
                tiled=True,
                compress="deflate",
            ) as o:
                o.write(data)
            out.append(str(path))
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("tmp")
    ap.add_argument("--from-km", type=float, default=3.0)
    ap.add_argument("--to-km", type=float, default=3.25)
    ap.add_argument("--factor", type=int, default=2, help="ortho reduction (2: 2.5 cm)")
    a = ap.parse_args()
    from aio_pipelines.road.pipeline import RoadBuild
    from aio_pipelines.runtime import Job

    tmp = Path(a.tmp)
    project, raw = tmp / "project", tmp / "raw"
    project.mkdir(parents=True, exist_ok=True)
    raw.mkdir(parents=True, exist_ok=True)
    native_m = json.loads((NATIVE / "manifest.json").read_text("utf-8"))
    native = json.loads((NATIVE / "road.json").read_text("utf-8"))
    ox, oy = native_m["origin"][0], native_m["origin"][1]
    manifest = {
        "schema": "aio.project/1",
        "id": "ringroad-rebuild",
        "name": "1st Ring Road (rebuild)",
        "crs": native_m["crs"],
        "origin": native_m["origin"],
        "captures": [],
        "layers": [],
        "severityModels": [],
        "classCatalogues": [],
        "type": "road",
    }
    (project / "manifest.json").write_text(json.dumps(manifest, indent=2))
    (project / "issues.json").write_text(json.dumps({"schema": "aio.issues/1", "issues": []}))

    pts = native["centreline"]["points"]
    ch = native["centreline"]["chainageKm"]
    sel = [(ox + p[0], oy - p[2]) for p, k in zip(pts, ch, strict=True) if a.from_km <= k <= a.to_km]
    xs, ys = [p[0] for p in sel], [p[1] for p in sel]
    bbox = (min(xs) - 30, min(ys) - 30, max(xs) + 30, max(ys) + 30)
    t0 = time.time()
    crops = crop_section(raw, bbox, a.factor)
    print(
        f"ortho section km {a.from_km} to {a.to_km}: {len(crops)} crop(s) in {time.time() - t0:.0f} s",
        flush=True,
    )

    params = {
        "ortho": crops,
        "centreline": str(SRC / "Road Review" / "_build" / "pci" / "centreline_utm.json"),
        "defects": str(SRC / "Shapefiles" / "1st Ring Road Defects.shp"),
        "pavement": str(SRC / "Heatmap" / "heatmap.tif"),
        "units": "grid",
        "name": "1st Ring Road",
    }

    def emit(method, p):
        if method == "log":
            print(f"  [{p.get('step', '')}] {p['message']}", flush=True)
        elif method == "error":
            print("ERROR", p, flush=True)

    t0 = time.time()
    Job("rebuild", RoadBuild(), project, params, emit, threading.Event()).run()
    print(f"road.build finished in {time.time() - t0:.0f} s", flush=True)

    built = json.loads((project / "road.json").read_text("utf-8"))
    report = compare(native, built)
    issues = json.loads((project / "issues.json").read_text("utf-8"))["issues"]
    native_issues = json.loads((NATIVE / "issues.json").read_text("utf-8"))["issues"]
    report["issues"] = {"built": len(issues), "native": len(native_issues)}
    by_code = {i["code"]: i for i in native_issues}
    report["issues"]["sameClassAndSeverity"] = sum(
        1
        for i in issues
        if (n := by_code.get(i["code"])) and n["classId"] == i["classId"] and n["severity"] == i["severity"]
    )
    report["closeups"] = sum(1 for i in issues if any(s["on"] == "image" for s in i["sightings"]))
    (tmp / "comparison.json").write_text(json.dumps(report, indent=1))
    print(json.dumps(report, indent=1))
    return 0


def compare(native: dict, built: dict) -> dict:
    nu = {u["id"]: u for u in native["pci"]["units"]}
    bu = {u["id"]: u for u in built["pci"]["units"]}
    common = sorted(set(nu) & set(bu))
    sev = ("low", "medium", "high")
    diff = {s: [] for s in sev}
    for k in common:
        for s in sev:
            diff[s].append(abs((bu[k]["pci"][s] or 0) - (nu[k]["pci"][s] or 0)))
    pav = [abs(bu[k]["pavementM2"] - nu[k]["pavementM2"]) for k in common]
    km = [abs(bu[k]["km"] - nu[k]["km"]) for k in common]
    cells = sum(1 for k in common if sorted(map(tuple, bu[k]["cells"])) == sorted(map(tuple, nu[k]["cells"])))
    ded = sum(
        1
        for k in common
        if [(d["distress"], d["densityPct"], d["deduct"]) for d in bu[k]["deducts"]]
        == [(d["distress"], d["densityPct"], d["deduct"]) for d in nu[k]["deducts"]]
    )
    worst = sorted(common, key=lambda k: -max(diff[s][common.index(k)] for s in sev))[:5]
    secs = list(zip(native["pci"]["sections"], built["pci"]["sections"], strict=False))
    dens = {
        size: {
            "native": len(native["density"]["sizes"].get(size, [])),
            "built": len(built["density"]["sizes"].get(size, [])),
            "identical": native["density"]["sizes"].get(size) == built["density"]["sizes"].get(size),
        }
        for size in ("10", "20", "50")
    }
    return {
        "units": {"native": len(nu), "built": len(bu), "common": len(common)},
        "onlyNative": sorted(set(nu) - set(bu))[:20],
        "onlyBuilt": sorted(set(bu) - set(nu))[:20],
        "pciExact": {s: sum(1 for d in diff[s] if d == 0) for s in sev},
        "pciMaxAbsDiff": {s: max(diff[s], default=0) for s in sev},
        "pciMeanAbsDiff": {s: round(float(np.mean(diff[s])), 4) if diff[s] else 0 for s in sev},
        "pavementMaxAbsDiffM2": max(pav, default=0),
        "kmMaxAbsDiff": max(km, default=0),
        "sameCells": cells,
        "sameDeducts": ded,
        "worstUnits": [{"id": k, "native": nu[k]["pci"], "built": bu[k]["pci"]} for k in worst],
        "network": {"native": native["pci"]["network"], "built": built["pci"]["network"]},
        "coveragePct": {"native": native["pci"].get("coveragePct"), "built": built["pci"].get("coveragePct")},
        "sectionsSame": sum(
            1
            for n, b in secs
            if n["pci"] == b["pci"] and math.isclose(n["pavementM2"] or 0, b["pavementM2"] or 0)
        ),
        "sections": {"native": len(native["pci"]["sections"]), "built": len(built["pci"]["sections"])},
        "density": dens,
    }


if __name__ == "__main__":
    sys.exit(main())
