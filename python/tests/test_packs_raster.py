"""packs.imagery and packs.terrain (M10 G7): synthetic GeoTIFFs and DEMs to raster PMTiles packs.

Everything is generated here at the fictional desert site (UTM zone 39N); no real dataset is read.
"""

from __future__ import annotations

import io
import json
import math
import threading

import numpy as np
import pytest
import rasterio
from PIL import Image
from rasterio.crs import CRS
from rasterio.transform import from_origin

from aio_pipelines.packs.imagery import ImageryPack, downsample_rgba
from aio_pipelines.packs.pmtiles_writer import (
    Entry,
    PMTilesReader,
    PMTilesWriter,
    decode_directory,
    encode_directory,
    tileid_to_zxy,
    zxy_to_tileid,
)
from aio_pipelines.packs.raster import lonlat_to_tile, native_zoom, scan_sources
from aio_pipelines.packs.terrain import TerrainPack, terrarium_decode, terrarium_encode
from aio_pipelines.runtime import Cancelled, JobError
from conftest import run_job

UTM = CRS.from_epsg(32639)
E0, N1 = 500_000.0, 3_200_400.0  # top-left corner of the synthetic rasters
RES = 2.0
SIZE = 200  # 400 m x 400 m


def quadrant_colour(row: int, col: int) -> tuple[int, int, int]:
    """Red in the north-west quarter, green north-east, blue south-west, yellow south-east."""
    north, west = row < SIZE // 2, col < SIZE // 2
    return {(True, True): (220, 30, 30), (True, False): (30, 200, 40), (False, True): (30, 40, 210)}.get(
        (north, west), (230, 220, 30)
    )


def write_imagery(path, dtype="uint8"):
    rgb = np.zeros((3, SIZE, SIZE), dtype=np.float64)
    for r in range(SIZE):
        for c in range(SIZE):
            rgb[:, r, c] = quadrant_colour(r, c)
    if dtype == "uint16":
        rgb = rgb * 40 + 1000
    with rasterio.open(
        path,
        "w",
        driver="GTiff",
        width=SIZE,
        height=SIZE,
        count=3,
        dtype=dtype,
        crs=UTM,
        transform=from_origin(E0, N1, RES, RES),
    ) as ds:
        ds.write(rgb.astype(dtype))
    return path


def plane(e, n):
    """A sloping plane (heights in metres): exact under bilinear resampling."""
    return 150.0 + 0.004 * (e - E0) - 0.003 * (N1 - n)


BENCHMARK = (E0 + 300.0, N1 - 100.0, 123.45)  # a flat pad at a known height


def write_dem(path, with_pad=False, nodata_corner=False):
    cols = E0 + RES * (np.arange(SIZE) + 0.5)
    rows = N1 - RES * (np.arange(SIZE) + 0.5)
    ee, nn = np.meshgrid(cols, rows)
    h = plane(ee, nn).astype(np.float32)
    if with_pad:
        be, bn, bh = BENCHMARK
        pad = (np.abs(ee - be) < 30) & (np.abs(nn - bn) < 30)
        h[pad] = bh
    if nodata_corner:
        h[:20, :20] = -9999
    with rasterio.open(
        path,
        "w",
        driver="GTiff",
        width=SIZE,
        height=SIZE,
        count=1,
        dtype="float32",
        crs=UTM,
        nodata=-9999,
        transform=from_origin(E0, N1, RES, RES),
    ) as ds:
        ds.write(h, 1)
    return path


def to_lonlat(e, n):
    from rasterio.warp import transform

    lon, lat = transform(UTM, "EPSG:4326", [e], [n])
    return lon[0], lat[0]


def pixel_of(lon, lat, z, size=256):
    """The tile and the pixel inside it for a lon and lat."""
    n = 2**z
    fx = (lon + 180) / 360 * n
    fy = (1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * n
    x, y = int(fx), int(fy)
    return x, y, int((fx - x) * size), int((fy - y) * size)


def pixel_lonlat(z, x, y, px, py, size=256):
    n = 2**z
    lon = (x + (px + 0.5) / size) / n * 360 - 180
    lat = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * (y + (py + 0.5) / size) / n))))
    return lon, lat


def imagery_params(tmp_path, src, **over):
    return {
        "src": [str(src)],
        "dest": str(tmp_path / "data" / "packs" / "imagery"),
        "id": "site-imagery",
        "label": "Synthetic site imagery",
        "licence": "CC0-1.0",
        "attribution": "CC0 test fixture",
        "provenance": "Synthetic GeoTIFF (tests)",
        "customerLicence": True,
        **over,
    }


