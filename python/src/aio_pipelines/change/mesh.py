"""change.mesh: deviation of the later 3D model from the earlier one, and the tagged part diff.

Both models are read with trimesh into the project local frame (each layer's ``transform`` after
each node's own). Parts are the GLB nodes, matched by name with the survey key stripped when every
node of a model ends in the same ``_<key>`` (``P05_e2`` is ``P05``, as ``captures.ts`` does, and the
names the model builder gives, data-conventions section 15):

- a part only on the later date is ``added``, only on the earlier one ``removed``;
- a part whose bounding box kept its size but whose centre moved more than ``minDistM`` is
  ``moved`` (``offsetM``);
- else points sampled on the later part are measured to the earlier part (trimesh proximity with
  rtree): ``changed`` when the mean deviation reaches ``minDistM`` or at least 1% of the part, or
  1 m2 of its surface, does (a local dent), else ``unchanged``.

The registration check measures points sampled on the whole later model to the whole earlier one,
and the median offset of the parts found on both dates (three or more): both must stay within 5 cm. A copy of the later model with the deviation as vertex colours
(``COLOR_0``: grey below ``minDistM``, through amber to red at ``maxDistM``) is added as a derived
mesh layer (hidden at first, as it lies on the later model), with ``component`` items in a change
set.
"""

from __future__ import annotations

import io
import json
import re
from typing import Any, ClassVar

import numpy as np

from ..params import number
from ..runtime import JobError, Step, StepContext, atomic_write_bytes, commit_files
from .changeset import change_set, change_set_id, dump_change_set, write_change_set
from .cloud import TOLERANCE_M, registration, validate_pair
from .derived import (
    capture_label,
    capture_pair,
    default_out,
    find_layer,
    layer_file,
    read_manifest,
    rounded,
    upsert_layer,
)

SUFFIX = re.compile(r"_([A-Za-z0-9]+)$")
DEFAULT_SAMPLES = 50_000
#: A part has changed when this share of it deviates by ``minDistM`` or more,
CHANGED_SHARE = 0.01
#: or this much of its surface (m2) does: a local dent on a large part (a tank) is under 1%.
CHANGED_AREA_M2 = 1.0
GREY = np.array([156, 163, 175], dtype=np.float64)
AMBER = np.array([245, 197, 66], dtype=np.float64)
RED = np.array([226, 65, 43], dtype=np.float64)


def part_names(nodes: list[str]) -> dict[str, str]:
    """Node name to part name: the survey key stripped when every node carries the same one."""
    keys = {m.group(1) if (m := SUFFIX.search(n)) else None for n in nodes}
    if nodes and len(keys) == 1 and None not in keys:
        return {n: SUFFIX.sub("", n) for n in nodes}
    return {n: n for n in nodes}


def load_parts(path, transform: list[float] | None) -> dict[str, tuple[Any, Any]]:
    """Node name to (mesh in the node's own frame baked, mesh in the project local frame)."""
    import trimesh

    try:
        scene = trimesh.load(str(path), force="scene")
    except Exception as e:
        raise JobError(f"The model {path.name} could not be read: {e}") from e
    layer = np.array(transform, dtype=np.float64).reshape(4, 4).T if transform else np.eye(4)
    parts: dict[str, tuple[Any, Any]] = {}
    for node in scene.graph.nodes_geometry:
        mat, gname = scene.graph[node]
        g = scene.geometry.get(gname)
        if not isinstance(g, trimesh.Trimesh) or not len(g.faces):
            continue
        own = g.copy()
        own.apply_transform(mat)
        local = own.copy()
        local.apply_transform(layer)
        parts[str(node)] = (own, local)
    if not parts:
        raise JobError(f"The model {path.name} has no surfaces to compare.")
    return parts


def _distance(target, points: np.ndarray) -> np.ndarray:
    import trimesh

    if not len(points):
        return np.zeros(0)
    _, d, _ = trimesh.proximity.closest_point(target, points)
    return np.asarray(d, dtype=np.float64)


def deviation_colours(d: np.ndarray, lo: float, hi: float) -> np.ndarray:
    """Linear RGBA uint8 per value: grey below ``lo``, amber half way to ``hi``, red from ``hi``."""
    t = np.clip((np.abs(d) - lo) / max(hi - lo, 1e-6), 0, 1)[:, None]
    first = GREY + (AMBER - GREY) * np.clip(t * 2, 0, 1)
    second = AMBER + (RED - AMBER) * np.clip(t * 2 - 1, 0, 1)
    rgb = np.where(t <= 0.5, first, second)
    rgb[np.abs(d) < lo] = GREY
    # glTF vertex colours are linear; the stops above are display (sRGB) colours
    linear = np.power(rgb / 255.0, 2.2) * 255.0
    return np.column_stack([np.round(linear).astype(np.uint8), np.full(len(d), 255, dtype=np.uint8)])


