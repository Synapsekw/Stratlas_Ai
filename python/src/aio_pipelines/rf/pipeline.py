"""rf.coverage: signal strength (RSRP) around a telecom site (spec D12 to D18).

Parameters as ``RfCoverageParams`` in packages/schema/src/jobs.ts: ``runId``, optional
``sectorIds``, ``includeUnreviewed`` and ``reusePathLoss``. Inputs are the project's own files
(``inputs.py``): the antenna inventory, the RF sectors file and the project catalogue.

Steps:

1. **predict** builds the grid in the project CRS around the site (``grid.py``), computes the
   path loss once per antenna and frequency (flat ground, D17), then the pattern and link-budget
   terms per carrier (D13, D15), and the composite views (D18): RSRP = max over sectors (a sector
   is the max over its carriers), best server = the 0-based index into
   ``run.inputs.sectors.sectors``, overlap = sectors within 6 dB of the best (the best included).
   Everything is written into a folder in the job's staging area, ``run.json`` last.
2. **commit** renames that folder to ``rf/runs/<runId>/`` in one step, so a cancel or a crash never
   leaves a partial run where the app looks for runs.

Run folder (read by apps/desktop/src/main/rf.ts and rf/export.ts):

- ``run.json`` (``aio.rf-run/1``);
- ``rsrp.tif``, ``best-server.tif``, ``overlap.tif``: single band, uncompressed, striped, classic
  TIFF, Float32, the run grid's size, georeferenced in the project CRS. ``grid.nodata`` is
  ``NODATA`` in every one; overlap is 0 where no sector reaches;
- ``pathloss/``: one headerless little-endian Float32 grid per antenna and frequency (dB, NaN
  outside the study radius of that antenna, the live preview's cache, D15) and ``index.json``
  naming each grid's antenna, carriers, frequency, heights and model. Packaging leaves it out
  (its name starts ``pathloss``).

Processing runs in row blocks, so memory stays bounded at 15 km and 5 m; the path-loss grids are
read back through memory maps.
"""

from __future__ import annotations

import hashlib
import json
import re
import shutil
import time
from pathlib import Path
from typing import Any

import numpy as np

from ..params import known_keys
from ..runtime import JobError, Step, StepContext, atomic_write_json, now_iso, replace_over, safe_project_path
from . import budget, inputs, propagation
from .grid import Grid, antenna_angles, build_grid
from .pattern import pattern_loss_db

RUN_SCHEMA = "aio.rf-run/1"
RUNS_DIR = "rf/runs"
RUN_ID = re.compile(r"^rf-[a-z0-9-]{1,60}$")
SECTOR_ID = re.compile(r"^sec-[a-z0-9-]{1,60}$")
NODATA = -9999.0
OVERLAP_WINDOW_DB = 6.0
PATHLOSS_DIR = "pathloss"
OUTPUTS = {"rsrp": "rsrp.tif", "bestServer": "best-server.tif", "overlap": "overlap.tif"}
STAGED = "run"
#: Rows per processing block.
BLOCK_ROWS = 256
MAX_WARNINGS = 200


def _crs_name(manifest: dict[str, Any]) -> str:
    crs = manifest.get("crs") or {}
    if isinstance(crs.get("epsg"), int):
        return f"EPSG:{crs['epsg']}"
    return "project"


def write_grid(path: Path, data: np.ndarray, g: Grid, nodata: float, crs: Any) -> None:
    """A single band, uncompressed, striped, classic Float32 GeoTIFF (what the app's reader takes)."""
    import rasterio
    from rasterio.transform import from_origin

    profile = {
        "driver": "GTiff",
        "width": g.width,
        "height": g.height,
        "count": 1,
        "dtype": "float32",
        "transform": from_origin(g.origin_e, g.origin_n, g.res, g.res),
        "nodata": nodata,
        "tiled": False,
        "BIGTIFF": "NO",
    }
    if crs is not None:
        profile["crs"] = crs
    with rasterio.open(path, "w", **profile) as ds:
        ds.write(data.astype(np.float32, copy=False), 1)


def _key(setup: propagation.Setup, east: float, north: float, g: Grid, radius: float) -> str:
    blob = json.dumps(
        [
            setup.model,
            setup.environment,
            setup.hata_area,
            setup.frequency_mhz,
            setup.h_bs_m,
            setup.h_ut_m,
            east,
            north,
            g.origin_e,
            g.origin_n,
            g.width,
            g.height,
            g.res,
            radius,
        ],
        separators=(",", ":"),
    )
    return hashlib.sha256(blob.encode()).hexdigest()[:24]


