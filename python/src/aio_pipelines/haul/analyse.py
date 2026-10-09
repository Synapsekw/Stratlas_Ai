"""haul.analyse: width, gradient, cross fall, superelevation and berm height along a haul road
(M11 G11, PRD HRD-1; data-conventions section 30; parameters ``HaulAnalyseParams`` of
``@aio/schema`` ``jobs.ts``).

The road's centreline is drawn (E, N points), a design alignment or a design linework layer
(``{design, layer}``, ``centreline.py``). Sections every ``intervalM`` along it are read on a
prepared surface (``survey/surfaces/<id>/``) and checked against the site's ``limits``
(``road.py``). The run writes ``survey/haul/<run>/``:

- ``run.json`` (``aio.haul-run/1``): the parameters as given (the limits used), what the surface
  and centreline were (with the surface's and design file's fingerprints, so the app can show a
  run as stale), every station's measurements and pass or fail per check, the failing stretches
  and a summary;
- ``haul.geojson``: the centreline in pieces around each station coloured by its status, the
  section lines and the road edges, in the project CRS (E, N, Z) with a top-level ``crs``.

The surface and the designs are read, never changed.
"""

from __future__ import annotations

import hashlib
import math
import re
import shutil
from collections.abc import Callable
from typing import Any

import numpy as np

from ..params import known_keys
from ..runtime import JobError, Step, StepContext, atomic_write_json, now_iso
from ..survey.compare import ProjectSurfaces, canonical
from ..survey.grid import GridSurface, bilinear
from .centreline import Centreline, resolve_centreline
from .road import HAUL_ENGINE_VERSION, LIMIT_KEYS, analyse_road, stretches, summary

RUN_SCHEMA = "aio.haul-run/1"
ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$")
STATUS_COLOR = {"pass": "#2fbf71", "fail": "#e5484d", "no-data": "#9aa0a6"}


def _num(v: Any) -> bool:
    return isinstance(v, int | float) and not isinstance(v, bool) and math.isfinite(v)


def _id(v: Any, what: str) -> None:
    if not isinstance(v, str) or not ID_RE.match(v):
        raise JobError(f"{what} must be an id (letters, digits, dot, dash or _).")


