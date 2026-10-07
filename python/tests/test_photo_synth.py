"""The synthetic photogrammetry set (photo_synth.py, M10 G8): deterministic, its truth reprojects
onto the rendered targets, and its EXIF and XMP read back as a drone's do."""

from __future__ import annotations

import csv
import hashlib
import io
import json
import math
import re

import numpy as np
import pytest
import rasterio
from PIL import Image
from rasterio.warp import transform as proj_transform

import photo_synth as ps
from aio_pipelines.aik.cameras import read_meta


def _sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


# ------------------------------------------------------------------------------------- geodesy


def test_utm_series_agrees_with_proj_to_a_tenth_of_a_millimetre():
    es = [ps.SITE.origin[0] + d for d in (-150.0, 0.0, 137.5)]
    ns = [ps.SITE.origin[1] + d for d in (-120.0, 0.0, 95.25)]
    pts = [(e, n) for e in es for n in ns]
    lon, lat = proj_transform(f"EPSG:{ps.SITE.epsg}", "EPSG:4326", [p[0] for p in pts], [p[1] for p in pts])
    for (e, n), lo, la in zip(pts, lon, lat, strict=True):
        mlo, mla = ps.utm_to_lonlat(ps.SITE.epsg, e, n)
        # 1e-9 degree is about 0.1 mm
        assert abs(mlo - lo) < 1e-9 and abs(mla - la) < 1e-9
        e2, n2 = ps.lonlat_to_utm(ps.SITE.epsg, mlo, mla)
        assert abs(e2 - e) < 1e-4 and abs(n2 - n) < 1e-4


def test_the_site_is_far_from_every_real_site():
    lon, lat = ps.utm_to_lonlat(ps.SITE.epsg, *ps.SITE.origin[:2])
    # Rub' al Khali: open desert, hundreds of kilometres from any surveyed site
    assert 51.0 < lon < 52.0 and 20.5 < lat < 21.5


# --------------------------------------------------------------------------------------- camera


def test_projection_matches_the_renderer_rays_and_refuses_fold_over():
    cam = ps.camera_for("quick")
    shot = ps.Shot("x", "nadir", np.array([0.0, 0.0, 60.0]), 30.0, -90.0, 0.0, "2026-03-14T08:30:00")
    # a ray through pixel (u, v), as render() makes it, projects back onto (u, v)
    for u, v in ((0.5, 0.5), (800.0, 600.0), (1599.5, 1199.5), (123.25, 987.75)):
        x, y = cam.undistort((u - cam.cx) / cam.fx, (v - cam.cy) / cam.fy)
        d = np.array([x, y, 1.0]) @ shot.rotation
        p = shot.centre + 40.0 * d
        uv, z = ps.project(cam, shot, p)
        assert np.allclose(uv[0], [u, v], atol=1e-6) and z[0] > 0
    # far outside the frame the polynomial folds back into it: not a pixel
    uv, _ = ps.project(cam, shot, [[-126.0, -115.0, 0.0]])
    assert np.isnan(uv).all()


def test_gimbal_angles_give_a_dji_camera():
    # nadir, yaw 0: the top of the photo points north, its right edge east
    r = ps.gimbal_rotation(0.0, -90.0, 0.0)
    assert np.allclose(r[0], [1, 0, 0]) and np.allclose(r[1], [0, -1, 0], atol=1e-12)
    assert np.allclose(r[2], [0, 0, -1], atol=1e-12)
    # yaw 90: looking east, the right edge points south
    r = ps.gimbal_rotation(90.0, 0.0, 0.0)
    assert np.allclose(r[2], [1, 0, 0], atol=1e-12) and np.allclose(r[0], [0, -1, 0], atol=1e-12)
    assert np.allclose(r @ r.T, np.eye(3))


# ---------------------------------------------------------------------------------- determinism