class ChangeMesh:
    name = "change.mesh"
    title = "3D model change"
    description = "Model deviation colours, and tagged parts added, removed, moved or changed."
    keys: ClassVar[frozenset[str]] = frozenset(
        {"layerFrom", "layerTo", "captures", "samples", "minDistM", "maxDistM", "out"}
    )

    def validate(self, params: dict[str, Any]) -> dict[str, Any]:
        out = validate_pair(params, self.name, self.keys)
        samples = number(params, "samples", DEFAULT_SAMPLES, 1000, 50_000_000, integer=True)
        out["samples"] = int(samples or DEFAULT_SAMPLES)
        return out

    def plan(self, params: dict[str, Any]) -> list[Step]:
        lo_d, far_d = float(params["minDistM"]), float(params["maxDistM"])

        def compare(ctx: StepContext) -> dict[str, Any]:
            import trimesh

            manifest = read_manifest(ctx.project)
            a = find_layer(manifest, params["layerFrom"], "mesh", "3D model")
            b = find_layer(manifest, params["layerTo"], "mesh", "3D model")
            frm, to = capture_pair(params, a, b)
            set_id = change_set_id(frm, to, self.name)
            ctx.progress(0.05, "Read the models")
            before = load_parts(layer_file(ctx.project, a), a.get("transform"))
            after = load_parts(layer_file(ctx.project, b), b.get("transform"))
            ctx.check()

            whole_a = trimesh.util.concatenate([m for _, m in before.values()])
            whole_b = trimesh.util.concatenate([m for _, m in after.values()])
            samples, _ = trimesh.sample.sample_surface(whole_b, int(params["samples"]), seed=1)
            ctx.progress(0.2, "Check that the dates line up")
            d_all = _distance(whole_a, samples)
            names_a = part_names(list(before))
            names_b = part_names(list(after))
            by_a = {p: n for n, p in names_a.items()}
            by_b = {p: n for n, p in names_b.items()}
            # a surface sliding along itself measures nothing, so the parts' centres count too
            shift = float(np.median(d_all)) if len(d_all) else 0.0
            matched = [p for p in by_a if p in by_b]
            if len(matched) >= 3:
                offsets = np.array(
                    [
                        np.asarray(after[by_b[p]][1].bounds).mean(axis=0)
                        - np.asarray(before[by_a[p]][1].bounds).mean(axis=0)
                        for p in matched
                    ]
                )
                shift = max(shift, float(np.linalg.norm(np.median(offsets, axis=0))))
            reg = registration(shift, TOLERANCE_M)
            ctx.log(
                f"Models line up within {reg['shiftM']:.3f} m ({len(samples):,} points, {len(matched)} parts)."
            )
            if not reg["ok"]:
                raise JobError(reg["message"].replace("the clouds are", "the models are"))
            ctx.check()

            items: list[dict[str, Any]] = []
            parts = sorted(set(by_a) | set(by_b))
            for i, part in enumerate(parts):
                ctx.check()
                ctx.progress(0.3 + 0.4 * i / max(len(parts), 1), f"Part {part}")
                items.append(self._part(part, by_a.get(part), by_b.get(part), before, after, params, lo_d))

            # the deviation model: later parts in their own frame, coloured per vertex
            ctx.progress(0.75, "Colour the deviation model")
            out_scene = trimesh.Scene()
            for node, (own, local) in after.items():
                d = _distance(whole_a, np.asarray(local.vertices))
                coloured = trimesh.Trimesh(own.vertices, own.faces, process=False)
                coloured.visual = trimesh.visual.ColorVisuals(
                    coloured, vertex_colors=deviation_colours(d, lo_d, far_d)
                )
                out_scene.add_geometry(coloured, node_name=node, geom_name=node)
            buf = io.BytesIO()
            buf.write(out_scene.export(file_type="glb"))
            atomic_write_bytes(ctx.stage("deviation.glb"), buf.getvalue())

            counts = {
                v: sum(it["verdict"] == v for it in items) for v in ("added", "removed", "moved", "changed")
            }
            stats = {
                "parts": len(items),
                **counts,
                "unchanged": sum(it["verdict"] == "unchanged" for it in items),
                "samples": len(samples),
                "medianM": round(float(np.median(d_all)), 4) if len(d_all) else 0.0,
                "p95M": round(float(np.percentile(d_all, 95)), 4) if len(d_all) else 0.0,
                "shiftM": reg["shiftM"],
            }
            cs = change_set(
                set_id,
                frm,
                to,
                self.name,
                items,
                layers=[set_id],
                stats=stats,
                run={"jobId": ctx.job.job_id, "params": dict(params)},
                registration=reg,
            )
            atomic_write_bytes(ctx.stage("changeset.json"), dump_change_set(cs))
            ctx.log(
                f"{len(items)} parts: {counts['added']} new, {counts['removed']} gone, "
                f"{counts['moved']} moved, {counts['changed']} changed."
            )
            return {
                "from": frm,
                "to": to,
                "setId": set_id,
                "out": params.get("out") or default_out(set_id),
            }

        def commit(ctx: StepContext) -> dict[str, Any]:
            prep = ctx.outputs("compare")
            manifest = read_manifest(ctx.project)
            later = find_layer(manifest, params["layerTo"], "mesh", "3D model")
            set_id, out, frm, to = prep["setId"], prep["out"], prep["from"], prep["to"]
            glb_rel = f"{out}/deviation.glb"
            commit_files(ctx, [("deviation.glb", glb_rel)])
            data = json.loads(ctx.stage("changeset.json").read_text("utf-8"))
            write_change_set(ctx.out(f"change/{set_id}.json"), data)
            ctx.artifact(f"change/{set_id}.json")
            layer: dict[str, Any] = {
                "kind": "mesh",
                "id": set_id,
                "name": f"Model change {capture_label(manifest, frm)} to {capture_label(manifest, to)}",
                # it lies on the later model: shown when the person turns it on
                "visible": False,
                "capture": to,
                "derived": {
                    "kind": "change",
                    "from": frm,
                    "to": to,
                    "changeId": set_id,
                    "runId": ctx.job.job_id,
                    "source": [params["layerFrom"], params["layerTo"]],
                },
                "src": {"path": glb_rel},
                "transform": later.get("transform"),
            }
            if later.get("tags"):
                layer["tags"] = later["tags"]
            upsert_layer(ctx.project, layer)
            ctx.log(f"Added the layer {set_id} ({glb_rel}).")
            return {"layer": set_id, "changeSet": f"change/{set_id}.json"}

        return [
            Step("compare", "Compare the models part by part", compare, weight=6),
            Step("commit", "Add the deviation model and the change set", commit, weight=0.5),
        ]

    def _part(
        self,
        part: str,
        node_a: str | None,
        node_b: str | None,
        before: dict[str, tuple[Any, Any]],
        after: dict[str, tuple[Any, Any]],
        params: dict[str, Any],
        lo_d: float,
    ) -> dict[str, Any]:
        import trimesh

        item: dict[str, Any] = {
            "kind": "component",
            "id": f"component:{part}",
            "part": part,
            "method": "node-name",
            "layerFrom": params["layerFrom"],
            "layerTo": params["layerTo"],
        }
        if node_a:
            item["nodeFrom"] = node_a
        if node_b:
            item["nodeTo"] = node_b
        ma = before[node_a][1] if node_a else None
        mb = after[node_b][1] if node_b else None
        shown = mb if mb is not None else ma
        assert shown is not None
        bounds = np.asarray(shown.bounds)
        item["at"] = rounded(bounds.mean(axis=0))
        item["bounds"] = {"min": rounded(bounds[0]), "max": rounded(bounds[1])}
        if ma is None:
            return {**item, "verdict": "added", "label": f"{part} is new", "score": 1.0}
        if mb is None:
            return {**item, "verdict": "removed", "label": f"{part} is gone", "score": 1.0}
        ba, bb = np.asarray(ma.bounds), np.asarray(mb.bounds)
        offset = bb.mean(axis=0) - ba.mean(axis=0)
        resized = np.abs((bb[1] - bb[0]) - (ba[1] - ba[0])).max()
        dist = float(np.linalg.norm(offset))
        if dist > lo_d and resized <= lo_d:
            return {
                **item,
                "verdict": "moved",
                "label": f"{part} moved {dist:.2f} m",
                "offsetM": rounded(offset),
                "score": round(min(1.0, dist / float(params["maxDistM"])), 3),
            }
        n = int(np.clip(mb.area / 0.004, 500, 20_000))
        pts, _ = trimesh.sample.sample_surface(mb, n, seed=2)
        on_surface = _distance(ma, pts)
        d = np.concatenate([on_surface, _distance(ma, np.asarray(mb.vertices))])
        mean, top = float(d.mean()), float(d.max())
        share = float((d >= lo_d).mean())
        # the samples are spread by area, so their share is a share of the surface
        area = float((on_surface >= lo_d).mean()) * float(mb.area)
        item["deviation"] = {"meanM": round(mean, 4), "maxM": round(top, 4)}
        if mean >= lo_d or share >= CHANGED_SHARE or area >= CHANGED_AREA_M2:
            return {
                **item,
                "verdict": "changed",
                "label": f"{part} changed: up to {top:.2f} m",
                "score": round(min(1.0, top / float(params["maxDistM"])), 3),
            }
        return {**item, "verdict": "unchanged", "label": f"{part} unchanged", "score": 0.0}
