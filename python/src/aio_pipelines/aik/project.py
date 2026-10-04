"""Back-project findings from photos onto the 3D model. Ported from Asset Inspection Kit ``kit/project.py``.

For each finding with a bbox (review-copy pixels) and a camera pose, rays are cast through the
photo into the mesh:
  placement "point": the median hit of a small ray grid inside the box -> centre + surface normal
  placement "patch": a ray grid over the box -> a textured surface patch carrying the mask
Camera model: pinhole at ``position`` looking at ``target``, ``up`` (default +Y), FOV ``hfov``/``vfov``.
The pose is only as good as the GPS and gimbal data: treat results as locating aids.
Returns the surface.json document: {"patches": [...], "points": [...], "unmapped": [finding keys]}.
"""

from __future__ import annotations

import base64
import io
import math
import os
import re

import numpy as np
from PIL import Image

from . import masks as M
from . import records


def load_mesh(glb):
    import trimesh

    sc = trimesh.load(glb, force="scene")
    meshes, owner, names = [], [], []
    for node in sc.graph.nodes_geometry:
        T, gname = sc.graph[node]
        g = sc.geometry[gname]
        if not hasattr(g, "faces") or len(g.faces) == 0:
            continue
        m = g.copy()
        m.apply_transform(T)
        meshes.append(m)
        owner.append(np.full(len(m.faces), len(names)))
        names.append(node)
    mesh = trimesh.util.concatenate(meshes)
    return mesh, np.concatenate(owner), names


def camera_rays(p, px, py, W, H):
    C = np.array(p["position"], float)
    T = np.array(p["target"], float)
    up = np.array(p.get("up") or [0, 1, 0], float)
    f = T - C
    f /= np.linalg.norm(f)
    r = np.cross(f, up)
    r /= np.linalg.norm(r)
    u = np.cross(r, f)
    x = (px + 0.5) / W * 2 - 1
    y = 1 - (py + 0.5) / H * 2
    th, tv = math.tan(math.radians(p["hfov"] / 2)), math.tan(math.radians(p["vfov"] / 2))
    d = f[None, :] + x[:, None] * th * r[None, :] + y[:, None] * tv * u[None, :]
    d /= np.linalg.norm(d, axis=1)[:, None]
    return np.repeat(C[None, :], len(d), 0), d, f


def component_name(job, node):
    for rule in job.profile.get("component_map", []) or []:
        if re.search(rule["match"], node, re.I):
            return rule["label"]
    n = re.sub(r"[_\-.]+", " ", node).strip()
    n = re.sub(r"\s*\d+$", "", n)
    return n[:1].upper() + n[1:] if n else None


def cast(mesh, O, D):
    idx_tri, idx_ray, loc = mesh.ray.intersects_id(O, D, multiple_hits=False, return_locations=True)
    hits = np.full((len(O), 3), np.nan)
    tri = np.full(len(O), -1)
    if len(idx_ray):
        hits[idx_ray] = np.asarray(loc).reshape(-1, 3)
        tri[idx_ray] = idx_tri
    return hits, tri


