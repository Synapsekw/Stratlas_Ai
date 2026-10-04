"""Regenerate Masafi with volumetric.build and compare its volumes with the delivered project.

    uv run python scripts/verify_masafi_build.py <empty work folder> [data root]

Reads (never writes) ``<data root>/sources/masafi`` (the kit job, its 10 cm DSM grids
``work/dsm_<e>.npy`` and its ortho tiles) and ``<data root>/projects/masafi/volumes.json``.
The raw Pix4D GeoTIFFs are not in the source folder, so the script writes the kit's own DSM grids
back out as GeoTIFFs on the job grid (lossless: the resample of a grid-aligned 0.1 m raster is
the identity) and mosaics the 6 cm tile level into an RGBA ortho GeoTIFF. Then it runs the
pipeline into ``<work>/project`` with the kit job's grid (ortho at 6 cm), yard polygon, clip line
and exclusion, and prints every pile, date and base against the delivered figures.
"""

from __future__ import annotations

import json
import re
import sys
import threading
import time
from pathlib import Path

import numpy as np
import rasterio
from PIL import Image
from rasterio.transform import from_origin
from rasterio.windows import Window

from aio_pipelines.runtime import Job
from aio_pipelines.volumetric.build import VolumetricBuild

ORTHO_Z, ORTHO_RES = 4, 0.06


def sources(src: Path, out: Path, kit: dict) -> None:
    G = kit["grid"]
    out.mkdir(parents=True, exist_ok=True)
    for e in kit["epochs"]:
        eid = e["id"]
        dsm = out / f"{eid}_dsm.tif"
        if not dsm.exists():
            a = np.load(src / "work" / f"dsm_{eid}.npy", mmap_mode="r")
            with rasterio.open(
                dsm,
                "w",
                driver="GTiff",
                height=a.shape[0],
                width=a.shape[1],
                count=1,
                dtype="float32",
                crs=kit["crs"],
                transform=from_origin(G["x0"], G["y1"], G["dsm_res"], G["dsm_res"]),
                nodata=-10000.0,
                tiled=True,
                compress="deflate",
            ) as d:
                for r0 in range(0, a.shape[0], 512):
                    blk = np.asarray(a[r0 : r0 + 512])
                    d.write(
                        np.where(np.isnan(blk), -10000.0, blk).astype(np.float32),
                        1,
                        window=Window(0, r0, a.shape[1], blk.shape[0]),
                    )
        ortho = out / f"{eid}_ortho.tif"
        if not ortho.exists():
            tdir = src / "tiles" / eid / str(ORTHO_Z)
            W = round((G["x1"] - G["x0"]) / ORTHO_RES)
            H = round((G["y1"] - G["y0"]) / ORTHO_RES)
            with rasterio.open(
                ortho,
                "w",
                driver="GTiff",
                height=H,
                width=W,
                count=4,
                dtype="uint8",
                crs=kit["crs"],
                transform=from_origin(G["x0"], G["y1"], ORTHO_RES, ORTHO_RES),
                tiled=True,
                compress="deflate",
            ) as d:
                for f in tdir.glob("*.webp"):
                    x, y = map(int, f.stem.split("_"))
                    with Image.open(f) as im:
                        t = np.asarray(im.convert("RGBA"))
                    w, h = min(1024, W - x * 1024), min(1024, H - y * 1024)
                    if w > 0 and h > 0:
                        d.write(np.moveaxis(t[:h, :w], -1, 0), window=Window(x * 1024, y * 1024, w, h))


