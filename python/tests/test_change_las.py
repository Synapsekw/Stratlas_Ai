"""LAS 1.4 reading and writing for the cloud change pipeline (synthetic points only)."""

import struct

import numpy as np
import pytest

from aio_pipelines.change.las import (
    EXTRA_BYTES_RECORD,
    LasError,
    parse_extra_bytes,
    read_las,
    write_las,
)


def _points(n=50, seed=1):
    rng = np.random.default_rng(seed)
    xyz = np.column_stack(
        [500000 + rng.uniform(0, 20, n), 3200000 + rng.uniform(0, 20, n), rng.uniform(0, 5, n)]
    )
    return xyz


def test_write_then_read_keeps_coordinates_and_fields(tmp_path):
    xyz = _points()
    path = tmp_path / "a.las"
    write_las(path, xyz, pdrf=7, intensity=np.arange(50, dtype=np.uint16), classification=np.full(50, 6))
    las = read_las(path)
    assert las.pdrf == 7
    assert las.record_length == 36
    assert las.count == 50
    assert np.allclose(las.xyz, xyz, atol=0.001)
    assert las.field("Intensity").tolist() == list(range(50))
    assert set(las.field("Classification").tolist()) == {6}
    assert las.extra == []


def test_the_header_names_quadrion_ai_in_its_32_byte_text_fields(tmp_path):
    path = tmp_path / "a.las"
    write_las(path, _points(), pdrf=6)
    head = path.read_bytes()[:90]
    assert head[26:58] == b"Quadrion AI".ljust(32, b"\0")
    assert head[58:90] == b"Quadrion AI change.cloud".ljust(32, b"\0")


def test_a_distance_field_is_appended_as_one_extra_bytes_float(tmp_path):
    xyz = _points()
    src = tmp_path / "src.las"
    write_las(src, xyz, pdrf=6)
    las = read_las(src)
    out = tmp_path / "out.las"
    d = np.linspace(-0.5, 0.5, 50).astype(np.float32)
    write_las(out, las.xyz, template=las, extra={"Distance": d})
    back = read_las(out)
    assert back.pdrf == 6
    assert back.record_length == 30 + 4
    assert [e.name for e in back.extra] == ["Distance"]
    assert back.extra[0].data_type == 9
    assert np.allclose(back.field("Distance"), d)
    assert np.allclose(back.xyz, xyz, atol=0.001)
    # the base record (intensity, class, gps time...) is copied byte for byte
    assert np.array_equal(back.records[:, :30], las.records[:, :30])


def test_extra_bytes_descriptors_parse_from_the_vlr_payload():
    rec = bytearray(EXTRA_BYTES_RECORD)
    rec[2] = 9  # float
    rec[3] = 0b110  # min and max given
    rec[4 : 4 + 8] = b"Distance"
    rec[64:72] = struct.pack("<d", -1.5)  # min (no_data 40, min 64, max 88, scale 112, offset 136)
    rec[88:96] = struct.pack("<d", 2.5)  # max
    rec[160 : 160 + 11] = b"C2C metres."
    dims = parse_extra_bytes(bytes(rec))
    assert len(dims) == 1
    assert dims[0].name == "Distance"
    assert dims[0].size == 4
    assert dims[0].min == -1.5
    assert dims[0].max == 2.5
    assert dims[0].description == "C2C metres."
    with pytest.raises(LasError, match="192"):
        parse_extra_bytes(bytes(100))


def test_not_a_las_file_is_refused(tmp_path):
    p = tmp_path / "x.las"
    p.write_bytes(b"NOPE" + bytes(400))
    with pytest.raises(LasError, match="not a LAS"):
        read_las(p)
