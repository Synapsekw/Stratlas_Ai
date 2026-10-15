"""`model.evidence`: measure an engineered asset (chimney, flare stack, tower) from point clouds and
photos and write a bounded evidence pack, `engineering/<run>/evidence.json` (`aio.evidence/1`,
`packages/schema/src/modelEvidence.ts`) with its images in `engineering/<run>/img/`.

Eight resumable steps, each atomic on its own: crop, ground, axis, sections, members, renders,
photos, pack. Work files stay in the job's staging folder; only the images and the pack are
committed into the project, the pack last. The pack carries measurements, not points: no point
array, no `.npy`, and no image wider than the detail's `maxPx`.
"""

from __future__ import annotations

import re
from typing import Any

import numpy as np

from ..params import known_keys, number, text
from ..runtime import (
    JobError,
    Step,
    StepContext,
    atomic_write_json,
    commit_files,
    commit_tree,
)
from . import photos as photo_ingest
from .axis import Axis, estimate_axis
from .cloud import (
    GroundSplit,
    find_base,
    isolate_asset,
    read_region,
    region_centre,
    split_ground,
)
from .members import (
    MemberGroup,
    family_hints,
    find_antenna_candidates,
    find_bays,
    find_flues,
    find_legs,
    find_light_candidates,
    find_platforms,
)
from .render import colour_bands, crop_views, render_ortho, render_slice, write_images
from .sections import SliceFit, Taper, fit_sections, fit_taper

#: Mirrors `EVIDENCE_LIMITS` in packages/schema/src/modelEvidence.ts (maxPoints, maxImages, maxPx).
LIMITS = {
    "fast": (300_000, 12, 1024),
    "standard": (1_000_000, 24, 1568),
    "detailed": (2_000_000, 40, 1568),
}
RUN_ID = re.compile(r"^run-[a-z0-9-]{1,60}$")
MIN_POINTS = 200
GROUND_DIST = 0.15
SEED = 0


def photogrammetry_available() -> bool:
    """Whether a photogrammetry engine (ODM) is installed: the probe behind `reconstruction`."""
    from ..photo.odm.runner import find_odm

    try:
        find_odm()
    except JobError:
        return False
    return True


def _layer(manifest: dict[str, Any], layer_id: str) -> dict[str, Any]:
    layer = next((x for x in manifest.get("layers", []) if x.get("id") == layer_id), None)
    if layer is None:
        raise JobError(f'The project has no layer "{layer_id}".')
    if layer.get("kind") != "pointcloud":
        raise JobError(f'"{layer.get("name", layer_id)}" is not a point cloud layer.')
    return layer


def _vec(v: Any) -> list[float]:
    return [float(x) for x in v]


def _axis_dict(a: Axis) -> dict[str, Any]:
    return {"point": _vec(a.point), "dir": _vec(a.dir), "tilt": float(a.tilt_deg)}


def _axis_of(d: dict[str, Any]) -> Axis:
    return Axis(tuple(d["point"]), tuple(d["dir"]), float(d["tilt"]))


def _slice_dict(s: SliceFit) -> dict[str, Any]:
    return {
        "y": s.y,
        "centre": list(s.centre),
        "r": s.r,
        "residual": s.residual_m,
        "support": s.support,
        "coverage": s.coverage,
    }


def _slice_of(d: dict[str, Any]) -> SliceFit:
    return SliceFit(d["y"], tuple(d["centre"]), d["r"], d["residual"], d["support"], d["coverage"])


def _round(v: Any, digits: int = 4) -> Any:
    """Numbers to 0.1 mm (and 1e-4 in ratios): the pack is a record of measurements, not of float noise."""
    if isinstance(v, float):
        return round(v, digits)
    if isinstance(v, dict):
        return {k: _round(x, digits) for k, x in v.items()}
    if isinstance(v, list | tuple):
        return [_round(x, digits) for x in v]
    return v


