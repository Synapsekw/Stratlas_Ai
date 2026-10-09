"""hydro.rainfall: water depth over time from a rainfall hyetograph (PRD HYD-3, section 30).

Parameters as ``HydroRainfallParams`` in packages/schema/src/jobs.ts. The prepared surface is
resampled to ``cellM`` (0.5, 1 or 2 m; read from the pyramid level at or below that cell, so a fine
surface is never read whole) over its extent or ``region``, and the local-inertial model of
``inertial.py`` (Bates, Horritt and Fewtrell 2010; decision 3) runs on it:

- **Rain** from the CSV (time in minutes, intensity in mm/h; each row holds until the next, the
  rain stops at the last row), on every cell; **infiltration** a constant rate taken from the water
  standing on a cell; **friction** Manning's ``n``; the area's edges are free outfalls.
- The run lasts ``durationMin`` (default: to the last row of the hyetograph) and writes a **depth
  frame** at a fixed interval (at most ``MAX_FRAMES``): ``frames/<k>.json`` and ``.png``
  (``aio.grid/1``, depths under ``SHOWN_M`` left out) and ``frames/<k>-view.png`` (colour), listed
  in ``results.frames``; the maximum depth (``max-depth``) and the outflow hydrograph
  (``hydrograph.csv``: minutes, rain and outflow in m³/s, stored m³) with the volume balance.

Quality target (``tests/test_hydro.py``): a tilted plane under constant rain reaches the analytic
steady-state outflow (rain rate times area) within 5% at every model cell. Bounded memory: at most
``MAX_CELLS`` model cells. Time grows with cells times steps; a step is limited by
``alpha dx / sqrt(g h)``, so deep water on fine cells is slow.
"""

from __future__ import annotations

import math
from pathlib import Path
from typing import Any

import numpy as np

from ..runtime import JobError, Step, StepContext
from . import inertial
from .common import (
    Raster,
    check_common,
    colour_view,
    commit_run,
    file_sha256,
    grid16,
    load_surface,
    read_hyetograph,
    view_bounds,
    write_run,
)

#: The grid cells the model runs on, metres (decision 3).
CELLS_M = (0.5, 1, 2)
MAX_CELLS = 4_000_000
MAX_FRAMES = 60
#: Depths below this (metres) are left out of the frames.
SHOWN_M = 0.005
#: Frame intervals offered (minutes): the shortest that keeps the frames under ``MAX_FRAMES``.
INTERVALS_MIN = (1, 2, 5, 10, 15, 20, 30, 60, 120, 180, 360, 720)
#: The model has met its quality target (tests/test_hydro.py); a run is a "preview" otherwise.
PREVIEW = False


def frame_interval(duration_min: float) -> float:
    for m in INTERVALS_MIN:
        if duration_min / m <= MAX_FRAMES:
            return float(m)
    return float(math.ceil(duration_min / MAX_FRAMES))


def rain_function(rows: list[tuple[float, float]]):
    """Rain in m/s at a time in seconds: each row's intensity until the next row, none after."""
    times = np.array([t * 60.0 for t, _ in rows])
    rates = np.array([i / 1000.0 / 3600.0 for _, i in rows])

    def at(t: float) -> float:
        if t < times[0] or t >= times[-1]:
            return 0.0
        k = int(np.searchsorted(times, t, side="right")) - 1
        return float(rates[k])

    return at, [float(t) for t in times]


