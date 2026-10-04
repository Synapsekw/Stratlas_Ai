"""Write the builder sample datasets (inspection, volumetric, road) from data already on this machine.

    uv run python scripts/make_samples.py <out folder> [hcl] [masafi] [road] [--data "E:/Stratlas Data"]

Every source is only read: the HCl project and its 1280 px photos, the Masafi kit grids and ortho
tiles, the 1st Ring Road project and its NAS sources. Each set lands in ``<out>/<name>/`` with its
inputs and a ``sample.json`` of the facts the README and the env-gated e2e
(``apps/desktop/e2e/samples.spec.ts``) use.

- ``inspection-hcl-mini``: 20 HCl tank photos with EXIF GPS and DJI XMP (position, absolute
  altitude, gimbal angles) written from the delivered camera poses, the tank GLB, and one
  ``aio.detections/1`` pass made by projecting the delivered findings into those photos.
- ``volumetric-masafi-mini``: two survey dates (DSM and ortho GeoTIFFs) cropped from the Masafi kit
  grids around three piles, written the way ``verify_masafi_build.py`` writes the full yard.
- ``road-ringroad-mini``: the 1st Ring Road km 3.0 to 3.25 as an ortho GeoTIFF cut from the NAS
  blocks, its centreline (GeoJSON with chainage) and the defect polygons along it (GeoJSON).
"""

from __future__ import annotations

import argparse
import json
import math
import shutil
import struct
import sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent


def write_json(path: Path, doc) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(doc, indent=1, ensure_ascii=False) + "\n", "utf-8")


def wgs84(epsg: int, es: list[float], ns: list[float]) -> tuple[list[float], list[float]]:
    from rasterio.warp import transform

    lon, lat = transform(f"EPSG:{epsg}", "EPSG:4326", es, ns)
    return list(lon), list(lat)


# ============================================================================== inspection (HCl)

HCL_PHOTOS = 20
HCL_HFOV = 70.0  # the HCl photos carry no lens: the pipeline's default (the kit's 70 degrees)
HCL_SIZE = (1280, 960)


def _qmul(a, b):
    ax, ay, az, aw = a
    bx, by, bz, bw = b
    return (
        aw * bx + ax * bw + ay * bz - az * by,
        aw * by - ax * bz + ay * bw + az * bx,
        aw * bz + ax * by - ay * bx + az * bw,
        aw * bw - ax * bx - ay * by - az * bz,
    )


def _qrot(q, v):
    x, y, z, w = q
    return _qmul(_qmul(q, (v[0], v[1], v[2], 0.0)), (-x, -y, -z, w))[:3]


def _axis(axis: int, deg: float):
    h = math.radians(deg) / 2
    v = [0.0, 0.0, 0.0]
    v[axis] = math.sin(h)
    return (v[0], v[1], v[2], math.cos(h))


def gimbal_from_quat(q) -> tuple[float, float, float]:
    """Inverse of @aio/geo cameraQuatFromGimbal: q = Ry(-yaw) Rx(pitch) Rz(-roll), degrees."""
    from scipy.spatial.transform import Rotation

    q = tuple(np.asarray(q, dtype=float) / np.linalg.norm(q))
    a, b, c = Rotation.from_quat(q).as_euler("YXZ", degrees=True)
    yaw, pitch, roll = -a, b, -c
    back = _qmul(_qmul(_axis(1, -yaw), _axis(0, pitch)), _axis(2, -roll))
    err = 1 - abs(sum(x * y for x, y in zip(back, q, strict=True)))
    assert err < 1e-9, (q, back)
    return yaw, pitch, roll