def test_render_and_truth_are_deterministic(tmp_path):
    scene = ps.Scene()
    shot = next(s for s in ps.plan_shots(scene) if s.name == "SYN_0024.JPG")
    cam = ps.camera_for("quick").scaled(240)
    a = ps.jpeg_bytes(ps.finish(ps.render(scene, cam, shot), cam, 5, 1.0))
    b = ps.jpeg_bytes(ps.finish(ps.render(ps.Scene(), cam, shot), cam, 5, 1.0))
    assert a == b
    # the truth does not depend on rendering, workers or platform: rounded, built twice, the same
    for size in ("quick", "mini"):
        texts = []
        for _ in range(2):
            sc = ps.Scene()
            shots = ps.plan_shots(sc) if size == "quick" else ps.mini_shots(sc, ps.DEFAULT_SEED)
            zt = float(sc.ground(np.array([ps.FLIGHT.takeoff[0]]), np.array([ps.FLIGHT.takeoff[1]]))[0])
            tags = ps.geotags(shots, ps.VARIANTS["rtk"], ps.DEFAULT_SEED, zt)
            truth = ps.build_truth(
                sc, ps.camera_for(size), shots, ps.DEFAULT_SEED, size, ps.VARIANTS["rtk"], tags
            )
            texts.append(json.dumps(truth, sort_keys=True))
        assert texts[0] == texts[1]


def test_truth_keeps_its_documented_numbers():
    """Golden values: a change here changes every downstream accuracy assertion."""
    sc = ps.Scene()
    shots = ps.plan_shots(sc)
    assert len(shots) == 63
    assert [s.name for s in shots if s.kind not in ("nadir", "oblique")] == [
        "SYN_0059.JPG",
        "SYN_0060.JPG",
        "SYN_0061.JPG",
        "SYN_0062.JPG",
        "SYN_0063.JPG",
    ]
    assert sum(s.kind == "nadir" for s in shots) == 50 and sum(s.kind == "oblique" for s in shots) == 8
    assert ps.stockpile_volume() == pytest.approx(1894.585, abs=1e-3)
    tp = ps.target_points(sc)
    assert ps.local_to_world(tp["CHK1"]) == pytest.approx([549965.0, 2329997.0, 142.0227], abs=1e-3)
    assert ps.camera_for("quick").gsd_cm(60.0) == pytest.approx(5.6132, abs=1e-4)


def test_stockpile_volume_matches_the_terrain():
    sc = ps.Scene()
    cx, cy = ps.STOCKPILE["centre"]
    r = ps.STOCKPILE["radius"] + 1
    step = 0.05
    xs = np.arange(cx - r, cx + r, step) + step / 2
    X, Y = np.meshgrid(xs, np.arange(cy - r, cy + r, step) + step / 2)
    pile = sc.ground(X, Y) - (
        ps.PLANE[0] * X
        + ps.PLANE[1] * Y
        + sum(
            a * np.maximum(1 - ((X - bx) ** 2 + (Y - by) ** 2) / rad**2, 0) ** 3
            for bx, by, a, rad in ps.BUMPS
        )
    )
    assert pile.sum() * step * step == pytest.approx(ps.stockpile_volume(), rel=2e-3)


# ---------------------------------------------------------------------------------- the mini set


@pytest.fixture(scope="module")
def mini(photo_mini):
    return photo_mini


def _corner(gray: np.ndarray, u: float, v: float, r: int = 3, it: int = 5) -> np.ndarray:
    """Sub-pixel centre of a checker target (the cornerSubPix principle: every gradient in the
    window is perpendicular to the line from the corner). The window stays inside the checker
    (half a metre, about 5 px at 960 x 720): the edges to the white margin would bias it."""
    gy, gx = np.gradient(gray)
    p = np.array([u, v])
    for _ in range(it):
        c0, r0 = round(p[0] - 0.5), round(p[1] - 0.5)
        ys, xs = np.mgrid[r0 - r : r0 + r + 1, c0 - r : c0 + r + 1]
        g = np.stack([gx[ys, xs].ravel(), gy[ys, xs].ravel()], 1)
        q = np.stack([xs.ravel() + 0.5, ys.ravel() + 0.5], 1)
        p = np.linalg.solve(g.T @ g, np.einsum("ni,nj,nj->i", g, g, q))
    return p


def test_truth_cameras_reproject_targets_onto_the_rendered_centres(mini):
    errs = []
    for t in mini.truth["targets"]:
        for o in t["observations"]:
            u, v = o["px"]
            if not (
                12 < u < mini.truth["camera"]["width"] - 12 and 12 < v < mini.truth["camera"]["height"] - 12
            ):
                continue
            img = Image.open(mini.photo(o["photo"])).convert("L")
            p = _corner(np.asarray(img, dtype=np.float64), u, v)
            errs.append(math.hypot(p[0] - u, p[1] - v))
    assert len(errs) >= 15
    assert max(errs) < 0.25, sorted(errs)[-5:]
    print(f"target reprojection: n={len(errs)} median={np.median(errs):.3f} max={max(errs):.3f} px")