def _earlier_path_loss(project: Path, own: str) -> dict[str, Path]:
    """Path-loss grids of earlier runs by key, newest run last (so it wins)."""
    found: dict[str, tuple[float, Path]] = {}
    runs = project / RUNS_DIR
    if not runs.is_dir():
        return {}
    for d in runs.iterdir():
        if not d.is_dir() or d.name == own:
            continue
        try:
            run = json.loads((d / "run.json").read_text("utf-8"))
            pdir = d / str((run.get("outputs") or {}).get("pathLossDir") or PATHLOSS_DIR)
            index = json.loads((pdir / "index.json").read_text("utf-8"))
            at = (d / "run.json").stat().st_mtime
        except (OSError, ValueError, AttributeError):
            continue
        for item in index.get("grids") or []:
            f = pdir / str(item.get("file"))
            k = item.get("key")
            if isinstance(k, str) and f.is_file() and (k not in found or found[k][0] < at):
                found[k] = (at, f)
    return {k: p for k, (_, p) in found.items()}


def _dedupe(items: list[str]) -> list[str]:
    seen: dict[str, None] = {}
    for w in items:
        seen.setdefault(w[:500], None)
    out = list(seen)
    if len(out) > MAX_WARNINGS:
        out = [*out[: MAX_WARNINGS - 1], f"{len(out) - MAX_WARNINGS + 1} more warnings are not shown."]
    return out