def texture_for(job, f, W, H, mask_arr, colour):
    x0, y0, x1, y1 = (round(v) for v in f["bbox"])
    x0, y0 = max(0, x0), max(0, y0)
    x1, y1 = min(W, x1), min(H, y1)
    if mask_arr is not None:
        sub = mask_arr[y0:y1, x0:x1]
        tex = M.overlay(sub, job.profile, False)
        fin, _ = M.class_sets(job.profile)
        lab = np.isin(sub, fin).astype(np.uint8)
    else:
        w, h = x1 - x0, y1 - y0
        tex = Image.new("RGBA", (w, h), (*colour, 110))
        a = np.array(tex)
        bw = max(2, min(w, h) // 20)
        a[:bw, :, 3] = a[-bw:, :, 3] = a[:, :bw, 3] = a[:, -bw:, 3] = 255
        tex = Image.fromarray(a)
        lab = np.ones((h, w), np.uint8)
    s = min(1.0, 512 / max(tex.size))
    tex = tex.resize((max(1, int(tex.width * s)), max(1, int(tex.height * s))), Image.NEAREST)
    ls = min(1.0, 128 / max(lab.shape))
    labi = Image.fromarray(lab * 255).resize(
        (max(1, int(lab.shape[1] * ls)), max(1, int(lab.shape[0] * ls))), Image.NEAREST
    )
    lab = (np.array(labi) > 0).astype(np.uint8)
    b = io.BytesIO()
    tex.save(b, "PNG", optimize=True)
    return "data:image/png;base64," + base64.b64encode(b.getvalue()).decode(), lab, [x0, y0, x1, y1]


def run(job, grid=48, log=print, check=lambda: None, progress=lambda f, m=None: None):
    R = records.build(job)
    glb = job.p(job.inputs.get("model", "model.glb"))
    if not glb or not os.path.exists(glb):
        from ..runtime import JobError

        raise JobError(f'The model "{job.inputs.get("model", "model.glb")}" was not found.')
    mesh, owner, names = load_mesh(glb)
    H_asset = R["height"]
    mdir = job.p(job.inputs.get("masks", "masks"))
    byp = {p["id"]: p for p in R["photos"]}
    patches, points, unmapped = [], [], []
    oc = {str(s["level"]): s["color"] for s in job.profile["severity"]}
    mode = job.profile.get("placement", "point")
    n = len(R["findings"])
    for idx, f in enumerate(R["findings"]):
        check()
        progress(idx / max(1, n), f"{f['key']}")
        p = byp[f["photo"]]
        if not f.get("bbox"):
            unmapped.append(f["key"])
            continue
        W = p.get("previewWidth") or 2560
        H = p.get("previewHeight") or round(W * p["height"] / p["width"])
        x0, y0, x1, y1 = f["bbox"]
        # median hit of a 5x5 grid in the central half of the box
        gx, gy = np.meshgrid(
            np.linspace(x0 + (x1 - x0) * 0.25, x1 - (x1 - x0) * 0.25, 5),
            np.linspace(y0 + (y1 - y0) * 0.25, y1 - (y1 - y0) * 0.25, 5),
        )
        O, D, fwd = camera_rays(p, gx.ravel(), gy.ravel(), W, H)
        hits, tri = cast(mesh, O, D)
        ok = ~np.isnan(hits[:, 0])
        if not ok.any():
            unmapped.append(f["key"])
            log(f"{f['key']}: no hit on the model")
            continue
        dist = np.linalg.norm(hits[ok] - O[ok], axis=1)
        k = np.argsort(dist)[len(dist) // 2]
        c = hits[ok][k]
        t = tri[ok][k]
        nrm = mesh.face_normals[t].copy()
        if np.dot(nrm, -fwd) < 0:
            nrm = -nrm
        comp = f.get("component_given") or component_name(job, names[owner[t]])
        if mode != "patch":
            points.append(
                {
                    "finding": f["key"],
                    "photo": p["id"],
                    "center": c.round(4).tolist(),
                    "normal": nrm.round(4).tolist(),
                    "component": comp,
                }
            )
            continue
        # patch: ray grid over the box
        gw = grid
        gh = max(2, round(grid * (y1 - y0) / max(1, x1 - x0)))
        gh = min(gh, grid * 2)
        us, vs = np.linspace(0, 1, gw), np.linspace(0, 1, gh)
        U, V = np.meshgrid(us, vs)
        O, D, fwd = camera_rays(p, (x0 + U * (x1 - x0)).ravel(), (y0 + V * (y1 - y0)).ravel(), W, H)
        hits, tri = cast(mesh, O, D)
        P3 = hits.reshape(gh, gw, 3)
        with np.errstate(invalid="ignore"):
            step = np.nanmedian(np.linalg.norm(np.diff(P3, axis=1), axis=2)) if gw > 1 else 0.1
        thr = max(step * 4, 1e-3)
        pos, uv = [], []
        off = -fwd * H_asset * 0.00025
        for j in range(gh - 1):
            for i in range(gw - 1):
                q = [P3[j, i], P3[j, i + 1], P3[j + 1, i + 1], P3[j + 1, i]]
                if any(np.isnan(v[0]) for v in q):
                    continue
                if max(np.linalg.norm(q[a] - q[(a + 1) % 4]) for a in range(4)) > thr:
                    continue
                quv = [
                    (us[i], 1 - vs[j]),
                    (us[i + 1], 1 - vs[j]),
                    (us[i + 1], 1 - vs[j + 1]),
                    (us[i], 1 - vs[j + 1]),
                ]
                for a, b_, c_ in ((0, 1, 2), (0, 2, 3)):
                    for v_, t_ in ((q[a], quv[a]), (q[b_], quv[b_]), (q[c_], quv[c_])):
                        pos.append(v_ + off)
                        uv.append(t_)
        if not pos:
            unmapped.append(f["key"])
            continue
        mp = os.path.join(mdir, p["id"] + ".png") if mdir else None
        arr = M.load(mp) if mp and os.path.exists(mp) else None
        colour = tuple(int(oc.get(f["outcome"], "#ff7a2d").lstrip("#")[i : i + 2], 16) for i in (0, 2, 4))
        tex, lab, crop = texture_for(job, f, W, H, arr, colour)
        pa = np.array(pos, np.float32)
        ext = pa.max(0) - pa.min(0)
        horiz = float(np.hypot(ext[0], ext[2]))
        patches.append(
            {
                "id": "surface-" + f["key"],
                "finding": f["key"],
                "photo": p["id"],
                "component": comp,
                "textureData": tex,
                "labelWidth": int(lab.shape[1]),
                "labelHeight": int(lab.shape[0]),
                "labels": base64.b64encode(lab.tobytes()).decode(),
                "sourceCrop": crop,
                "sourceGrid": [W, H],
                "placement": "Back-projected from the estimated camera pose",
                "center": c.round(4).tolist(),
                "direction": ((nrm + (-fwd)) / np.linalg.norm(nrm - fwd)).round(4).tolist(),
                "size": [round(horiz, 3), round(float(ext[1]), 3)],
                "positions": base64.b64encode(pa.tobytes()).decode(),
                "uvs": base64.b64encode(np.array(uv, np.float32).tobytes()).decode(),
                "vertexCount": len(pos),
            }
        )
        log(f"{f['key']}: patch of {len(pos) // 3} triangles at {c.round(2).tolist()}")
    log(f"{len(patches)} patches, {len(points)} points, {len(unmapped)} unmapped")
    return {
        "version": 1,
        "method": "kit back-projection",
        "patches": patches,
        "points": points,
        "unmapped": unmapped,
    }