def terrain_params(tmp_path, src, **over):
    return {
        "src": [str(src)],
        "dest": str(tmp_path / "data" / "packs" / "terrain"),
        "id": "site-dem",
        "label": "Synthetic site terrain",
        "licence": "CC0-1.0",
        "attribution": "CC0 test fixture",
        "verticalDatum": "egm2008",
        **over,
    }


# ---------------------------------------------------------------- PMTiles


def test_tile_ids_follow_the_pmtiles_hilbert_order():
    assert zxy_to_tileid(0, 0, 0) == 0
    assert [zxy_to_tileid(1, x, y) for x, y in [(0, 0), (0, 1), (1, 1), (1, 0)]] == [1, 2, 3, 4]
    assert zxy_to_tileid(2, 0, 0) == 5
    for z in range(0, 6):
        for x in range(0, 2**z, max(1, 2**z // 7)):
            for y in range(0, 2**z, max(1, 2**z // 5)):
                assert tileid_to_zxy(zxy_to_tileid(z, x, y)) == (z, x, y)


def test_directories_round_trip():
    entries = [Entry(1, 0, 10, 1), Entry(2, 10, 5, 3), Entry(9, 0, 10, 1), Entry(40, 15, 7, 0)]
    assert decode_directory(encode_directory(entries)) == entries


def test_the_writer_dedupes_tiles_and_spills_to_leaf_directories(tmp_path):
    path = tmp_path / "t.pmtiles"
    w = PMTilesWriter(path, "png")
    same = b"same-tile"
    n = 0
    for x in range(256):
        for y in range(160):
            w.add(8, x, y, same if (x + y) % 3 else f"{x}-{y}".encode())
            n += 1
    w.add(0, 0, 0, b"root")
    counts = w.finish(bounds=(-180, -85, 180, 85), metadata={"name": "t"})
    assert counts["tiles"] == n + 1
    with PMTilesReader(path) as r:
        assert r.header.leaf_length > 0, "40 000 distinct entries need leaf directories"
        assert r.header.root_offset + r.header.root_length <= 16_384
        assert r.header.tile_contents < 20_000
        assert r.get(0, 0, 0) == b"root"
        assert r.get(8, 3, 3) == b"3-3"
        assert r.get(8, 4, 4) == same
        assert r.get(8, 0, 200) is None
        assert r.metadata() == {"name": "t"}
        assert len(r.tiles()) == n + 1
    assert not (tmp_path / "t.pmtiles.spool").exists()


# ---------------------------------------------------------------- imagery


def test_a_utm_geotiff_becomes_an_imagery_pack_with_the_right_colours(tmp_path):
    src = write_imagery(tmp_path / "ortho.tif")
    params = imagery_params(tmp_path, src)
    result, rec = run_job(ImageryPack(), tmp_path, params)
    dest = tmp_path / "data" / "packs" / "imagery"
    meta = json.loads((dest / "site-imagery.json").read_text("utf-8"))
    assert meta["schema"] == "aio.raster-pack/1"
    assert meta["kind"] == "imagery"
    assert meta["licence"] == "CC0-1.0"
    assert meta["attribution"] == "CC0 test fixture"
    assert meta["provenance"] == "Synthetic GeoTIFF (tests)"
    assert meta["customerLicence"] is True
    assert meta["format"] == "webp" and meta["tileSize"] == 256
    assert "encoding" not in meta and "verticalDatum" not in meta
    # 2 m pixels at 29 N: zoom 16 (2.1 m) is the nearest zoom
    assert meta["maxZoom"] == 16
    assert meta["minZoom"] <= meta["maxZoom"]
    w, s, e, n = meta["bbox"]
    lon, lat = to_lonlat(E0 + 200, N1 - 200)
    assert w < lon < e and s < lat < n
    assert not list(dest.glob(".*")), "no building leftovers"

    with PMTilesReader(dest / "site-imagery.pmtiles") as r:
        assert r.header.tile_type == 4  # webp
        assert r.metadata()["attribution"] == "CC0 test fixture"
        z = meta["maxZoom"]
        for (de, dn), colour in [
            ((100, -100), (220, 30, 30)),
            ((300, -100), (30, 200, 40)),
            ((100, -300), (30, 40, 210)),
            ((300, -300), (230, 220, 30)),
        ]:
            lon, lat = to_lonlat(E0 + de, N1 + dn)
            x, y, px, py = pixel_of(lon, lat, z)
            img = Image.open(io.BytesIO(r.get(z, x, y))).convert("RGBA")
            got = img.getpixel((px, py))
            assert all(abs(a - b) <= 12 for a, b in zip(got[:3], colour, strict=True)), (got, colour)
            assert got[3] == 255
        # outside the source: transparent, or no tile at all
        lon, lat = to_lonlat(E0 - 300, N1 + 300)
        x, y, px, py = pixel_of(lon, lat, z)
        data = r.get(z, x, y)
        if data is not None:
            assert Image.open(io.BytesIO(data)).convert("RGBA").getpixel((px, py))[3] == 0
        # the overview above holds the same colour
        lon, lat = to_lonlat(E0 + 100, N1 - 100)
        x, y, px, py = pixel_of(lon, lat, z - 2)
        got = Image.open(io.BytesIO(r.get(z - 2, x, y))).convert("RGBA").getpixel((px, py))
        assert abs(got[0] - 220) <= 20 and got[2] < 60
    assert result["outputs"]["commit"]["pack"]["id"] == "site-imagery"
    assert rec.of("progress")


def test_sixteen_bit_imagery_is_stretched_and_a_folder_is_read(tmp_path):
    folder = tmp_path / "in"
    folder.mkdir()
    write_imagery(folder / "a.tif", dtype="uint16")
    params = imagery_params(tmp_path, folder, maxZoom=15, format="png", customerLicence=False)
    run_job(ImageryPack(), tmp_path, params)
    dest = tmp_path / "data" / "packs" / "imagery"
    meta = json.loads((dest / "site-imagery.json").read_text("utf-8"))
    assert meta["maxZoom"] == 15 and meta["format"] == "png" and meta["customerLicence"] is False
    with PMTilesReader(dest / "site-imagery.pmtiles") as r:
        lon, lat = to_lonlat(E0 + 100, N1 - 300)  # blue quarter
        x, y, px, py = pixel_of(lon, lat, 15)
        got = Image.open(io.BytesIO(r.get(15, x, y))).convert("RGBA").getpixel((px, py))
        assert got[2] > 200 and got[0] < 40


def test_alpha_weighted_overviews_keep_edges_bright():
    big = np.zeros((4, 4, 4), np.float32)
    big[:3, :, :2] = 200
    big[3, :, :2] = 255
    half = downsample_rgba(big)
    assert half[0, 0, 0] == pytest.approx(200)
    assert half[3, 0, 0] == pytest.approx(255)
    assert half[3, 0, 1] == 0


def test_imagery_params_are_checked(tmp_path):
    p = ImageryPack()
    base = imagery_params(tmp_path, tmp_path / "x.tif")
    with pytest.raises(JobError, match="does not take: bogus"):
        p.validate({**base, "bogus": 1})
    with pytest.raises(JobError, match="customerLicence"):
        p.validate({k: v for k, v in base.items() if k != "customerLicence"})
    with pytest.raises(JobError, match="format must be one of"):
        p.validate({**base, "format": "gif"})
    with pytest.raises(JobError, match="absolute"):
        p.validate({**base, "dest": "packs/imagery"})
    with pytest.raises(JobError, match="lower-case"):
        p.validate({**base, "id": "Site Imagery"})
    with pytest.raises(JobError, match="minZoom"):
        p.validate({**base, "minZoom": 12, "maxZoom": 10})


@pytest.mark.filterwarnings("ignore::rasterio.errors.NotGeoreferencedWarning")
def test_a_raster_without_a_crs_is_refused(tmp_path):
    path = tmp_path / "plain.tif"
    with rasterio.open(path, "w", driver="GTiff", width=4, height=4, count=1, dtype="uint8") as ds:
        ds.write(np.zeros((1, 4, 4), np.uint8))
    with pytest.raises(JobError, match="no coordinate system"):
        scan_sources([path])
    with pytest.raises(JobError, match="does not exist"):
        run_job(ImageryPack(), tmp_path, imagery_params(tmp_path, tmp_path / "missing.tif"))


def test_cancel_leaves_no_pack(tmp_path):
    src = write_imagery(tmp_path / "ortho.tif")
    cancel = threading.Event()
    cancel.set()
    with pytest.raises(Cancelled):
        run_job(ImageryPack(), tmp_path, imagery_params(tmp_path, src), cancel=cancel)
    dest = tmp_path / "data" / "packs" / "imagery"
    assert not (dest / "site-imagery.json").exists()
    assert not (dest / "site-imagery.pmtiles").exists()


def test_native_zoom_follows_the_pixel_size(tmp_path):
    src = write_imagery(tmp_path / "ortho.tif")
    (s,) = scan_sources([src])
    assert s.pixel_m == pytest.approx(2.0, rel=0.01)
    assert native_zoom([s], 256) == 16
    assert native_zoom([s], 512) == 15


# ---------------------------------------------------------------- terrain


def test_terrarium_round_trips_to_a_256th_of_a_metre():
    h = np.array([[-10.3, 0.0, 123.45], [8848.86, -432.1, 1.0 / 512]], np.float32)
    back = terrarium_decode(terrarium_encode(h))
    assert np.abs(back - h).max() <= 1 / 256


def test_a_dem_becomes_a_terrain_pack_that_decodes_to_its_heights(tmp_path):
    src = write_dem(tmp_path / "dem.tif", with_pad=True, nodata_corner=True)
    result, _ = run_job(TerrainPack(), tmp_path, terrain_params(tmp_path, src))
    dest = tmp_path / "data" / "packs" / "terrain"
    meta = json.loads((dest / "site-dem.json").read_text("utf-8"))
    assert meta["kind"] == "terrain"
    assert meta["encoding"] == "terrarium"
    assert meta["verticalDatum"] == "egm2008"
    assert meta["customerLicence"] is False
    assert meta["format"] == "webp"
    z = meta["maxZoom"]
    assert z == 16
    from rasterio.warp import transform

    with PMTilesReader(dest / "site-dem.pmtiles") as r:
        assert r.metadata()["encoding"] == "terrarium"
        # Inside the plane (away from the pad, the nodata corner and the edges): pixel centres
        # decode to the source plane within 1/256 m (bilinear is exact on a plane).
        checked = 0
        for de, dn in [(60, -320), (150, -250), (330, -330), (200, -370), (370, -200)]:
            lon, lat = to_lonlat(E0 + de, N1 + dn)
            x, y, px, py = pixel_of(lon, lat, z)
            rgb = np.asarray(Image.open(io.BytesIO(r.get(z, x, y))).convert("RGB"))
            for qx, qy in [(px, py), (px + 1, py), (px, py + 1)]:
                plon, plat = pixel_lonlat(z, x, y, qx, qy)
                (pe,), (pn,) = transform("EPSG:4326", UTM, [plon], [plat])
                want = plane(pe, pn)
                got = terrarium_decode(rgb[qy, qx])
                assert abs(got - want) <= 1 / 256 + 1e-4, (de, dn, got, want)
                checked += 1
        assert checked == 15
        # The benchmark pad reads its height (the datum test: a site must not sink or float).
        lon, lat = to_lonlat(BENCHMARK[0], BENCHMARK[1])
        x, y, px, py = pixel_of(lon, lat, z)
        rgb = np.asarray(Image.open(io.BytesIO(r.get(z, x, y))).convert("RGB"))
        assert abs(terrarium_decode(rgb[py, px]) - BENCHMARK[2]) <= 1 / 256
        # An overview two zooms up still reads the pad within a centimetre.
        x, y, px, py = pixel_of(lon, lat, z - 2)
        rgb = np.asarray(Image.open(io.BytesIO(r.get(z - 2, x, y))).convert("RGB"))
        assert abs(terrarium_decode(rgb[py, px]) - BENCHMARK[2]) < 0.01
        # Lossless: WebP lossless decodes byte for byte (no codec noise in metres).
        assert r.header.tile_type == 4
    assert result["outputs"]["commit"]["pack"]["kind"] == "terrain"


def test_terrain_params_are_checked(tmp_path):
    p = TerrainPack()
    base = terrain_params(tmp_path, tmp_path / "dem.tif")
    with pytest.raises(JobError, match="verticalDatum must be one of"):
        p.validate({**base, "verticalDatum": "msl"})
    with pytest.raises(JobError, match="format must be one of"):
        p.validate({**base, "format": "jpeg"})
    with pytest.raises(JobError, match="does not take: customerLicence"):
        p.validate({**base, "customerLicence": True})


def test_lonlat_to_tile_matches_the_slippy_map_scheme():
    assert lonlat_to_tile(0, 0, 1) == (1, 1)
    assert lonlat_to_tile(-179.9, 85, 2) == (0, 0)
    assert lonlat_to_tile(47.97, 29.37, 10) == (648, 424)