class RfCoverage:
    name = "rf.coverage"
    title = "Predicting coverage"
    description = (
        "Signal strength (RSRP) around a telecom site from the antenna units and their RF settings: path loss "
        "per sector, then composite, best server and overlap grids. Flat ground, no buildings."
    )

    def validate(self, params: dict[str, Any]) -> dict[str, Any]:
        known_keys(params, {"runId", "sectorIds", "includeUnreviewed", "reusePathLoss"}, self.name)
        rid = params.get("runId")
        if not isinstance(rid, str) or not RUN_ID.match(rid):
            raise JobError("runId must be an RF run id (rf- then lower-case letters, digits or dashes).")
        sids = params.get("sectorIds")
        if sids is not None and (
            not isinstance(sids, list)
            or not 1 <= len(sids) <= 64
            or not all(isinstance(s, str) and SECTOR_ID.match(s) for s in sids)
        ):
            raise JobError("sectorIds must be a list of 1 to 64 sector ids.")
        for k in ("includeUnreviewed", "reusePathLoss"):
            if k in params and not isinstance(params[k], bool):
                raise JobError(f"{k} must be true or false.")
        return dict(params)

    def inputs(self, params: dict[str, Any]) -> list[str]:
        return [inputs.ANTENNAS_PATH, inputs.SECTORS_PATH, inputs.CATALOGUE_PATH]

    def plan(self, params: dict[str, Any]) -> list[Step]:
        return [
            Step("predict", "Predicting coverage", self._predict, weight=0.95),
            Step("commit", "Saving the run", self._commit, weight=0.05),
        ]

    # ------------------------------------------------------------------------------------- predict

    def _predict(self, ctx: StepContext) -> dict[str, Any]:
        from ..change.imagery import project_crs, read_manifest

        t0 = time.perf_counter()
        p = ctx.params
        run_id = p["runId"]
        if ctx.out(f"{RUNS_DIR}/{run_id}").exists():
            raise JobError(f"A coverage run {run_id} already exists in this project. Start a new run.")
        manifest = read_manifest(ctx.project)
        sectors_file = inputs.read_sectors(ctx.project)
        study = inputs.study_of(sectors_file)
        antennas_file = inputs.read_antennas(ctx.project)
        catalogue = inputs.read_catalogue(ctx.project)
        r = inputs.resolve(
            ctx.project,
            manifest,
            sectors_file,
            antennas_file,
            catalogue,
            p.get("sectorIds"),
            bool(p.get("includeUnreviewed")),
        )
        warns = list(r.warnings)
        ctx.check()

        res = float(study["gridResolutionM"])
        radius = float(study["radiusM"])
        hut = float(study["ueHeightM"])
        model, env = str(study["model"]), str(study["environment"])

        # one path-loss grid per antenna and frequency; refused setups leave their carriers out
        setups: dict[tuple[str, float], propagation.Setup] = {}
        refused: list[str] = []
        sources = []
        for s in r.sources:
            k = (s.antenna_id, s.frequency_mhz)
            if k not in setups:
                setup = propagation.Setup(model, env, s.frequency_mhz, s.height_m, hut, None)
                why = propagation.refusal(setup)
                if why is not None:
                    refused.append(f"{s.antenna_id}: {why['message']}")
                    setups[k] = None  # type: ignore[assignment]
                    continue
                setups[k] = setup
                warns += propagation.warnings(setup, radius)
            if setups[k] is not None:
                sources.append(s)
        if not sources:
            first = refused[0].split(": ", 1)[1] if refused else "nothing can be computed."
            raise JobError(first)
        warns += refused

        centres = {s.antenna_id: (s.east, s.north) for s in sources}
        ce = sum(e for e, _ in centres.values()) / len(centres)
        cn = sum(n for _, n in centres.values()) / len(centres)
        g = build_grid(ce, cn, radius, res)
        if max(g.width, g.height) > 20_000:
            raise JobError("The grid is too large: use a coarser resolution or a smaller radius.")

        staged = ctx.stage(f"{STAGED}/.keep").parent
        if staged.exists():
            shutil.rmtree(staged)
        pdir = staged / PATHLOSS_DIR
        pdir.mkdir(parents=True)

        # ---- path loss (D15): distance, frequency and heights only
        t_pl = time.perf_counter()
        earlier = _earlier_path_loss(ctx.project, run_id) if p.get("reusePathLoss") else {}
        cols = g.column_east()
        index_rows: list[dict[str, Any]] = []
        file_of: dict[tuple[str, float], Path] = {}
        live = [(k, st) for k, st in setups.items() if st is not None]
        reused = 0
        for n_done, ((aid, f), setup) in enumerate(live):
            east, north = centres[aid]
            key = _key(setup, east, north, g, radius)
            fname = f"{aid}-{f:g}mhz.f32"
            dst = pdir / fname
            if key in earlier and earlier[key].stat().st_size == g.width * g.height * 4:
                shutil.copyfile(earlier[key], dst)
                reused += 1
            else:
                with open(dst, "wb") as fh:
                    for r0 in range(0, g.height, BLOCK_ROWS):
                        r1 = min(g.height, r0 + BLOCK_ROWS)
                        dn = g.row_north(r0, r1)[:, None] - north
                        de = cols[None, :] - east
                        d2 = np.hypot(de, dn)
                        pl = propagation.path_loss_db(setup, d2)
                        pl = np.where(d2 > radius, np.nan, pl).astype("<f4")
                        fh.write(pl.tobytes())
                        ctx.check()
                        ctx.progress(0.5 * (n_done + r1 / g.height) / len(live), "Path loss")
            ctx.check()
            file_of[(aid, f)] = dst
            index_rows.append(
                {
                    "key": key,
                    "file": fname,
                    "antennaId": aid,
                    "carrierIds": [
                        s.carrier_id for s in sources if s.antenna_id == aid and s.frequency_mhz == f
                    ],
                    "frequencyMhz": f,
                    "heightM": setup.h_bs_m,
                    "ueHeightM": hut,
                    "model": model,
                    "environment": env,
                    "east": east,
                    "north": north,
                }
            )
        if reused:
            ctx.log(f"Reused {reused} of {len(live)} path-loss grids from an earlier run.")
        pl_ms = (time.perf_counter() - t_pl) * 1000

        # ---- pattern and link budget per carrier, composite per pixel (D13, D18)
        t_b = time.perf_counter()
        m = budget.margins(
            study["marginPreset"],
            float(study["bodyLossDb"]),
            float(study["edgeProbability"]),
            float(study["shadowSigmaDb"]),
        )
        margin = m["totalDb"]
        used_sectors = sorted({s.sector_index for s in sources})
        maps = {k: np.memmap(v, dtype="<f4", mode="r", shape=(g.height, g.width)) for k, v in file_of.items()}
        rsrp = np.full((g.height, g.width), NODATA, dtype=np.float32)
        best = np.full((g.height, g.width), NODATA, dtype=np.float32)
        overlap = np.zeros((g.height, g.width), dtype=np.float32)
        for r0 in range(0, g.height, BLOCK_ROWS):
            r1 = min(g.height, r0 + BLOCK_ROWS)
            rows = g.row_north(r0, r1)[:, None]
            per = np.full((len(used_sectors), r1 - r0, g.width), -np.inf)
            for s in sources:
                pl = np.asarray(maps[(s.antenna_id, s.frequency_mhz)][r0:r1], dtype=np.float64)
                de = cols[None, :] - s.east
                dn = rows - s.north
                # The pattern angle takes the study's UE height as set, as preview.ts does
                # (dz = ueHeightM - heightM); only the 38.901 formulas clamp it, inside the
                # path-loss model (TR38901_MIN_UE_HEIGHT_M). Keep the two engines identical.
                du = np.full_like(pl, hut - s.height_m)
                az, down = antenna_angles(
                    np.broadcast_to(de, pl.shape),
                    np.broadcast_to(dn, pl.shape),
                    du,
                    s.azimuth_grid_deg,
                    s.convergence_deg,
                    s.downtilt_deg,
                )
                v = budget.rsrp_dbm(
                    s.power_dbm,
                    s.subcarriers,
                    s.feeder_loss_db,
                    s.gain_dbi,
                    pattern_loss_db(s.pattern, az, down),
                    pl,
                    margin,
                )
                v = np.where(np.isnan(v), -np.inf, v)
                k = used_sectors.index(s.sector_index)
                np.maximum(per[k], v, out=per[k])
            top = per.max(axis=0)
            reach = np.isfinite(top)
            arg = np.asarray(used_sectors)[per.argmax(axis=0)]
            count = (per >= (top - OVERLAP_WINDOW_DB)[None]).sum(axis=0)
            rsrp[r0:r1] = np.where(reach, top, NODATA)
            best[r0:r1] = np.where(reach, arg, NODATA)
            overlap[r0:r1] = np.where(reach, count, 0)
            ctx.check()
            ctx.progress(0.5 + 0.45 * r1 / g.height, "Signal strength")
        del maps
        budget_ms = (time.perf_counter() - t_b) * 1000

        # ---- write: grids, the path-loss index, run.json last
        t_w = time.perf_counter()
        crs = project_crs(manifest)
        for name, data in (("rsrp", rsrp), ("bestServer", best), ("overlap", overlap)):
            ctx.check()
            write_grid(staged / OUTPUTS[name], data, g, NODATA, crs)
        ctx.check()
        atomic_write_json(
            pdir / "index.json",
            {
                "about": "Path loss per antenna and frequency, dB, little-endian Float32, row 0 at the top, NaN outside the study radius.",
                "grid": {
                    "origin": [g.origin_e, g.origin_n],
                    "width": g.width,
                    "height": g.height,
                    "resolutionM": g.res,
                    "radiusM": radius,
                },
                "grids": index_rows,
            },
        )
        write_ms = (time.perf_counter() - t_w) * 1000

        valid = rsrp != NODATA
        th = study["thresholds"]
        classes = budget.rsrp_classes(np.where(valid, rsrp, np.nan), th)
        px = g.res * g.res
        areas = {
            name: float(np.sum(valid & (classes == code)) * px)
            for code, name in enumerate(budget.CLASS_NAMES)
        }

        ctx.check()
        doc = {
            "schema": RUN_SCHEMA,
            "runId": run_id,
            "createdAt": now_iso(),
            "status": "done",
            "inputs": {"sectors": sectors_file, "antennas": r.antennas},
            "catalogue": r.catalogue,
            "model": {"model": model, "environment": env},
            "grid": {
                "crs": _crs_name(manifest),
                "resolutionM": g.res,
                "radiusM": radius,
                "origin": [g.origin_e, g.origin_n],
                "width": g.width,
                "height": g.height,
                "nodata": NODATA,
            },
            "timings": {
                "totalMs": round((time.perf_counter() - t0) * 1000, 1),
                "pathLossMs": round(pl_ms, 1),
                "budgetMs": round(budget_ms, 1),
                "writeMs": round(write_ms, 1),
            },
            "warnings": _dedupe(warns),
            "usedUnreviewed": r.used_unreviewed,
            "patterns": r.patterns,
            "outputs": {**OUTPUTS, "pathLossDir": PATHLOSS_DIR},
        }
        atomic_write_json(staged / "run.json", doc)
        ctx.progress(1.0, "Done")
        return {
            "staged": STAGED,
            "pixels": g.width * g.height,
            "classAreasM2": areas,
            "warnings": len(doc["warnings"]),
        }

    # -------------------------------------------------------------------------------------- commit

    def _commit(self, ctx: StepContext) -> dict[str, Any]:
        run_id = ctx.params["runId"]
        rel = f"{RUNS_DIR}/{run_id}"
        dest = ctx.out(rel)
        staged = safe_project_path(ctx.staging, STAGED)
        if not (staged / "run.json").exists():
            if (dest / "run.json").exists():  # renamed before a crash: already committed
                ctx.artifact(rel, "folder")
                return {"run": rel}
            raise JobError("The predicted run is missing from the job folder; start the job again.")
        if dest.exists():
            raise JobError(f"A coverage run {run_id} already exists in this project. Start a new run.")
        ctx.check()
        dest.parent.mkdir(parents=True, exist_ok=True)
        replace_over(staged, dest)
        ctx.artifact(rel, "folder")
        return {"run": rel}