def _exif(o: dict) -> bytes:
    """EXIF APP1 payload (port of @aio/project builder/testing exifSegment, little-endian)."""
    ASCII, SHORT, LONG, RATIONAL, BYTE = 2, 3, 4, 5, 1

    def rational(vals):
        return b"".join(struct.pack("<II", round(x * 10000), 10000) for x in vals)

    def ascii_(s):
        return s.encode() + b"\0"

    def dms(deg):
        a = abs(deg)
        d = math.floor(a)
        m = math.floor((a - d) * 60)
        return rational([d, m, (a - d - m / 60) * 3600])

    size = {RATIONAL: 8, SHORT: 2, LONG: 4, ASCII: 1, BYTE: 1}
    ifd0, exif, gps = [], [], []

    def add(lst, tag, typ, data):
        lst.append([tag, typ, len(data) // size[typ], data])

    add(ifd0, 0x010F, ASCII, ascii_(o["make"]))
    add(ifd0, 0x0110, ASCII, ascii_(o["model"]))
    add(exif, 0x9003, ASCII, ascii_(o["dateTimeOriginal"]))
    add(exif, 0x9011, ASCII, ascii_(o["offsetTimeOriginal"]))
    add(exif, 0xA002, LONG, struct.pack("<I", o["width"]))
    add(exif, 0xA003, LONG, struct.pack("<I", o["height"]))
    add(gps, 1, ASCII, ascii_("N" if o["lat"] >= 0 else "S"))
    add(gps, 2, RATIONAL, dms(o["lat"]))
    add(gps, 3, ASCII, ascii_("E" if o["lon"] >= 0 else "W"))
    add(gps, 4, RATIONAL, dms(o["lon"]))
    add(gps, 5, BYTE, bytes([1 if o["alt"] < 0 else 0]))
    add(gps, 6, RATIONAL, rational([abs(o["alt"])]))

    def ifd_size(n):
        return 2 + n * 12 + 4

    def extra(lst):
        return sum(len(e[3]) + len(e[3]) % 2 for e in lst if len(e[3]) > 4)

    exif_at = 8 + ifd_size(len(ifd0) + 2) + extra(ifd0)
    gps_at = exif_at + ifd_size(len(exif)) + extra(exif)
    add(ifd0, 0x8769, LONG, struct.pack("<I", exif_at))
    add(ifd0, 0x8825, LONG, struct.pack("<I", gps_at))
    parts = []

    def write(lst, at):
        lst.sort(key=lambda e: e[0])
        head = bytearray(ifd_size(len(lst)))
        struct.pack_into("<H", head, 0, len(lst))
        data_at = at + len(head)
        blobs = []
        for i, (tag, typ, count, data) in enumerate(lst):
            p = 2 + i * 12
            struct.pack_into("<HHI", head, p, tag, typ, count)
            if len(data) <= 4:
                head[p + 8 : p + 8 + len(data)] = data
            else:
                struct.pack_into("<I", head, p + 8, data_at)
                padded = data + b"\0" * (len(data) % 2)
                blobs.append(padded)
                data_at += len(padded)
        parts.append(bytes(head))
        parts.extend(blobs)
        return data_at

    off = write(ifd0, 8)
    off = write(exif, off)
    write(gps, off)
    return b"Exif\0\0" + b"II" + struct.pack("<HI", 42, 8) + b"".join(parts)


def _xmp(dji: dict[str, str]) -> bytes:
    attrs = "\n".join(f'   drone-dji:{k}="{v}"' for k, v in dji.items())
    xml = (
        '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">'
        '<rdf:Description rdf:about="DJI Meta Data" xmlns:drone-dji="http://www.dji.com/drone-dji/1.0/"\n'
        f"{attrs}>\n</rdf:Description></rdf:RDF></x:xmpmeta>"
    )
    return b"http://ns.adobe.com/xap/1.0/\0" + xml.encode()


def _with_meta(jpeg: bytes, exif: bytes, xmp: bytes) -> bytes:
    assert jpeg[:2] == b"\xff\xd8"
    seg = b"".join(b"\xff\xe1" + struct.pack(">H", len(p) + 2) + p for p in (exif, xmp))
    return jpeg[:2] + seg + jpeg[2:]


def photo_id(stem: str) -> str:
    """The id the app's raw import gives a photo (@aio/project builder slug)."""
    import re
    import unicodedata

    v = re.sub(r"[^a-z0-9]+", "-", unicodedata.normalize("NFKD", stem).lower()).strip("-")
    return v or "photo"


def hcl(data: Path, out: Path) -> dict:
    from datetime import datetime, timedelta

    import trimesh

    proj = data / "projects" / "hcl"
    m = json.loads((proj / "manifest.json").read_text("utf-8"))
    issues = json.loads((proj / "issues.json").read_text("utf-8"))["issues"]
    epsg = m["crs"]["epsg"]
    mesh_layer = next(lyr for lyr in m["layers"] if lyr["kind"] == "mesh")
    T = np.array(mesh_layer["transform"], dtype=float).reshape(4, 4).T  # column-major
    R = T[:3, :3]
    assert np.allclose(T[:3, 3], 0) and np.allclose(R @ R.T, np.eye(3)), "mesh transform is not a rotation"
    Rinv = R.T
    # the rotation as a quaternion (glTF to the project frame), to turn camera poses into the GLB frame
    from scipy.spatial.transform import Rotation

    q_inv = tuple(Rotation.from_matrix(Rinv).as_quat())

    def to_glb(p):
        return tuple(float(v) for v in Rinv @ np.asarray(p, dtype=float))

    glb = data / "projects" / "hcl" / mesh_layer["src"]["path"]
    mesh = trimesh.load(glb, force="mesh")
    from trimesh.ray.ray_triangle import RayMeshIntersector

    ray = RayMeshIntersector(mesh)

    photos = {i["id"]: i for lyr in m["layers"] if lyr["kind"] == "photos" for i in lyr["items"]}
    src_dir = data / "sources" / "hcl" / "photos"
    cands = sorted(f.stem for f in src_dir.glob("*.jpg") if f.stem in photos and not f.stem.startswith("F"))
    W, H = HCL_SIZE
    f_px = W / 2 / math.tan(math.radians(HCL_HFOV) / 2)

    def pose(pid):
        it = photos[pid]
        return to_glb(it["pos"]), _qmul(q_inv, tuple(it["q"]))

    def pixel(pid, p):
        c, q = pose(pid)
        rel = _qrot((-q[0], -q[1], -q[2], q[3]), (p[0] - c[0], p[1] - c[1], p[2] - c[2]))
        if rel[2] >= -0.2:
            return None
        x = W / 2 + f_px * rel[0] / -rel[2]
        y = H / 2 - f_px * rel[1] / -rel[2]
        if not (40 <= x <= W - 40 and 40 <= y <= H - 40):
            return None
        # visible: the first hit from the camera is the point itself
        d = np.array(p) - np.array(c)
        dist = float(np.linalg.norm(d))
        hits, _, _ = ray.intersects_location([c], [d / dist], multiple_hits=False)
        if len(hits) == 0 or abs(float(np.linalg.norm(hits[0] - np.array(c))) - dist) > 0.05:
            return None
        return (x, y, dist)

    # findings with mesh points, in the GLB frame
    findings = []
    for i in issues:
        pts = [
            to_glb(s["geom"]["p"])
            for s in i["sightings"]
            if s["on"] == "mesh" and s["geom"]["type"] == "spoint"
        ]
        if pts:
            findings.append({"issue": i, "pts": pts})
    seen = {}  # (finding index, point index) -> [(photo, x, y, dist)]
    for fi, fnd in enumerate(findings):
        for pi, p in enumerate(fnd["pts"]):
            for pid in cands:
                r = pixel(pid, p)
                if r:
                    seen.setdefault((fi, pi), []).append((pid, *r))
    # 20 photos: greedily the ones that see the most finding points not yet seen twice
    chosen: list[str] = []
    count: dict[tuple[int, int], int] = {}
    while len(chosen) < HCL_PHOTOS:
        best, gain = None, -1
        for pid in cands:
            if pid in chosen:
                continue
            g = sum(1 for k, v in seen.items() if count.get(k, 0) < 2 and any(s[0] == pid for s in v))
            if g > gain:
                best, gain = pid, g
        if best is None:
            break
        chosen.append(best)
        for k, v in seen.items():
            if any(s[0] == best for s in v):
                count[k] = count.get(k, 0) + 1
    chosen.sort()

    # origin: the delivered (approximate) origin, rounded to 7 decimals of a degree
    lon0, lat0 = wgs84(epsg, [m["origin"][0]], [m["origin"][1]])
    lat0, lon0 = round(lat0[0], 7), round(lon0[0], 7)
    from rasterio.warp import transform as warp

    E0s, N0s = warp("EPSG:4326", f"EPSG:{epsg}", [lon0], [lat0])
    E0, N0, H0 = E0s[0], N0s[0], float(m["origin"][2])
    pdir = out / "photos"
    pdir.mkdir(parents=True, exist_ok=True)
    poses = {}
    for pid in chosen:
        c, q = pose(pid)
        poses[photo_id(pid)] = {"pos": [round(v, 4) for v in c], "q": [round(v, 7) for v in q]}
        E, N, alt = E0 + c[0], N0 - c[2], H0 + c[1]
        # true north yaw = grid yaw + convergence (@aio/geo gridConvergenceDeg)
        lo, la = wgs84(epsg, [E], [N])
        a = warp("EPSG:4326", f"EPSG:{epsg}", [lo[0], lo[0]], [la[0] - 1e-4, la[0] + 1e-4])
        conv = -math.degrees(math.atan2(a[0][1] - a[0][0], a[1][1] - a[1][0]))
        yaw, pitch, roll = gimbal_from_quat(q)
        yaw = (yaw + conv + 180) % 360 - 180
        t = datetime.fromisoformat(photos[pid]["takenAt"].replace("Z", "+00:00")) + timedelta(hours=3)
        exif = _exif(
            {
                "make": "DJI",
                "model": "HCl tank sample (pose from the delivered survey)",
                "dateTimeOriginal": t.strftime("%Y:%m:%d %H:%M:%S"),
                "offsetTimeOriginal": "+03:00",
                "width": W,
                "height": H,
                "lat": la[0],
                "lon": lo[0],
                "alt": alt,
            }
        )
        xmp = _xmp(
            {
                "GpsLatitude": f"{la[0]:.10f}",
                "GpsLongitude": f"{lo[0]:.10f}",
                "AbsoluteAltitude": f"{alt:+.3f}",
                "GimbalYawDegree": f"{yaw:+.4f}",
                "GimbalPitchDegree": f"{pitch:+.4f}",
                "GimbalRollDegree": f"{roll:+.4f}",
            }
        )
        (pdir / f"{pid}.jpg").write_bytes(_with_meta((src_dir / f"{pid}.jpg").read_bytes(), exif, xmp))
    shutil.copyfile(glb, out / glb.name)

    # one AI pass: boxes around the delivered findings in the chosen photos; a reviewer accepted
    # those of the first half of the findings, the rest wait as drafts, plus one false alarm
    dets = []
    per_finding: dict[int, list[dict]] = {}
    for (fi, pi), views in sorted(seen.items()):
        for pid, x, y, dist in views:
            if pid not in chosen:
                continue
            fnd = findings[fi]
            half = max(24.0, min(90.0, 0.35 * f_px / dist))  # about 35 cm on the lining
            per_finding.setdefault(fi, []).append(
                {
                    "photo": photo_id(pid),
                    "class": fnd["issue"]["classId"],
                    "severity": fnd["issue"]["severity"],
                    "bbox": [
                        round(max(0.0, x - half), 1),
                        round(max(0.0, y - half), 1),
                        round(min(W, x + half), 1),
                        round(min(H, y + half), 1),
                    ],
                    "point": pi,
                    "dist": dist,
                }
            )
    # per finding one point (the one most photos see) and its two nearest views: one box per photo
    kept = []
    for fi, lst in sorted(per_finding.items()):
        by_point: dict[int, list[dict]] = {}
        for d in sorted(lst, key=lambda d: d["dist"]):
            if all(v["photo"] != d["photo"] for v in by_point.get(d["point"], [])):
                by_point.setdefault(d["point"], []).append(d)
        _, views = max(sorted(by_point.items()), key=lambda kv: min(len(kv[1]), 2))
        kept.extend((fi, v) for v in views[:2])
    accepted_findings = sorted({fi for fi, _ in kept})[: max(1, len({fi for fi, _ in kept}) // 2)]
    for n, (fi, v) in enumerate(kept, start=1):
        acc = fi in accepted_findings
        code = findings[fi]["issue"]["code"]
        d = {
            "id": f"hcl-ai-{n:03d}",
            "photo": v["photo"],
            "class": v["class"],
            "severity": v["severity"],
            "confidence": round(0.93 - 0.02 * (n % 9), 2),
            "status": "accepted" if acc else "draft",
            "bbox": v["bbox"],
            "space": "source",
            "width": W,
            "height": H,
            "note": f"Near delivered finding {code}",
        }
        if acc:
            d |= {"reviewedBy": "sample reviewer", "reviewedAt": "2026-10-04T12:00:00Z"}
        dets.append(d)
    # a false alarm to reject: a box on the first photo away from every finding
    dets.append(
        {
            "id": "hcl-ai-fa1",
            "photo": photo_id(chosen[0]),
            "class": "corrosion",
            "severity": 2,
            "confidence": 0.41,
            "status": "draft",
            "bbox": [60.0, 60.0, 160.0, 140.0],
            "space": "source",
            "width": W,
            "height": H,
            "note": "Shadow on the lining (false alarm)",
        }
    )
    pass_file = {
        "schema": "aio.detections/1",
        "source": "ai",
        "producer": "sample AI pass (boxes placed on the delivered HCl findings)",
        "createdAt": "2026-10-04T11:00:00Z",
        "run": {
            "id": "sample-run-1",
            "at": "2026-10-04T11:00:00Z",
            "provider": "sample",
            "model": "delivered-findings",
            "promptVersion": "sample-1",
            "images": len(chosen),
            "detections": len(dets),
        },
        "detections": dets,
    }
    write_json(out / "detections" / "hcl-ai-pass.json", pass_file)
    facts = {
        "name": "inspection-hcl-mini",
        "epsg": epsg,
        "origin": [round(E0, 3), round(N0, 3), H0],
        "originLatLon": [lat0, lon0],
        "photos": chosen,
        "poses": poses,
        "glb": glb.name,
        "detections": {
            "accepted": sum(1 for d in dets if d["status"] == "accepted"),
            "draft": sum(1 for d in dets if d["status"] == "draft"),
            "acceptedFindings": [findings[fi]["issue"]["code"] for fi in accepted_findings],
            "draftFindings": sorted(
                {findings[fi]["issue"]["code"] for fi, _ in kept}
                - {findings[fi]["issue"]["code"] for fi in accepted_findings}
            ),
        },
        "findings": {
            findings[fi]["issue"]["code"]: {
                "class": findings[fi]["issue"]["classId"],
                "severity": findings[fi]["issue"]["severity"],
                "points": [[round(c, 3) for c in p] for p in findings[fi]["pts"]],
            }
            for fi in sorted({fi for fi, _ in kept})
        },
    }
    write_json(out / "sample.json", facts)
    return facts


# ============================================================================ volumetric (Masafi)

#: The delivered piles the sample covers. The yard is packed (neighbouring piles touch), so the
#: survey area is their convex hull grown by MASAFI_MARGIN_M; outside it the DSM is nodata and the
#: ortho transparent, like the edge of a Pix4D DSM. No other pile reaches into it.
MASAFI_PILES = ("P06", "P07")
MASAFI_MARGIN_M = 12.0
MASAFI_ORTHO_Z, MASAFI_ORTHO_RES = 5, 0.03


def masafi(data: Path, out: Path) -> dict:
    import rasterio
    from PIL import Image
    from rasterio.features import geometry_mask
    from rasterio.transform import from_origin
    from rasterio.windows import Window
    from shapely.affinity import affine_transform
    from shapely.geometry import Polygon, mapping
    from shapely.ops import unary_union

    src = data / "sources" / "masafi"
    kit = json.loads((src / "job.json").read_text("utf-8"))
    ref_m = json.loads((data / "projects" / "masafi" / "manifest.json").read_text("utf-8"))
    ref_v = json.loads((data / "projects" / "masafi" / "volumes.json").read_text("utf-8"))
    G = kit["grid"]
    ox, oy, oh = ref_m["origin"]
    rings = {
        p["id"]: unary_union([Polygon(e["ring"]).buffer(0) for e in p["epochs"].values()])
        for p in ref_v["piles"]
    }
    local = unary_union([rings[i] for i in MASAFI_PILES]).convex_hull.buffer(MASAFI_MARGIN_M)
    for o, g in rings.items():
        if o not in MASAFI_PILES and local.intersects(g):
            raise SystemExit(f"the Masafi survey area reaches pile {o}")
    # local (x east, z south) to E, N
    area = affine_transform(local, [1, 0, 0, -1, ox, oy])
    # snap to 3 m from the kit grid corner: whole cells of both the 0.1 m DSM and the 3 cm ortho
    snap = 3.0
    b = area.bounds
    e0 = G["x0"] + math.floor((b[0] - G["x0"]) / snap) * snap
    e1 = G["x0"] + math.ceil((b[2] - G["x0"]) / snap) * snap
    n1 = G["y1"] - math.floor((G["y1"] - b[3]) / snap) * snap
    n0 = G["y1"] - math.ceil((G["y1"] - b[1]) / snap) * snap
    out.mkdir(parents=True, exist_ok=True)
    res = G["dsm_res"]
    c0, r0 = round((e0 - G["x0"]) / res), round((G["y1"] - n1) / res)
    W, H = round((e1 - e0) / res), round((n1 - n0) / res)
    OW, OH = round((e1 - e0) / MASAFI_ORTHO_RES), round((n1 - n0) / MASAFI_ORTHO_RES)
    oc0, or0 = round((e0 - G["x0"]) / MASAFI_ORTHO_RES), round((G["y1"] - n1) / MASAFI_ORTHO_RES)
    files = {}
    for e in kit["epochs"]:
        eid, date = e["id"], e["date"]
        a = np.load(src / "work" / f"dsm_{eid}.npy", mmap_mode="r")
        blk = np.asarray(a[r0 : r0 + H, c0 : c0 + W], dtype=np.float32)
        outside = geometry_mask([mapping(area)], (H, W), from_origin(e0, n1, res, res))
        blk = np.where(outside, np.nan, blk)
        dsm = out / f"{date}_dsm.tif"
        with rasterio.open(
            dsm,
            "w",
            driver="GTiff",
            height=H,
            width=W,
            count=1,
            dtype="float32",
            crs=kit["crs"],
            transform=from_origin(e0, n1, res, res),
            nodata=-10000.0,
            tiled=True,
            compress="deflate",
            predictor=3,
        ) as d:
            d.write(np.where(np.isnan(blk), -10000.0, blk).astype(np.float32), 1)
        img = np.zeros((OH, OW, 4), np.uint8)
        tdir = src / "tiles" / eid / str(MASAFI_ORTHO_Z)
        T = G["tile"]
        for tx in range(oc0 // T, (oc0 + OW - 1) // T + 1):
            for ty in range(or0 // T, (or0 + OH - 1) // T + 1):
                f = tdir / f"{tx}_{ty}.webp"
                if not f.exists():
                    continue
                with Image.open(f) as im:
                    t = np.asarray(im.convert("RGBA"))
                # tile pixel (0, 0) is grid pixel (tx*T, ty*T)
                gx0, gy0 = tx * T, ty * T
                ax0, ay0 = max(gx0, oc0), max(gy0, or0)
                ax1 = min(gx0 + t.shape[1], oc0 + OW)
                ay1 = min(gy0 + t.shape[0], or0 + OH)
                if ax1 > ax0 and ay1 > ay0:
                    img[ay0 - or0 : ay1 - or0, ax0 - oc0 : ax1 - oc0] = t[
                        ay0 - gy0 : ay1 - gy0, ax0 - gx0 : ax1 - gx0
                    ]
        img[..., 3][
            geometry_mask([mapping(area)], (OH, OW), from_origin(e0, n1, MASAFI_ORTHO_RES, MASAFI_ORTHO_RES))
        ] = 0
        ortho = out / f"{date}_ortho.tif"
        with rasterio.open(
            ortho,
            "w",
            driver="GTiff",
            height=OH,
            width=OW,
            count=4,
            dtype="uint8",
            crs=kit["crs"],
            transform=from_origin(e0, n1, MASAFI_ORTHO_RES, MASAFI_ORTHO_RES),
            photometric="RGB",
            alpha="YES",
            tiled=True,
            compress="deflate",
        ) as d:
            for y in range(0, OH, 1024):
                d.write(np.moveaxis(img[y : y + 1024], -1, 0), window=Window(0, y, OW, min(1024, OH - y)))
        files[eid] = {"date": date, "label": e["label"], "dsm": dsm.name, "ortho": ortho.name}

    # the delivered piles of the sample with their delivered volumes
    piles = []
    for p in ref_v["piles"]:
        if p["id"] in MASAFI_PILES:
            piles.append(
                {
                    "id": p["id"],
                    "centreEN": p["centreEN"],
                    "epochs": {
                        k: {
                            "areaM2": round(v["areaM2"], 1),
                            "heightM": round(v["heightM"], 2),
                            "volumes": {b: round(x["net"], 1) for b, x in v["volumes"].items()},
                        }
                        for k, v in p["epochs"].items()
                    },
                    "changeNet": round(p["change"]["net"], 1),
                }
            )
    centre = ((e0 + e1) / 2, (n0 + n1) / 2)
    lon, lat = wgs84(32639, [centre[0]], [centre[1]])
    facts = {
        "name": "volumetric-masafi-mini",
        "crs": kit["crs"],
        "bounds": [e0, n0, e1, n1],
        "origin": [round(centre[0], 1), round(centre[1], 1), oh],
        "originLatLon": [round(lat[0], 7), round(lon[0], 7)],
        "surveys": [files[e["id"]] for e in kit["epochs"]],
        "dsmRes": res,
        "orthoRes": MASAFI_ORTHO_RES,
        "piles": piles,
        "density": kit["volume"]["density_t_m3"],
    }
    write_json(out / "sample.json", facts)
    return facts


# ================================================================================ road (Ring Road)

RING_NAS = Path("//DanNas/Work Data/MPW Roads/1st Ring Road")
RING_KM = (3.0, 3.25)
#: Margin around the stretch's centreline (the carriageways, ramps and verges), metres.
RING_MARGIN_M = 30.0
#: The delivered PCI grid (15 m cells from the heatmap's top-left corner).
RING_CELL_M = 15.0
RING_ORTHO_FACTOR = 2  # 1.25 cm blocks to 2.5 cm


def _interp(pts: list[tuple[float, float]], ch: list[float], km: float) -> tuple[float, float]:
    for i in range(len(ch) - 1):
        if ch[i] <= km <= ch[i + 1]:
            t = (km - ch[i]) / (ch[i + 1] - ch[i]) if ch[i + 1] > ch[i] else 0.0
            return (pts[i][0] + t * (pts[i + 1][0] - pts[i][0]), pts[i][1] + t * (pts[i + 1][1] - pts[i][1]))
    raise SystemExit(f"km {km} is not on the centreline")


def ringroad(data: Path, out: Path) -> dict:
    import rasterio
    import shapefile
    from rasterio.enums import Resampling
    from rasterio.transform import from_origin
    from rasterio.windows import Window, from_bounds
    from shapely.geometry import box, shape

    native_m = json.loads((data / "projects" / "ringroad" / "manifest.json").read_text("utf-8"))
    native = json.loads((data / "projects" / "ringroad" / "road.json").read_text("utf-8"))
    epsg = native_m["crs"]["epsg"]
    ox, oy = native_m["origin"][0], native_m["origin"][1]
    pts = [(ox + p[0], oy - p[2]) for p in native["centreline"]["points"]]
    ch = native["centreline"]["chainageKm"]
    k0, k1 = RING_KM
    line = [_interp(pts, ch, k0)]
    kms = [k0]
    for p, k in zip(pts, ch, strict=True):
        if k0 < k < k1:
            line.append(p)
            kms.append(k)
    line.append(_interp(pts, ch, k1))
    kms.append(k1)
    out.mkdir(parents=True, exist_ok=True)

    # the stretch: the centreline's bounds and margin, on the delivered 15 m PCI grid
    with rasterio.open(RING_NAS / "Heatmap" / "heatmap.tif") as h:
        gx, gy = h.bounds.left, h.bounds.top
        xs, ys = [p[0] for p in line], [p[1] for p in line]
        c = RING_CELL_M
        e0 = gx + math.floor((min(xs) - RING_MARGIN_M - gx) / c) * c
        e1 = gx + math.ceil((max(xs) + RING_MARGIN_M - gx) / c) * c
        n1 = gy - math.floor((gy - (max(ys) + RING_MARGIN_M)) / c) * c
        n0 = gy - math.ceil((gy - (min(ys) - RING_MARGIN_M)) / c) * c
        win = from_bounds(e0, n0, e1, n1, h.transform).round_offsets().round_lengths()
        heat = h.read(1, window=win)
        pav = out / "pavement.tif"
        with rasterio.open(
            pav,
            "w",
            driver="GTiff",
            width=heat.shape[1],
            height=heat.shape[0],
            count=1,
            dtype=heat.dtype,
            crs=h.crs,
            transform=h.window_transform(win),
            compress="deflate",
        ) as d:
            d.write(heat, 1)

    # ortho: the delivered blocks, later ones drawn over earlier ones, at 2.5 cm
    res = None
    canvas = None
    for name in ["1st Ring Road-Block 2.tif", "1st Ring Road-Block 1.tif"]:
        with rasterio.open(RING_NAS / "Orthomosaic" / name) as d:
            if res is None:
                res = round(d.res[0] * RING_ORTHO_FACTOR, 4)
                W, H = round((e1 - e0) / res), round((n1 - n0) / res)
                canvas = np.zeros((4, H, W), np.uint8)
            b = d.bounds
            if b.right <= e0 or b.left >= e1 or b.top <= n0 or b.bottom >= n1:
                continue
            w = from_bounds(e0, n0, e1, n1, d.transform)
            data_ = d.read(
                window=w, out_shape=(4, H, W), resampling=Resampling.average, boundless=True, fill_value=0
            )
            on = data_[3] > 0
            canvas[:, on] = data_[:, on]
    ortho = out / "ringroad-km3.00-3.25-ortho.tif"
    with rasterio.open(
        ortho,
        "w",
        driver="GTiff",
        width=W,
        height=H,
        count=4,
        dtype="uint8",
        crs=f"EPSG:{epsg}",
        transform=from_origin(e0, n1, res, res),
        photometric="RGB",
        alpha="YES",
        tiled=True,
        compress="deflate",
        predictor=2,
    ) as o:
        for y in range(0, H, 1024):
            o.write(canvas[:, y : y + 1024], window=Window(0, y, W, min(1024, H - y)))

    # centreline (WGS84 GeoJSON with the delivered chainage per vertex)
    lon, lat = wgs84(epsg, [p[0] for p in line], [p[1] for p in line])
    write_json(
        out / "centreline.geojson",
        {
            "type": "FeatureCollection",
            "features": [
                {
                    "type": "Feature",
                    "properties": {
                        "name": f"1st Ring Road km {k0:.2f} to {k1:.2f}",
                        "chainageKm": [round(k, 4) for k in kms],
                    },
                    "geometry": {
                        "type": "LineString",
                        "coordinates": [[round(a, 8), round(b_, 8)] for a, b_ in zip(lon, lat, strict=True)],
                    },
                }
            ],
        },
    )

    # defects: every delivered polygon that reaches into the stretch, WGS84, original fields
    area = box(e0, n0, e1, n1)
    sf = shapefile.Reader(str(RING_NAS / "Shapefiles" / "1st Ring Road Defects"))
    fields = [f[0] for f in sf.fields[1:]]
    feats = []
    for sr in sf.iterShapeRecords():
        g = shape(sr.shape.__geo_interface__)
        if g.is_empty or not area.intersects(g):
            continue
        props = {
            k: (v.isoformat() if hasattr(v, "isoformat") else v)
            for k, v in zip(fields, sr.record, strict=True)
        }

        def ll(ring):
            lo, la = wgs84(epsg, [p[0] for p in ring], [p[1] for p in ring])
            return [[round(a, 9), round(b_, 9)] for a, b_ in zip(lo, la, strict=True)]

        gj = sr.shape.__geo_interface__
        if gj["type"] == "Polygon":
            coords = [ll(r) for r in gj["coordinates"]]
        elif gj["type"] == "MultiPolygon":
            coords = [[ll(r) for r in poly] for poly in gj["coordinates"]]
        else:
            continue
        feats.append(
            {"type": "Feature", "properties": props, "geometry": {"type": gj["type"], "coordinates": coords}}
        )
    write_json(out / "defects.geojson", {"type": "FeatureCollection", "features": feats})

    # the delivered PCI of the grid cells in the stretch (absolute cell corners), for the check
    gorigin = native["pci"]["grid"]["origin"]
    ge, gn = ox + gorigin[0], oy - gorigin[2]
    cell = native["pci"]["grid"]["cellM"]
    units = []
    for u in native["pci"]["units"]:
        corners = [(ge + col * cell, gn - row * cell) for row, col in u["cells"]]
        if all(
            e0 - 1e-6 <= x and x + cell <= e1 + 1e-6 and n0 - 1e-6 <= y - cell and y <= n1 + 1e-6
            for x, y in corners
        ):
            units.append(
                {
                    "cells": sorted([round(x, 3), round(y, 3)] for x, y in corners),
                    "pci": u["pci"],
                    "km": u["km"],
                }
            )
    centre = ((e0 + e1) / 2, (n0 + n1) / 2)
    clon, clat = wgs84(epsg, [centre[0]], [centre[1]])
    facts = {
        "name": "road-ringroad-mini",
        "epsg": epsg,
        "bounds": [e0, n0, e1, n1],
        "origin": [round(centre[0], 1), round(centre[1], 1), 0],
        "originLatLon": [round(clat[0], 7), round(clon[0], 7)],
        "km": [k0, k1],
        "lengthM": round(sum(math.dist(line[i], line[i + 1]) for i in range(len(line) - 1)), 1),
        "orthoCm": round(res * 100, 3),
        "ortho": ortho.name,
        "defects": len(feats),
        "deliveredUnits": units,
        "deliveredNetwork": native["pci"]["network"],
    }
    write_json(out / "sample.json", facts)
    return facts


# ================================================================================== entry point


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("out")
    ap.add_argument("sets", nargs="*", default=["hcl", "masafi", "road"])
    ap.add_argument("--data", default="E:/Stratlas Data")
    a = ap.parse_args()
    out, data = Path(a.out), Path(a.data)
    for s in a.sets:
        if s == "masafi":
            f = masafi(data, out / "volumetric-masafi-mini")
        elif s == "hcl":
            f = hcl(data, out / "inspection-hcl-mini")
        elif s == "road":
            f = ringroad(data, out / "road-ringroad-mini")
        else:
            raise SystemExit(f"unknown set {s}")
        print(json.dumps({k: v for k, v in f.items() if k != "detections"}, indent=1)[:3000])
    return 0


if __name__ == "__main__":
    sys.exit(main())