def build(kit: dict, raw: Path, project: Path, ref_manifest: dict) -> None:
    project.mkdir(parents=True, exist_ok=True)
    m = {k: ref_manifest[k] for k in ("schema", "site", "crs", "origin", "severityModels", "classCatalogues")}
    m |= {"id": "masafi-rebuilt", "name": "Masafi rebuilt", "captures": [], "layers": []}
    (project / "manifest.json").write_text(json.dumps(m, indent=2), "utf-8")
    (project / "issues.json").write_text('{"schema":"aio.issues/1","issues":[]}', "utf-8")
    epochs = []
    for e in kit["epochs"]:
        r = {k: v for k, v in e.items() if k not in ("dsm", "ortho", "report")}
        epochs.append(
            r | {"dsm": str(raw / f"{e['id']}_dsm.tif"), "ortho": str(raw / f"{e['id']}_ortho.tif")}
        )
    config = {
        "grid": {**kit["grid"], "ortho_res": ORTHO_RES, "zmax": ORTHO_Z},
        "epochs": epochs,
        "volume": kit["volume"],
        "detect": kit["detect"],
        "title": kit["title"],
    }
    t0 = time.time()

    def emit(method, msg):
        if method == "log":
            print(f"[{time.time() - t0:6.1f} s] {msg.get('step', '')}: {msg['message']}", flush=True)

    Job("rebuild", VolumetricBuild(), project, {"config": config}, emit, threading.Event()).run()


def compare(ref: dict, new: dict, site: dict) -> float:
    R = {p["id"]: p for p in ref["piles"]}
    N = {p["id"]: p for p in new["piles"]}
    K = {p["id"]: p for p in site["piles"]}
    assert sorted(R) == sorted(N), (sorted(R), sorted(N))
    worst = worst_kit = 0.0
    print("| Pile | Date | tin ref | tin rebuilt | plane | avg | low | max diff (12 figures) |")
    print("| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |")
    for pid in sorted(R):
        for e in sorted(R[pid]["epochs"]):
            a, b = R[pid]["epochs"][e]["volumes"], N[pid]["epochs"][e]["volumes"]
            k = K[pid]["epochs"][e]["vol"]
            d = max(abs(a[x][y] - b[x][y]) for x in a for y in ("fill", "cut", "net"))
            for x in a:
                for y in ("fill", "cut", "net"):
                    worst = max(worst, abs(a[x][y] - b[x][y]) / max(abs(a[x][y]), 10))
                    worst_kit = max(worst_kit, abs(k[x][y] - b[x][y]) / max(abs(k[x][y]), 10))
            print(
                f"| {pid} | {e} | {a['tin']['net']:,.1f} | {b['tin']['net']:,.1f} | {b['plane']['net']:,.1f} "
                f"| {b['avg']['net']:,.1f} | {b['low']['net']:,.1f} | {d:.1f} |"
            )
    ch = max(abs(R[p]["change"][k] - N[p]["change"][k]) for p in R for k in ("fill", "cut", "net"))
    chk = max(abs(K[p]["change"][k] - N[p]["change"][k]) for p in R for k in ("fill", "cut", "net"))
    print(
        f"largest relative volume difference: {worst:.6f} vs volumes.json, {worst_kit:.6f} vs the kit's site.js"
    )
    print(f"largest change difference: {ch:.1f} m3 vs volumes.json, {chk:.1f} m3 vs site.js")
    for e in ref["totals"]:
        print("totals", e, {b: (ref["totals"][e][b], new["totals"][e][b]) for b in ref["totals"][e]})
    return worst


def main() -> None:
    work = Path(sys.argv[1])
    data = Path(sys.argv[2] if len(sys.argv) > 2 else "E:/Stratlas Data")
    src = data / "sources" / "masafi"
    kit = json.loads((src / "job.json").read_text("utf-8"))
    ref_dir = data / "projects" / "masafi"
    sources(src, work / "sources", kit)
    project = work / "project"
    if not (project / "volumes.json").exists():
        build(kit, work / "sources", project, json.loads((ref_dir / "manifest.json").read_text("utf-8")))
    ref = json.loads((ref_dir / "volumes.json").read_text("utf-8"))
    new = json.loads((project / "volumes.json").read_text("utf-8"))
    site_js = (src / "data" / "site.js").read_text("utf-8").strip()
    site = json.loads(re.sub(r"^window\.VS_SITE=|;\s*$", "", site_js))
    compare(ref, new, site)


if __name__ == "__main__":
    main()