def test_exif_and_xmp_read_back_through_the_drone_reader(mini):
    for p in mini.truth["photos"]:
        if p["kind"] in ("corrupt", "duplicate"):
            continue
        meta = read_meta(mini.photo(p["name"]))
        assert (meta["width"], meta["height"]) == (960, 720)
        tag = p["geotag"]
        if p["kind"] == "no-gps":
            assert "latitude" not in meta and "AbsoluteAltitude" not in meta
        else:
            assert meta["latitude"] == pytest.approx(tag["lat"], abs=2e-9)
            assert meta["longitude"] == pytest.approx(tag["lon"], abs=2e-9)
            assert meta["altitude"] == pytest.approx(tag["absoluteAltitude"], abs=1e-3)
            assert meta["AbsoluteAltitude"] == pytest.approx(tag["absoluteAltitude"], abs=1e-3)
        assert meta["RelativeAltitude"] == pytest.approx(tag["relativeAltitude"], abs=1e-3)
        assert meta["GimbalYawDegree"] == pytest.approx(tag["gimbal"]["yaw"], abs=0.006)
        assert meta["GimbalPitchDegree"] == pytest.approx(tag["gimbal"]["pitch"], abs=0.006)
        assert meta["focal"] == pytest.approx(8.8)
        assert meta["focal35"] == 23  # 35 mm equivalent of 8.8 mm on 13.2 x 9.9 mm
        assert meta["time"] == p["takenAt"].replace("-", ":").replace("T", " ")


def test_photos_name_a_synthetic_camera_and_no_serial(mini):
    with Image.open(mini.photo("SYN_0024.JPG")) as im:
        ex = im.getexif()
        sub = ex.get_ifd(0x8769)
    assert ex[271] == "Stratlas Synthetic" and ex[272] == "SYN-20"
    assert 42033 not in sub and 0xA431 not in sub  # BodySerialNumber
    raw = mini.photo("SYN_0024.JPG").read_bytes()[:20000]
    assert b"SerialNumber" not in raw and b"DJI" not in raw


def test_the_bad_images_are_bad_in_the_documented_way(mini):
    names = {p["kind"]: p["name"] for p in mini.truth["photos"]}
    # duplicate: the same bytes as its source
    assert mini.photo(names["duplicate"]).read_bytes() == mini.photo("SYN_0023.JPG").read_bytes()
    # corrupt: the decoder fails
    with pytest.raises(OSError):
        Image.open(io.BytesIO(mini.photo(names["corrupt"]).read_bytes())).load()
    # blurred: far less detail than a sharp photo of the same flight

    def sharpness(name):
        g = np.asarray(Image.open(mini.photo(name)).convert("L"), dtype=np.float64)
        lap = g[1:-1, 1:-1] * 4 - g[:-2, 1:-1] - g[2:, 1:-1] - g[1:-1, :-2] - g[1:-1, 2:]
        return lap.var()

    assert sharpness(names["blurred"]) < 0.3 * sharpness("SYN_0024.JPG")
    # no GPS: no GPS IFD
    with Image.open(mini.photo(names["no-gps"])) as im:
        assert not im.getexif().get_ifd(0x8825)
    reg = mini.truth["registration"]
    assert {r["name"] for r in reg["rejected"]} == {
        names[k] for k in ("blurred", "duplicate", "outlier", "corrupt")
    }
    assert [r["name"] for r in reg["either"]] == [names["no-gps"]]