class HydroRainfall:
    name = "hydro.rainfall"
    title = "Direct rainfall"
    description = "Water depth over time from a rainfall hyetograph (simplified 2D model)."
    keys = frozenset(
        {
            "surface",
            "hyetograph",
            "manningN",
            "infiltrationMmPerH",
            "cellM",
            "durationMin",
            "region",
            "run",
        }
    )
    required = frozenset({"surface", "hyetograph", "manningN", "infiltrationMmPerH", "cellM"})

    def validate(self, params: dict[str, Any]) -> dict[str, Any]:
        check_common(params, self.name, self.keys, self.required)
        cell = params["cellM"]
        if isinstance(cell, bool) or not isinstance(cell, int | float) or cell not in CELLS_M:
            raise JobError("cellM must be one of: 0.5, 1, 2.")

        def num(key: str, lo: float, hi: float, lo_open: bool) -> None:
            v = params.get(key)
            if v is None:
                return
            if isinstance(v, bool) or not isinstance(v, int | float) or not math.isfinite(v):
                raise JobError(f"{key} must be a number.")
            if (v <= lo if lo_open else v < lo) or v > hi:
                raise JobError(
                    f"{key} must be {'above' if lo_open else 'at least'} {lo:g} and at most {hi:g}."
                )

        num("manningN", 0, 1, True)
        num("infiltrationMmPerH", 0, 1000, False)
        num("durationMin", 0, 10_080, True)
        hy = params["hyetograph"]
        if not isinstance(hy, str) or not hy.strip() or not Path(hy).is_absolute():
            raise JobError("hyetograph must be the full path of a rainfall CSV.")
        return dict(params)

    def inputs(self, params: dict[str, Any]) -> list[str]:
        return [f"survey/surfaces/{params['surface']}", params["hyetograph"]]

    def plan(self, params: dict[str, Any]) -> list[Step]:
        def simulate(ctx: StepContext) -> dict[str, Any]:
            p = ctx.params
            hy_path = ctx.input(p["hyetograph"])
            rows = read_hyetograph(hy_path)
            cell = float(p["cellM"])
            surf = load_surface(ctx.project, p["surface"], p.get("region"), MAX_CELLS, ctx.check, cell=cell)
            r = surf.raster
            duration = float(p.get("durationMin") or rows[-1][0])
            if duration <= 0:
                raise JobError("The run has no duration: give durationMin or a rainfall that lasts.")
            rain_at, changes = rain_function(rows)
            model = inertial.InertialModel(
                r.z, cell, float(p["manningN"]), float(p["infiltrationMmPerH"]) / 1000.0 / 3600.0
            )
            step_min = frame_interval(duration)
            frame_times = [k * step_min * 60.0 for k in range(1, int(duration // step_min) + 1)]
            end = duration * 60.0
            if not frame_times or frame_times[-1] < end - 1e-6:
                frame_times.append(end)
            # the hydrograph: ten samples per frame
            sample_times = sorted({round(t, 6) for t in np.linspace(0, end, 10 * len(frame_times) + 1)[1:]})
            frames: list[dict[str, Any]] = []
            hydro: list[tuple[float, float, float, float]] = []
            hmax = np.zeros_like(model.h)
            frame_set = {round(t, 6) for t in frame_times}
            area = cell * cell * float(model.valid.sum())
            peak = (0.0, 0.0)

            def on_event(t: float) -> None:
                nonlocal peak
                np.maximum(hmax, model.h, out=hmax)
                key = round(t, 6)
                if key in frame_set or key in {round(s, 6) for s in sample_times}:
                    q = model.sample()
                    rain = rain_at(t - 1e-6) * area
                    hydro.append((t / 60.0, rain, q, model.stored))
                    if q > peak[0]:
                        peak = (q, t / 60.0)
                if key in frame_set:
                    k = len(frames)
                    depth = np.where(model.valid & (model.h >= SHOWN_M), model.h, np.nan)
                    folder = ctx.stage(f"out/frames/{k}.json").parent
                    grid16(np.where(np.isfinite(depth), depth, np.nan), r, str(k), "depth", folder)
                    colour_view(depth, folder / f"{k}-view.png")
                    frames.append(
                        {
                            "tMin": t / 60.0,
                            "file": f"frames/{k}.json",
                            "view": f"frames/{k}-view.png",
                            "maxDepthM": float(model.h.max()),
                            "wetAreaM2": float((model.h >= SHOWN_M).sum()) * cell * cell,
                        }
                    )
                    ctx.progress(0.05 + 0.9 * t / end, f"{t / 60:.0f} of {duration:.0f} min")

            events = sorted(set(changes) | set(frame_times) | set(sample_times))
            inertial.run(model, rain_at, events, end, on_event, ctx.check)
            tot = model.totals
            stored = model.stored
            balance = tot.rain - tot.infiltrated - tot.outflow - stored
            results: dict[str, Any] = {
                "durationMin": duration,
                "frameMin": step_min,
                "frames": frames,
                "rainM3": tot.rain,
                "infiltratedM3": tot.infiltrated,
                "outflowM3": tot.outflow,
                "storedM3": stored,
                "massErrorPct": 100.0 * abs(balance) / tot.rain if tot.rain > 0 else 0.0,
                "peakOutflowM3s": peak[0],
                "peakAtMin": peak[1],
                "finalOutflowM3s": hydro[-1][2] if hydro else 0.0,
                "maxDepthM": float(hmax.max()),
                "steps": tot.steps,
                "areaM2": area,
            }
            # the maximum depth and the hydrograph
            hshow = np.where(model.valid & (hmax >= SHOWN_M), hmax, np.nan)
            out = ctx.stage("out/max-depth.json").parent
            grid16(hshow, r, "max-depth", "depth", out)
            colour_view(hshow, out / "max-depth-view.png")
            lines = ["timeMin,rainM3s,outflowM3s,storedM3"]
            lines += [f"{t:.4f},{a:.6f},{b:.6f},{c:.4f}" for t, a, b, c in hydro]
            (out / "hydrograph.csv").write_text("\n".join(lines) + "\n", "utf-8", newline="")
            files = {
                "maxDepth": "max-depth.json",
                "view": {
                    "file": "max-depth-view.png",
                    "bounds": view_bounds(Raster(hmax, r.origin_e, r.origin_n, cell)),
                },
                "hydrograph": "hydrograph.csv",
            }
            notes = [
                "Simplified 2D model (local inertial): constant infiltration, no drains or structures, "
                "free outfall at the edges of the area."
            ]
            doc = write_run(
                ctx,
                self.name,
                surf,
                results,
                files,
                extra_fp={"hyetograph": file_sha256(hy_path)},
                preview=PREVIEW,
                notes=notes,
            )
            return {"steps": tot.steps, "frames": len(doc["results"]["frames"])}

        return [
            Step("simulate", "Run the rainfall", simulate, 10.0),
            Step("commit", "Save the run", commit_run),
        ]


__all__ = ["CELLS_M", "HydroRainfall", "frame_interval", "rain_function"]