class HaulAnalyse:
    name = "haul.analyse"
    title = "Haul-road compliance"
    description = (
        "Width, gradient, cross fall, superelevation and berm height along a haul road against site limits."
    )
    keys = frozenset({"surface", "centreline", "intervalM", "limits", "run"})
    required = frozenset({"surface", "centreline", "intervalM", "limits"})

    def validate(self, params: dict[str, Any]) -> dict[str, Any]:
        known_keys(params, set(self.keys), self.name)
        missing = sorted(k for k in self.required if params.get(k) is None)
        if missing:
            raise JobError(f"{self.name} needs: {', '.join(missing)}.")
        _id(params["surface"], "surface")
        cl = params["centreline"]
        if isinstance(cl, list):
            if not 2 <= len(cl) <= 100_000 or not all(
                isinstance(p, list | tuple) and len(p) == 2 and all(_num(v) for v in p) for p in cl
            ):
                raise JobError("centreline must be 2 or more [E, N] points, or { design, layer }.")
        elif isinstance(cl, dict):
            if set(cl) != {"design", "layer"}:
                raise JobError("centreline must be 2 or more [E, N] points, or { design, layer }.")
            _id(cl["design"], "centreline.design")
            _id(cl["layer"], "centreline.layer")
        else:
            raise JobError("centreline must be 2 or more [E, N] points, or { design, layer }.")
        iv = params["intervalM"]
        if not _num(iv) or not 0 < iv <= 1000:
            raise JobError("intervalM must be a number of metres above 0 and at most 1000.")
        limits = params["limits"]
        if not isinstance(limits, dict):
            raise JobError("limits must be an object.")
        known_keys(limits, set(LIMIT_KEYS), f"{self.name} limits")
        for k, v in limits.items():
            if not _num(v):
                raise JobError(f"limits.{k} must be a number.")
            if k in ("minWidthM", "maxGradePct", "minBermHeightM") and v <= 0:
                raise JobError(f"limits.{k} must be above 0.")
        lo, hi = limits.get("crossFallMinPct"), limits.get("crossFallMaxPct")
        if lo is not None and hi is not None and lo > hi:
            raise JobError("limits.crossFallMinPct must not be above limits.crossFallMaxPct.")
        if params.get("run") is not None:
            _id(params["run"], "run")
        return dict(params)

    def inputs(self, params: dict[str, Any]) -> list[str]:
        out = [f"survey/surfaces/{params['surface']}", "survey/designs.json"]
        cl = params["centreline"]
        if isinstance(cl, dict):
            out.append(f"survey/designs/{cl['design']}")
        return out

    def plan(self, params: dict[str, Any]) -> list[Step]:
        def analyse(ctx: StepContext) -> dict[str, Any]:
            ps = ProjectSurfaces(ctx.project)
            sid = str(params["surface"])
            resolved = ps.grid(sid)
            surface = resolved.grid
            assert surface is not None
            meta = ps.metas()[sid]
            cl, cl_rec = resolve_centreline(ctx.project, params["centreline"])
            ctx.log(f"Centreline {cl_rec['name']}, {cl.length:.1f} m; surface {resolved.name}.")
            stations = analyse_road(
                surface,
                cl,
                float(params["intervalM"]),
                dict(params["limits"]),
                ctx.check,
                lambda f, m: ctx.progress(0.95 * f, m),
            )
            run_id = str(params.get("run") or ctx.job.job_id)
            surf_rec = {
                "id": sid,
                "name": resolved.name,
                "fingerprint": resolved.fingerprint,
                "cellM": float(surface.cell),
                **({"capture": resolved.capture} if resolved.capture else {}),
            }
            inputs = {
                "engine": HAUL_ENGINE_VERSION,
                "surface": {"id": sid, "fingerprint": resolved.fingerprint},
                "centreline": {k: v for k, v in cl_rec.items() if k != "lengthM"},
                "drawn": params["centreline"] if isinstance(params["centreline"], list) else None,
                "intervalM": params["intervalM"],
                "limits": params["limits"],
            }
            fp = "sha256:" + hashlib.sha256(canonical(inputs).encode("utf-8")).hexdigest()
            run = {
                "schema": RUN_SCHEMA,
                "id": run_id,
                "jobId": ctx.job.job_id,
                "engine": HAUL_ENGINE_VERSION,
                "params": params,
                "surface": surf_rec,
                "centreline": cl_rec,
                "intervalM": float(params["intervalM"]),
                "limits": params["limits"],
                "stations": stations,
                "stretches": stretches(stations),
                "summary": summary(stations),
                "geojson": "haul.geojson",
                "fingerprint": fp,
                "computedAt": now_iso(),
            }
            atomic_write_json(ctx.stage("out/run.json"), run)
            crs = meta.get("crs")
            atomic_write_json(
                ctx.stage("out/haul.geojson"), geojson(cl, stations, crs, heights(surface)), indent=None
            )
            s = run["summary"]
            ctx.log(
                f"{s['stations']} stations: {s['pass']} pass, {s['fail']} fail, {s['noData']} without data."
            )
            return {"run": run_id, **{k: s[k] for k in ("stations", "pass", "fail", "noData")}}

        def commit(ctx: StepContext) -> dict[str, Any]:
            from ..runtime import commit_tree

            run_id = ctx.outputs("analyse").get("run") or str(params.get("run") or ctx.job.job_id)
            out = f"survey/haul/{run_id}"
            marker = ctx.job.dir / "steps" / ".committing"
            old = ctx.out(out)
            if old.exists() and not marker.exists():
                shutil.rmtree(old)
            marker.parent.mkdir(parents=True, exist_ok=True)
            marker.write_text("", "utf-8")
            n = commit_tree(ctx, "out", out)
            marker.unlink(missing_ok=True)
            return {"out": out, "files": n}

        return [Step("analyse", "Measure the road", analyse, 4.0), Step("commit", "Save the run", commit)]