def test_rtk_variant_writes_rtk_fields_and_the_same_pixels(mini, photo_set_factory):
    rtk = photo_set_factory("mini", "rtk")
    for name in ("SYN_0024.JPG", "SYN_0034.JPG"):
        a = mini.photo(name).read_bytes()
        b = rtk.photo(name).read_bytes()
        # metadata differs, the compressed pixels after the APP segments do not
        assert a[a.index(b"\xff\xdb") :] == b[b.index(b"\xff\xdb") :]
        xmp = b[: b.index(b"\xff\xdb")].decode("latin1")
        assert re.search(r'drone-dji:RtkFlag="50"', xmp)
        assert float(re.search(r'RtkStdLon="([\d.]+)"', xmp).group(1)) < 0.05
        tag = rtk.shot(name)["geotag"]
        e, n = ps.lonlat_to_utm(ps.SITE.epsg, tag["lon"], tag["lat"])
        c = rtk.shot(name)["centre"]
        assert math.hypot(e - c[0], n - c[1]) < 0.1
        assert abs(tag["absoluteAltitude"] - c[2]) < 0.15
    std = mini.shot("SYN_0024.JPG")
    # standard GNSS: metres off, and the altitude carries the datum offset
    assert abs(std["geotag"]["absoluteAltitude"] - std["centre"][2] - ps.VARIANTS["standard"].alt_offset) < 15


def test_side_files(mini):
    root = mini.root
    rows = list(csv.DictReader((root / "gcp.csv").open(encoding="utf8")))
    assert [r["role"] for r in rows].count("control") == 5 and [r["role"] for r in rows].count("check") == 4
    blunder = {r["id"]: r for r in csv.DictReader((root / "gcp-blunder.csv").open(encoding="utf8"))}
    true6 = mini.target("GCP6")["xyz"]
    off = math.dist([float(blunder["GCP6"][k]) for k in "xyz"], true6)
    assert off == pytest.approx(1.0, abs=1e-3) and blunder["GCP6"]["role"] == "control"
    lines = (root / "gcp_list.txt").read_text(encoding="utf8").splitlines()
    assert lines[0] == "EPSG:32639" and len(lines) > 10
    x, y, z, u, v, photo, gid = lines[1].split()
    assert photo.startswith("SYN_") and gid in {r["id"] for r in rows}
    ppk = list(csv.DictReader((root / "ppk.csv").open(encoding="utf8")))
    assert ppk and {"image", "lat", "lon", "h", "sigma_h", "sigma_v"} <= set(ppk[0])
    hashes = (root / "images.sha256").read_text(encoding="utf8").splitlines()
    assert len(hashes) == len(mini.truth["photos"])
    h, rel = hashes[0].split("  ")
    assert _sha((root / rel).read_bytes()) == h


def test_true_surfaces_and_mesh(mini):
    import trimesh

    with (
        rasterio.open(mini.root / "truth" / "dsm.tif") as d,
        rasterio.open(mini.root / "truth" / "dtm.tif") as t,
    ):
        assert d.crs.to_epsg() == 32639 and d.res == (ps.GRID_RES, ps.GRID_RES)
        dsm, dtm = d.read(1), t.read(1)
        # the tank roof: 10 m over the ground at its centre
        r, c = d.index(ps.SITE.origin[0], ps.SITE.origin[1])
        assert dsm[r, c] - dtm[r, c] == pytest.approx(10.0, abs=0.3)
    assert (dsm >= dtm - 1e-4).all()
    mesh = trimesh.load(mini.root / "truth" / "mesh.glb", force="mesh")
    lo, hi = mesh.bounds
    assert lo[0] == pytest.approx(-100) and hi[0] == pytest.approx(100)
    assert hi[1] > 9.5  # Y up: the tank top


def test_tiles_are_placed_per_vertex_through_ecef(mini):
    """A point of the truth, through the tileset's root transform, lands where PROJ puts it in ECEF
    (within a millimetre; a UTM-as-metres shortcut would be centimetres off at 100 m)."""
    ts = json.loads((mini.root / "tiles" / "truth-mesh" / "tileset.json").read_text(encoding="utf8"))
    m = np.array(ts["root"]["transform"]).reshape(4, 4).T
    local = np.array([[90.0, -80.0, 3.0], [-75.0, 60.0, 0.5], [0.0, 0.0, 0.0]])
    enu = ps.local_to_enu(local)
    got = (m @ np.c_[enu, np.ones(len(enu))].T).T[:, :3]
    w = np.array([ps.local_to_world(p) for p in local])
    x, y, z = proj_transform(f"EPSG:{ps.SITE.epsg}", "EPSG:4978", w[:, 0], w[:, 1], w[:, 2])
    assert np.abs(got - np.c_[x, y, z]).max() < 1e-3
    # the shortcut is visibly worse: grid offsets taken as east-north-up metres
    assert np.abs(enu[0] - local[0]).max() > 0.03
    cloud = json.loads((mini.root / "tiles" / "truth-cloud" / "tileset.json").read_text(encoding="utf8"))
    assert cloud["root"]["content"]["uri"] == "cloud.glb" and ts["asset"]["version"] == "1.1"