def _shaft_height(kept: np.ndarray, axis: Axis, taper: Taper, step: float, family: str) -> float | None:
    """Height of the shaft top above the base: the highest wall point just above the last section
    (flues, pilots and antennas stand above it and are not the shaft); the highest point for an open
    frame."""
    if len(kept) == 0:
        return None
    u, w, h = axis.to_frame(kept)
    if not taper.profile or family == "telecom-lattice":
        return float(h.max())
    ys = [p[0] for p in taper.profile]
    rs = [p[1] for p in taper.profile]
    wall = np.hypot(u, w) >= 0.85 * np.interp(h, ys, rs)
    sel = wall & (h <= ys[-1] + step)
    return float(h[sel].max()) if sel.any() else float(ys[-1])


class ModelEvidence:
    name = "model.evidence"
    title = "Measure an engineered asset"
    description = (
        "Crop, ground, axis, sections and repeated members of a chimney, flare stack or tower from a "
        "point cloud and photos, as a bounded evidence pack."
    )
    keys = frozenset({"run", "clouds", "meshes", "photos", "region", "detail", "limits"})

    # ------------------------------------------------------------------ params

    def validate(self, params: dict[str, Any]) -> dict[str, Any]:
        known_keys(params, set(self.keys), self.name)
        run = text(params, "run", required=True)
        if not isinstance(run, str) or not RUN_ID.match(run):
            raise JobError("run must be run- followed by lower-case letters, digits and dashes.")
        out: dict[str, Any] = {"run": run}
        for key, limit, field in (("clouds", 4, "layer"), ("meshes", 2, "layer"), ("photos", 400, "path")):
            items = params.get(key, [])
            if not isinstance(items, list) or len(items) > limit:
                raise JobError(f"{key} must be a list of at most {limit}.")
            vals = []
            for it in items:
                if (
                    not isinstance(it, dict)
                    or set(it) != {field}
                    or not isinstance(it[field], str)
                    or not it[field]
                ):
                    raise JobError(f"Each of {key} is {{ {field} }}.")
                vals.append({field: it[field]})
            out[key] = vals
        detail = params.get("detail", "standard")
        if detail not in LIMITS:
            raise JobError("detail must be fast, standard or detailed.")
        out["detail"] = detail
        limits = params.get("limits")
        if limits is None:
            mp, mi, mx = LIMITS[detail]
            limits = {"maxPoints": mp, "maxImages": mi, "maxPx": mx}
        elif not isinstance(limits, dict) or set(limits) != {"maxPoints", "maxImages", "maxPx"}:
            raise JobError("limits must be { maxPoints, maxImages, maxPx }.")
        out["limits"] = {
            "maxPoints": int(number(limits, "maxPoints", lo=1000, hi=10_000_000, integer=True) or 0),
            "maxImages": int(number(limits, "maxImages", lo=1, hi=64, integer=True) or 0),
            "maxPx": int(number(limits, "maxPx", lo=64, hi=4096, integer=True) or 0),
        }
        region = params.get("region")
        if region is not None:
            circle = isinstance(region, dict) and set(region) == {"centre", "radiusM"}
            box = isinstance(region, dict) and set(region) == {"min", "max"}
            if not (circle or box):
                raise JobError("region must be { centre, radiusM } or { min, max } in the local frame.")
            if circle and not (
                isinstance(region["centre"], list)
                and len(region["centre"]) == 2
                and float(region["radiusM"]) > 0
            ):
                raise JobError("region.centre is [x, z] and radiusM is positive.")
            out["region"] = region
        if not out["clouds"] and not out["photos"]:
            raise JobError("Give at least one point cloud or one photo.")
        return out

    def inputs(self, params: dict[str, Any]) -> list[str]:
        photos = [p["path"] for p in params.get("photos", [])]
        # the layers (manifest), the cloud files and the mesh files (data-conventions section 2)
        return ["manifest.json", "clouds", "meshes", *photos]

    # ------------------------------------------------------------------ plan

    def plan(self, params: dict[str, Any]) -> list[Step]:
        lim = params["limits"]
        region = params.get("region")
        run = params["run"]
        has_cloud = bool(params["clouds"])

        def load(ctx: StepContext, name: str) -> np.ndarray:
            return np.load(ctx.stage(f"work/{name}.npy"))

        def load_rgb(ctx: StepContext, name: str) -> np.ndarray | None:
            p = ctx.stage(f"work/{name}.npy")
            return np.load(p) if p.exists() else None

        # ---- crop
        def crop(ctx: StepContext) -> dict[str, Any]:
            if not has_cloud:
                return {"points": 0}
            from ..inspection.frame import asset_path, read_manifest

            manifest = read_manifest(ctx.project)
            origin = tuple(manifest.get("origin") or [0, 0, 0])
            clouds = params["clouds"]
            cap = max(1, lim["maxPoints"] // len(clouds))
            parts, colours, crs, read = [], [], None, 0
            for i, c in enumerate(clouds):
                ctx.check()
                ctx.progress(i / len(clouds), f"Cloud {i + 1} of {len(clouds)}")
                layer = _layer(manifest, c["layer"])
                path = asset_path(ctx.project, layer.get("src"))
                if path is None or not path.is_file():
                    raise JobError(f'The file of "{layer.get("name", c["layer"])}" is missing.')
                xyz, info = read_region(path, layer.get("format", ""), region, cap, ctx, origin, SEED + i)
                parts.append(xyz)
                colours.append(info["rgb"])
                crs = crs or info["crs"]
                read += info["read"]
            xyz = np.concatenate(parts)
            if len(xyz) < MIN_POINTS:
                raise JobError(
                    f"The cloud has {len(xyz)} points in the region, fewer than the {MIN_POINTS} a measurement needs."
                )
            np.save(ctx.stage("work/points.npy"), xyz)
            have_colour = all(c is not None for c in colours)
            if have_colour:
                np.save(ctx.stage("work/points_rgb.npy"), np.concatenate(colours))
            ctx.log(f"{len(xyz):,} of {read:,} points in the region kept.")
            return {
                "points": len(xyz),
                "read": read,
                "crs": crs,
                "colour": have_colour,
                "bounds": {"min": _vec(xyz.min(axis=0)), "max": _vec(xyz.max(axis=0))},
            }

        # ---- ground and the one structure
        def ground(ctx: StepContext) -> dict[str, Any]:
            if not has_cloud:
                return {}
            xyz = load(ctx, "points")
            rgb = load_rgb(ctx, "points_rgb")
            ctx.progress(0.1, "Ground")
            split = split_ground(xyz, GROUND_DIST)
            ctx.check()
            asset, iso = isolate_asset(split.kept, region_centre(region))
            mask = iso.pop("mask")
            np.save(ctx.stage("work/asset.npy"), asset)
            np.save(ctx.stage("work/ground.npy"), split.ground)
            if rgb is not None:
                np.save(ctx.stage("work/asset_rgb.npy"), rgb[split.mask][mask])
            if len(asset) < MIN_POINTS:
                raise JobError("Nothing stands above the ground in the region: no asset to measure.")
            ctx.log(
                f"{len(asset):,} asset points, {split.removed:,} ground, {iso['droppedPoints']:,} left out."
            )
            return {"ground": split.removed, "isolation": iso, "asset": len(asset)}

        # ---- axis and base
        def axis_step(ctx: StepContext) -> dict[str, Any]:
            if not has_cloud:
                return {}
            from ..modelfit.segment import ground_surface

            asset, grd = load(ctx, "asset"), load(ctx, "ground")
            axis = estimate_axis(asset, seed=SEED)
            ctx.check()
            surface = ground_surface(grd) if len(grd) else (lambda xz: np.zeros(len(xz)))
            base, axis = find_base(axis, asset, GroundSplit(asset, grd, surface))
            return {
                "axis": _axis_dict(axis),
                "base": {
                    "point": _vec(base.point),
                    "observed": base.observed,
                    "basis": base.basis,
                    "gap": base.gap_m,
                    "note": base.note,
                },
            }

        # ---- sections
        def sections(ctx: StepContext) -> dict[str, Any]:
            if not has_cloud:
                return {}
            asset = load(ctx, "asset")
            axis = _axis_of(ctx.outputs("axis")["axis"])
            _, _, h = axis.to_frame(asset)
            step = float(np.clip(float(h.max()) / 80.0, 0.25, 2.0))
            report: dict[str, Any] = {}
            slices = fit_sections(asset, axis, step, seed=SEED, report=report)
            taper = fit_taper(slices)
            ctx.log(f"{len(slices)} sections, {len(taper.profile)} taper knots.")
            return {
                "step": step,
                "slices": [_slice_dict(s) for s in slices],
                "taper": {"profile": [list(p) for p in taper.profile], "residual": taper.residual_m},
                "rejected": report.get("rejected", {}),
            }

        # ---- members, family hint, colours
        def members(ctx: StepContext) -> dict[str, Any]:
            if not has_cloud:
                return {}
            asset = load(ctx, "asset")
            rgb = load_rgb(ctx, "asset_rgb")
            axis = _axis_of(ctx.outputs("axis")["axis"])
            sec = ctx.outputs("sections")
            slices = [_slice_of(s) for s in sec["slices"]]
            taper = Taper([tuple(p) for p in sec["taper"]["profile"]], sec["taper"]["residual"])
            noise = float(np.median([s.residual_m for s in slices])) if slices else 0.0
            ctx.progress(0.1, "Repeated members")
            flues = find_flues(asset, axis, taper, SEED)
            legs = find_legs(asset, axis)
            lights = find_light_candidates(asset, axis, taper, noise=noise)
            ctx.check()
            antennas = find_antenna_candidates(asset, axis, None if legs.items else taper)
            platforms = find_platforms(asset, axis, taper)
            hints = family_hints(asset, axis, slices, [flues, legs, lights, antennas, platforms], SEED)
            ctx.check()
            bays = find_bays(asset, axis, legs) if hints.suggested == "telecom-lattice" else None
            relevant: list[MemberGroup] = []
            if hints.suggested == "telecom-lattice":
                relevant = [legs, antennas, platforms]
            elif hints.suggested == "chimney":
                relevant = [flues, lights, platforms]
            elif hints.suggested == "flare":
                relevant = [platforms, lights]
            else:
                relevant = [antennas, lights]
            height = _shaft_height(asset, axis, taper, float(sec["step"]), hints.suggested)
            step = max((height or 1.0) / 40.0, 0.5)
            bands = colour_bands(asset, rgb, axis, step) if rgb is not None else []
            return {
                "members": [g.to_dict() for g in relevant if g.items],
                "hints": hints.to_dict(),
                "bays": bays,
                "height": height,
                "colours": bands,
            }

        # ---- renders
        def renders(ctx: StepContext) -> dict[str, Any]:
            if not has_cloud:
                return {"images": []}
            asset = load(ctx, "asset")
            rgb = load_rgb(ctx, "asset_rgb")
            axis = _axis_of(ctx.outputs("axis")["axis"])
            sec, mem = ctx.outputs("sections"), ctx.outputs("members")
            slices = [_slice_of(s) for s in sec["slices"]]
            taper = Taper([tuple(p) for p in sec["taper"]["profile"]], sec["taper"]["residual"])
            reserve = min(len(params["photos"]), lim["maxImages"] // 2)
            budget = max(0, lim["maxImages"] - reserve)
            px = min(lim["maxPx"], 1024)
            sides: dict[str, tuple[str, str, str, Any]] = {}
            for view in ("top", "north", "east", "south", "west"):
                ctx.check()
                sides[view] = (
                    f"img-{view}",
                    "top" if view == "top" else "side",
                    view,
                    render_ortho(asset, rgb, view, px),
                )
            light_groups = [
                MemberGroup(g["kind"], levels=g.get("levels", []))
                for g in mem["members"]
                if g["kind"] == "light-candidate"
            ]
            crops = [
                (f"img-{name}", "crop", name, im)
                for name, im in crop_views(asset, axis, taper, light_groups, min(px, 512), rgb)
            ]
            slice_img: list[tuple[str, str, str, Any]] = []
            if slices:
                _, _, h = axis.to_frame(asset)
                mid = slices[len(slices) // 2]
                near = asset[np.abs(h - mid.y) < 0.5]
                slice_img = [("img-slice-mid", "slice", "slice", render_slice(near, mid, min(px, 512)))]
            # most informative first: the cut-off under a small image budget drops the least useful
            crown = [c for c in crops if c[2] == "crown"]
            levels = [c for c in crops if c[2].startswith("level-")]
            base_c = [c for c in crops if c[2] == "base"]
            items = [
                sides["top"],
                sides["north"],
                sides["east"],
                *crown,
                *levels,
                *slice_img,
                *base_c,
                sides["south"],
                sides["west"],
            ]
            ctx.check()
            written = write_images(items, ctx.stage("img"), "img", budget, lim["maxPx"])
            return {"images": written}

        # ---- photos
        def photos(ctx: StepContext) -> dict[str, Any]:
            if not params["photos"]:
                return {"items": [], "images": [], "identity": None, "rejected": []}
            used = len(ctx.outputs("renders").get("images", []))
            paths, given = [], {}
            for p in params["photos"]:
                path = ctx.input(p["path"])
                paths.append(path)
                given[str(path)] = p["path"]
            res = photo_ingest.ingest_photos(
                paths, ctx.stage("img_photos"), lim["maxPx"], max(0, lim["maxImages"] - used)
            )
            images = []
            from PIL import Image

            for pid, copy in res.copies.items():
                import hashlib

                name = f"img-photo-{pid[:12]}"
                dest = ctx.stage(f"img/{name}.jpg")
                dest.write_bytes(copy.read_bytes())
                with Image.open(dest) as im:
                    w, h = im.size
                data = dest.read_bytes()
                images.append(
                    {
                        "id": name,
                        "file": f"img/{name}.jpg",
                        "kind": "photo",
                        "view": "photo",
                        "w": w,
                        "h": h,
                        "bytes": len(data),
                        "sha1": hashlib.sha1(data).hexdigest(),
                    }
                )
            items = []
            for it in res.items:
                it = dict(it)
                it["original"] = given.get(it["original"], it["original"])[:1000]
                items.append(it)
            ident = res.identity if not res.identity["sameAsset"] else {"sameAsset": True, "conflicts": []}
            return {
                "items": items,
                "images": images,
                "identity": ident,
                "rejected": [r["reason"] for r in res.rejected],
            }

        # ---- pack
        def pack(ctx: StepContext) -> dict[str, Any]:
            doc = self._assemble(ctx, params, has_cloud)
            out_dir = f"engineering/{run}"
            written = {i["file"] for i in doc["images"]}
            commit_tree(ctx, "img", f"{out_dir}/img")
            for stale in (ctx.out(f"{out_dir}/img")).glob("*"):
                if f"img/{stale.name}" not in written and stale.is_file():
                    stale.unlink()
            atomic_write_json(ctx.stage("evidence.json"), doc)
            commit_files(ctx, [("evidence.json", f"{out_dir}/evidence.json")])
            return {
                "pack": f"{out_dir}/evidence.json",
                "images": len(doc["images"]),
                "warnings": len(doc["warnings"]),
            }

        return [
            Step("crop", "Read the asset region", crop, 3),
            Step("ground", "Remove the ground, find the asset", ground, 2),
            Step("axis", "Find the axis and base", axis_step, 1),
            Step("sections", "Measure the sections", sections, 2),
            Step("members", "Find repeated members", members, 3),
            Step("renders", "Render evidence views", renders, 3),
            Step("photos", "Prepare the photos", photos, 2),
            Step("pack", "Write the evidence pack", pack, 1),
        ]

    # ------------------------------------------------------------------ the pack

    def _assemble(self, ctx: StepContext, params: dict[str, Any], has_cloud: bool) -> dict[str, Any]:
        region = params.get("region")
        warnings: list[str] = []
        phot = ctx.outputs("photos")
        rend = ctx.outputs("renders")
        images = [*rend.get("images", []), *phot.get("images", [])]
        doc: dict[str, Any] = {
            "schema": "aio.evidence/1",
            "run": params["run"],
            "crs": None,
            "units": "m",
            "crop": region,
            "bounds": None,
            "samples": {"read": 0, "kept": 0, "ground": 0},
            "axis": None,
            "base": None,
            "height": None,
            "slices": [],
            "taper": None,
            "members": [],
            "familyHints": None,
            "colours": [],
            "photos": phot.get("items", []),
            "images": images[:64],
            "reconstruction": "not-needed" if has_cloud else "unavailable",
            "warnings": warnings,
        }
        if not has_cloud:
            if photogrammetry_available():
                warnings.append("Photos only: no point cloud was measured and no reconstruction was run.")
            else:
                warnings.append(
                    "Photos only: no point cloud, and photogrammetry is not available to reconstruct one."
                )
        if params["meshes"]:
            warnings.append("Reference meshes were listed but are not measured yet.")
        if has_cloud:
            crop_o, ground_o = ctx.outputs("crop"), ctx.outputs("ground")
            ax, base = ctx.outputs("axis"), ctx.outputs("axis")["base"]
            sec, mem = ctx.outputs("sections"), ctx.outputs("members")
            axis = _axis_of(ax["axis"])
            dy = axis.dir[1]
            by = float(axis.point[1])
            crs = crop_o.get("crs")
            doc["crs"] = crs
            doc["bounds"] = crop_o["bounds"]
            doc["samples"] = {"read": crop_o["read"], "kept": crop_o["points"], "ground": ground_o["ground"]}
            doc["axis"] = {
                "point": _vec(axis.point),
                "dir": _vec(axis.dir),
                "tiltDeg": min(90.0, max(0.0, float(axis.tilt_deg))),
            }
            doc["base"] = base["point"]
            doc["baseInfo"] = {
                "observed": base["observed"],
                "basis": base["basis"],
                "gapM": max(0.0, base["gap"]),
            }
            if base.get("note"):
                warnings.append(base["note"])
            iso = ground_o["isolation"]
            doc["isolation"] = {
                "components": iso["components"],
                "droppedPoints": iso["droppedPoints"],
                "dropped": iso["dropped"][:8],
            }
            if iso["dropped"]:
                n = len(iso["dropped"])
                warnings.append(
                    f"Excluded {iso['droppedPoints']} points of {n} other structure{'s' if n > 1 else ''} or clutter near the asset."
                )
            doc["slices"] = [
                {
                    "y": by + s["y"] * dy,
                    "centre": s["centre"],
                    "r": s["r"],
                    "residualM": s["residual"],
                    "support": s["support"],
                    "coverage": min(1.0, max(0.0, s["coverage"])),
                    "shape": "circle",
                }
                for s in sec["slices"]
            ][:256]
            prof = sec["taper"]["profile"]
            if prof:
                doc["taper"] = {
                    "profile": [{"y": by + y * dy, "r": r} for y, r in prof][:64],
                    "residualM": sec["taper"]["residual"],
                }
            else:
                warnings.append("No section of the asset could be fitted, so there is no taper.")
            rej = sec["rejected"]
            if rej:
                doc["rejectedSlices"] = {
                    "noFit": rej.get("no-fit", 0),
                    "radiusJump": rej.get("radius-jump", 0),
                    "offAxis": rej.get("off-axis", 0),
                }
                total = sum(rej.values())
                if total:
                    why = ", ".join(f"{n} {k}" for k, n in rej.items() if n)
                    warnings.append(f"Skipped {total} slices ({why}).")
            doc["members"] = mem["members"][:16]
            doc["height"] = mem["height"] if mem["height"] and mem["height"] > 0 else None
            doc["familyHints"] = mem["hints"]
            doc["colours"] = [
                {"y0": by + b["y0"] * dy, "y1": by + b["y1"] * dy, "rgb": b["rgb"]} for b in mem["colours"]
            ][:64]
            if not crop_o["colour"]:
                warnings.append("The cloud has no colour, so there are no colour bands.")
            if not region:
                warnings.append("No region was given: the whole cloud was read.")
        if phot.get("identity"):
            doc["identity"] = phot["identity"]
            if not phot["identity"]["sameAsset"]:
                warnings.append("Some photos do not look like the same asset; they are flagged, not blended.")
        for r in phot.get("rejected", []):
            warnings.append(r[:300])
        doc["warnings"] = [w[:300] for w in warnings][:50]
        return _round(doc)