def heights(surface: GridSurface) -> Callable[[list[tuple[float, float]]], list[float | None]]:
    """Surface heights at (E, N) points, None where the surface has no data."""

    def z_at(pts: list[tuple[float, float]]) -> list[float | None]:
        e = np.array([p[0] for p in pts]) - surface.origin_e
        n = np.array([p[1] for p in pts]) - surface.origin_n
        z = bilinear(surface, e, n, 0.0, 0.0)
        return [round(float(v), 3) if math.isfinite(v) else None for v in z]

    return z_at


ZAt = Callable[[list[tuple[float, float]]], list[float | None]]


def _coords(pts: list[tuple[float, float]], z_at: ZAt) -> list[list[float]]:
    zs = z_at(pts)
    return [
        [round(e, 3), round(n, 3)] if z is None else [round(e, 3), round(n, 3), z]
        for (e, n), z in zip(pts, zs, strict=True)
    ]


def geojson(cl: Centreline, stations: list[dict[str, Any]], crs: Any, z_at: ZAt) -> dict[str, Any]:
    """Centreline pieces by status, section lines and road edges (project CRS, E, N, Z)."""
    feats: list[dict[str, Any]] = []
    ch = [float(st["chainageM"]) for st in stations]
    for k, st in enumerate(stations):
        lo = 0.0 if k == 0 else (ch[k - 1] + ch[k]) / 2
        hi = cl.length if k == len(stations) - 1 else (ch[k] + ch[k + 1]) / 2
        failed = [c for c, v in st["checks"].items() if v == "fail"]
        props = {
            "kind": "centreline",
            "station": st["stationLabel"],
            "chainageM": st["chainageM"],
            "status": st["status"],
            "color": STATUS_COLOR[st["status"]],
            "failed": failed,
        }
        feats.append(
            {
                "type": "Feature",
                "properties": props,
                "geometry": {"type": "LineString", "coordinates": _coords(cl.dense(lo, hi, 1.0), z_at)},
            }
        )
        s = float(st["chainageM"])
        e0, n0 = cl.point(s)
        nl = cl.left_normal(s)

        def at(o: float, e0: float = e0, n0: float = n0, nl: tuple[float, float] = nl) -> tuple[float, float]:
            return e0 + o * nl[0], n0 + o * nl[1]

        left = st["edgeLeftM"]
        right = st["edgeRightM"]
        bl = (st["bermLeft"] or {}).get("widthM") or 0.0
        br = (st["bermRight"] or {}).get("widthM") or 0.0
        if left is not None and right is not None:
            feats.append(
                {
                    "type": "Feature",
                    "properties": {**props, "kind": "section"},
                    "geometry": {
                        "type": "LineString",
                        "coordinates": _coords([at(left + bl), at(-(right + br))], z_at),
                    },
                }
            )
    for side, key, sign in (("left", "edgeLeftM", 1.0), ("right", "edgeRightM", -1.0)):
        run: list[tuple[float, float]] = []
        for st in [*stations, None]:
            if st is not None and st[key] is not None:
                e0, n0 = cl.point(float(st["chainageM"]))
                nl = cl.left_normal(float(st["chainageM"]))
                o = sign * float(st[key])
                run.append((e0 + o * nl[0], n0 + o * nl[1]))
                continue
            if len(run) >= 2:
                feats.append(
                    {
                        "type": "Feature",
                        "properties": {"kind": "edge", "side": side},
                        "geometry": {"type": "LineString", "coordinates": _coords(run, z_at)},
                    }
                )
            run = []
    doc: dict[str, Any] = {"type": "FeatureCollection", "features": feats}
    if crs is not None:
        doc["crs"] = crs
    return doc