def _colmap(folder):
    cams = [ln.split() for ln in (folder / "cameras.txt").read_text().splitlines() if not ln.startswith("#")]
    lines = [ln for ln in (folder / "images.txt").read_text().splitlines() if not ln.startswith("#")]
    images = {}
    for head, obs in zip(lines[0::2], lines[1::2], strict=True):
        h = head.split()
        o = np.array(obs.split(), dtype=float).reshape(-1, 3) if obs.strip() else np.zeros((0, 3))
        images[int(h[0])] = {
            "q": np.array(h[1:5], float),
            "t": np.array(h[5:8], float),
            "name": h[9],
            "obs": o,
        }
    points = {}
    for ln in (folder / "points3D.txt").read_text().splitlines():
        if ln.startswith("#"):
            continue
        v = ln.split()
        points[int(v[0])] = {"xyz": np.array(v[1:4], float), "track": np.array(v[8:], int).reshape(-1, 2)}
    return cams, images, points


def _rot(q):
    w, x, y, z = q
    return np.array(
        [
            [1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y)],
            [2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x)],
            [2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)],
        ]
    )


def test_precomputed_alignment_and_its_sparse_model(mini):
    al = json.loads((mini.root / "alignment" / "alignment.json").read_text(encoding="utf8"))
    names = {p["name"]: p for p in mini.truth["photos"]}
    assert all(names[n]["kind"] in ("nadir", "oblique", "no-gps") for n in al["registered"])
    assert {r["name"] for r in al["rejected"]} == {
        p["name"] for p in mini.truth["photos"] if p["kind"] in ("blurred", "duplicate", "outlier")
    }
    # predictions sit near, not on, the targets: within their radius of the true marks
    near = 0
    for tid, preds in al["predictions"].items():
        true = {o["photo"]: o["px"] for o in mini.target(tid)["observations"]}
        for p in preds:
            d = math.dist(p["px"], true[p["photo"]])
            assert 2 < d < p["radiusPx"]
            near += 1
    assert near >= 15
    assert np.allclose(al["residuals"]["CHK1"], [1.1, -0.7, 0.9], atol=0.05)
    # the COLMAP model reprojects its own observations (0.3 px noise)
    cams, images, points = _colmap(mini.root / "alignment" / "sparse")
    cam = cams[0]
    assert cam[1] == "FULL_OPENCV" and len(cam) == 16
    fx, fy, cx, cy, k1, k2, p1, p2, k3 = map(float, cam[4:13])
    c = ps.Camera(int(cam[2]), int(cam[3]), fx, fy, cx, cy, k1, k2, p1, p2, k3, 8.8, 13.2, 9.9)
    assert len(images) == len(al["registered"]) and len(points) >= 1000
    errs = []
    for pid, p in list(points.items())[:300]:
        assert len(p["track"]) >= 3
        for img_id, k in p["track"]:
            im = images[img_id]
            u, v, ref = im["obs"][k]
            assert int(ref) == pid
            xc = _rot(im["q"]) @ p["xyz"] + im["t"]
            xd, yd = c.distort(xc[0] / xc[2], xc[1] / xc[2])
            errs.append(math.hypot(fx * xd + cx - u, fy * yd + cy - v))
    assert np.mean(errs) < 0.6 and max(errs) < 2.0


def test_true_ortho_shows_the_targets(mini):
    with rasterio.open(mini.root / "truth" / "ortho.tif") as d:
        assert d.count == 3 and d.crs.to_epsg() == 32639
        rgb = d.read()
        t = mini.target("CHK1")["xyz"]
        r, c = d.index(t[0] + 0.25, t[1] + 0.25)  # the north-east quadrant: white
        r2, c2 = d.index(t[0] - 0.25, t[1] + 0.25)  # the north-west quadrant: black
    assert rgb[:, r, c].mean() > 180 and rgb[:, r2, c2].mean() < 40
