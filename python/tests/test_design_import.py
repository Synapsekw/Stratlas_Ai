"""design.import (M11 G6): LandXML, DXF, 12da and CSV designs to TINs, linework, points and alignments.

Small fixtures are written here by hand from the format descriptions (no vendor samples, no client
data): a 3 x 3 pad surface at a fictional site in UTM 39N, its breakline and boundary, two points
and an alignment with a line, a clothoid, an arc and a station equation. The alignment and its
truth points are shared with the TypeScript tests (``packages/survey/src/designs/__fixtures__/``);
the truth is recomputed here from ``scipy.special.fresnel``, independently of ``alignment.py``.
"""

from __future__ import annotations

import json
import math
import struct
from pathlib import Path

import ezdxf
import numpy as np
import pytest
from scipy.special import fresnel

from aio_pipelines.design import alignment as alg
from aio_pipelines.design import dxf as dxf_mod
from aio_pipelines.design import landxml as landxml_mod
from aio_pipelines.design import model
from aio_pipelines.design.csv_points import read_csv_points
from aio_pipelines.design.dxf import read_dxf
from aio_pipelines.design.importer import DesignImport, display_glb, read_design
from aio_pipelines.design.landxml import read_landxml
from aio_pipelines.design.tin_io import decode_tin, encode_tin, read_tin
from aio_pipelines.design.twelve_da import read_12da
from aio_pipelines.runtime import JobError
from conftest import run_job

ROOT = Path(__file__).resolve().parents[2]
FIXTURES = ROOT / "packages" / "survey" / "src" / "designs" / "__fixtures__"
SHARED = json.loads((FIXTURES / "alignment-clothoid.json").read_text("utf-8"))
CRS = {"epsg": 32639}
US_FT = 1200 / 3937

E0, N0 = 520010.0, 2750010.0


def pad_vertices() -> list[tuple[float, float, float]]:
    """3 x 3 grid, 10 m apart; a plane with the centre raised 1 m. Row-major from the south-west."""
    out = []
    for j in range(3):
        for i in range(3):
            z = 100 + 0.5 * i + 0.25 * j + (1.0 if (i, j) == (1, 1) else 0.0)
            out.append((E0 + 10 * i, N0 + 10 * j, z))
    return out


def pad_triangles() -> list[tuple[int, int, int]]:
    tris = []
    for j in range(2):
        for i in range(2):
            a = j * 3 + i
            tris += [(a, a + 1, a + 4), (a, a + 4, a + 3)]
    return tris


# ---------------------------------------------------------------------------------------------
# fixtures


def landxml_text(
    units: str = '<Metric linearUnit="meter" areaUnit="squareMeter" volumeUnit="cubicMeter" angularUnit="radians" directionUnit="radians"/>',
) -> str:
    v = pad_vertices()
    pnts = "\n".join(f'<P id="{k + 1}">{n:.4f} {e:.4f} {z:.4f}</P>' for k, (e, n, z) in enumerate(v))
    faces = "\n".join(f"<F>{a + 1} {b + 1} {c + 1}</F>" for a, b, c in pad_triangles())
    brk = " ".join(f"{n:.4f} {e:.4f} {z:.4f}" for e, n, z in v[3:6])
    corners = [v[0], v[2], v[8], v[6]]
    bnd = " ".join(f"{n:.4f} {e:.4f}" for e, n, _ in corners)
    al = SHARED["alignment"]
    line, spi, arc = al["elements"]

    def ne(p: list[float]) -> str:
        return f"{p[1]:.6f} {p[0]:.6f}"

    pi = SHARED["spiralPI"]
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<LandXML xmlns="http://www.landxml.org/schema/LandXML-1.2" version="1.2" date="2026-10-09" time="10:00:00">
  <Units>{units}</Units>
  <CoordinateSystem epsgCode="32639" name="WGS 84 / UTM zone 39N"/>
  <CgPoints name="Control">
    <CgPoint name="CP1" code="CTRL">{N0 - 5:.3f} {E0 - 5:.3f} 99.500</CgPoint>
    <CgPoint name="CP2">{N0 + 25:.3f} {E0 + 25:.3f} 101.250</CgPoint>
  </CgPoints>
  <Surfaces>
    <Surface name="Pad design">
      <Definition surfType="TIN">
        <Pnts>
{pnts}
        </Pnts>
        <Faces>
{faces}
          <F i="1">1 2 3</F>
        </Faces>
      </Definition>
      <SourceData>
        <Breaklines><Breakline brkType="standard" name="crest"><PntList3D>{brk}</PntList3D></Breakline></Breaklines>
        <Boundaries><Boundary bndType="outer" edgeTrim="true" name="edge"><PntList2D>{bnd}</PntList2D></Boundary></Boundaries>
      </SourceData>
    </Surface>
  </Surfaces>
  <Alignments name="Roads">
    <Alignment name="CL1" length="210" staStart="1000">
      <CoordGeom>
        <Line><Start>{ne(line["start"])}</Start><End>{ne(line["end"])}</End></Line>
        <Spiral length="60" radiusStart="INF" radiusEnd="200" rot="cw" spiType="clothoid">
          <Start>{ne(spi["start"])}</Start><PI>{ne(pi)}</PI><End>{ne(spi["end"])}</End>
        </Spiral>
        <Curve rot="cw" crvType="arc" radius="200" length="50">
          <Start>{ne(arc["start"])}</Start><Center>{ne(arc["center"])}</Center><End>{ne(arc["end"])}</End>
        </Curve>
      </CoordGeom>
      <StaEquation staBack="1150" staAhead="2000" staInternal="1150"/>
    </Alignment>
  </Alignments>
</LandXML>
"""


def write(tmp: Path, name: str, data: str | bytes) -> Path:
    p = tmp / name
    p.write_bytes(data.encode("utf-8") if isinstance(data, str) else data)
    return p


def project(tmp: Path) -> Path:
    root = tmp / "proj"
    root.mkdir()
    (root / "manifest.json").write_text(
        json.dumps(
            {"schema": "aio.project/1", "crs": CRS, "origin": [520000.0, 2750000.0, 100.0], "layers": []}
        ),
        "utf-8",
    )
    return root


def dxf_pad(path: Path, insunits: int = 6, scale: float = 1.0) -> Path:
    doc = ezdxf.new("R2010")
    doc.header["$INSUNITS"] = insunits
    msp = doc.modelspace()
    v = [(e / scale, n / scale, z / scale) for e, n, z in pad_vertices()]
    for a, b, c in pad_triangles():
        msp.add_3dface([v[a], v[b], v[c], v[c]], dxfattribs={"layer": "PAD"})
    msp.add_polyline3d([v[3], v[4], v[5]], dxfattribs={"layer": "BRK"})
    lw = msp.add_lwpolyline(
        [(v[0][0], v[0][1]), (v[2][0], v[2][1]), (v[8][0], v[8][1])], dxfattribs={"layer": "EDGE"}
    )
    lw.dxf.elevation = 100.0 / scale
    msp.add_point((E0 / scale, N0 / scale, 99.0 / scale), dxfattribs={"layer": "PTS"})
    mesh = msp.add_mesh(dxfattribs={"layer": "MESH"})
    with mesh.edit_data() as md:
        md.vertices = [v[0], v[1], v[4], v[3]]
        md.faces = [(0, 1, 2, 3)]
    pf = msp.add_polyface(dxfattribs={"layer": "PFACE"})
    pf.append_face([v[0], v[1], v[4]])
    pf.append_face([v[0], v[4], v[3]])
    doc.saveas(path)
    return path


TWELVE_DA = """// 12da written by hand for the G6 tests
model "design"
string 3d {
  name "crest"
  colour red
  data {
    520010.0 2750020.0 100.25
    520020.0 2750020.0 101.75
    520030.0 2750020.0 101.25
  }
}
string 2d {
  name "edge"
  z 100.0
  closed true
  data {
    520010.0 2750010.0
    520030.0 2750010.0
    520030.0 2750030.0
  }
}
string 3d {
  name "spots"
  breakline point
  data {
    520005.0 2750005.0 99.5
  }
}
tin {
  name "pad"
  points {
    520010.0 2750010.0 100.0
    520020.0 2750010.0 100.5
    520020.0 2750020.0 101.75
    520010.0 2750020.0 100.25
  }
  triangles {
    1 2 3 0 0 0
    1 3 4 0 0 0
  }
}
"""


# ---------------------------------------------------------------------------------------------
# alignment arithmetic


def _truth(s: float) -> tuple[float, float]:
    al = SHARED["alignment"]
    e0, n0 = al["elements"][0]["start"]
    k = math.sqrt(200 * 60 * math.pi)
    if s <= 100:
        return e0, n0 + s
    if s <= 160:
        sf, cf = fresnel((s - 100) / k)
        return e0 + k * sf, n0 + 100 + k * cf
    raise ValueError


def test_the_shared_truth_is_the_fresnel_integral():
    for t in SHARED["truth"]:
        if t["offset"] == 0 and t["distance"] <= 160:
            e, n = _truth(t["distance"])
            assert abs(e - t["e"]) < 1e-9 and abs(n - t["n"]) < 1e-9


def test_point_at_station_matches_the_truth_within_1e_6():
    al = SHARED["alignment"]
    for t in SHARED["truth"]:
        if t["offset"]:
            continue
        e, n, b = alg.point_at_station(al, t["station"], t["region"])
        assert abs(e - t["e"]) < 1e-6 and abs(n - t["n"]) < 1e-6
        assert abs(b - t["bearing"]) < 1e-9


def test_station_and_offset_of_known_points_within_1_mm():
    al = SHARED["alignment"]
    for t in SHARED["truth"]:
        so = alg.station_offset(al, t["e"], t["n"])
        assert so is not None
        assert abs(so.station - t["station"]) < 0.001, t
        assert abs(so.offset - t["offset"]) < 0.001, t
        assert so.region == t["region"]


def test_clothoid_station_and_offset_on_a_dense_walk():
    al = SHARED["alignment"]
    for s in np.linspace(100.5, 159.5, 25):
        e, n, b = alg.point_at(al, float(s))
        pe, pn = e + 2.5 * math.cos(b), n - 2.5 * math.sin(b)  # 2.5 m right
        so = alg.station_offset(al, pe, pn)
        assert so is not None
        assert abs(so.distance - s) < 1e-6 and abs(so.offset - 2.5) < 1e-6


def test_station_equations_and_labels():
    al = SHARED["alignment"]
    assert alg.station_at(al, 149.0) == (1149.0, 0)
    assert alg.station_at(al, 150.0) == (2000.0, 1)
    assert alg.distance_at(al, 2060.0) == 210.0
    assert alg.distance_at(al, 1160.0) is None  # past the equation: no such station
    labels = alg.station_labels(al, 50)
    assert [x[2] for x in labels] == ["1+000", "1+050", "1+100", "1+150", "2+000", "2+050"]
    assert alg.format_station(1234.5678) == "1+234.568"
    assert alg.format_station(-12.3, 2) == "-0+012.30"
    bad = {**al, "equations": [{"back": 5000.0, "ahead": 6000.0}]}
    with pytest.raises(ValueError, match="outside the alignment"):
        alg.regions(bad)


def test_points_off_the_ends_have_no_station():
    al = SHARED["alignment"]
    e0, n0 = al["elements"][0]["start"]
    assert alg.station_offset(al, e0, n0 - 10) is None


# ---------------------------------------------------------------------------------------------
# aio.tin/1


def test_tin_layout_is_the_documented_one():
    v = np.asarray(pad_vertices())
    t = np.asarray(pad_triangles(), dtype=np.uint32)
    data = encode_tin(v, t, CRS, [(0, np.asarray([3, 4, 5], dtype=np.uint32))])
    (n,) = struct.unpack_from("<I", data, 0)
    header = json.loads(data[4 : 4 + n])
    assert header["schema"] == "aio.tin/1" and header["crs"] == CRS
    assert header["vertexCount"] == 9 and header["triangleCount"] == 8 and header["breaklines"] == 1
    assert header["verticesAt"] % 8 == 0 and header["verticesAt"] >= 4 + n
    assert header["trianglesAt"] == header["verticesAt"] + 9 * 24
    assert header["chainsAt"] == header["trianglesAt"] + 8 * 12
    assert header["bounds"] == [E0, N0, 100.0, E0 + 20, N0 + 20, 101.75]
    got = np.frombuffer(data, "<f8", 27, header["verticesAt"]).reshape(-1, 3)
    assert np.array_equal(got, v)
    assert np.array_equal(np.frombuffer(data, "<u4", 24, header["trianglesAt"]).reshape(-1, 3), t)
    tin = decode_tin(data)
    assert np.array_equal(tin.vertices, v) and np.array_equal(tin.triangles, t)
    assert tin.chains[0][0] == 0 and list(tin.chains[0][1]) == [3, 4, 5]
    # the shared fixture the TypeScript reader runs is exactly these bytes
    assert (FIXTURES / "pad.tin").read_bytes() == data


def test_vertical_offset_moves_every_vertex_exactly():
    v = np.asarray(pad_vertices())
    data = encode_tin(v, np.asarray(pad_triangles()), CRS)
    for off in (-0.3, 0.125, 2.0):
        tin = decode_tin(data, off)
        assert np.array_equal(tin.vertices[:, :2], v[:, :2])
        assert np.array_equal(tin.vertices[:, 2], v[:, 2] + off)


def test_tin_refuses_a_short_file():
    data = encode_tin(np.asarray(pad_vertices()), np.asarray(pad_triangles()), CRS)
    with pytest.raises(JobError, match="shorter than its header"):
        decode_tin(data[:-10])


# ---------------------------------------------------------------------------------------------
# formats


def test_landxml_surface_points_and_alignment(tmp_path):
    d = read_landxml(write(tmp_path, "pad.xml", landxml_text()))
    assert d.units == "m" and d.crs == CRS
    (s,) = d.surfaces
    assert s.name == "Pad design" and len(s.vertices) == 9 and len(s.triangles) == 8
    assert np.allclose(s.vertices[4], (E0 + 10, N0 + 10, 101.75), atol=1e-6, rtol=0)
    kinds = [k for k, _ in s.chains]
    assert kinds == [model.CHAIN_BREAKLINE, model.CHAIN_OUTER]
    (pts,) = d.points
    assert [p.id for p in pts.points] == ["CP1", "CP2"] and pts.points[0].code == "CTRL"
    assert pts.points[0].e == pytest.approx(E0 - 5) and pts.points[0].n == pytest.approx(N0 - 5)
    (al,) = d.alignments
    assert [e["type"] for e in al.elements] == ["line", "spiral", "arc"]
    assert al.start_station == 1000 and al.equations == [{"back": 1150.0, "ahead": 2000.0}]
    body = {"startStation": al.start_station, "elements": al.elements, "equations": al.equations}
    assert abs(al.elements[1]["dirStart"]) < 1e-9
    for t in SHARED["truth"]:
        so = alg.station_offset(body, t["e"], t["n"])
        assert (
            so is not None and abs(so.station - t["station"]) < 0.001 and abs(so.offset - t["offset"]) < 0.001
        )


def test_landxml_us_survey_feet(tmp_path):
    units = '<Imperial linearUnit="USSurveyFoot" areaUnit="squareFoot" volumeUnit="cubicYard" angularUnit="radians"/>'
    d = read_landxml(write(tmp_path, "pad.xml", landxml_text(units)))
    assert d.units == "us-ft"


def test_dxf_faces_lines_points_mesh_and_polyface(tmp_path):
    d = read_dxf(dxf_pad(tmp_path / "pad.dxf"))
    assert d.units == "m"
    surfaces = {s.name: s for s in d.surfaces}
    assert len(surfaces["PAD"].vertices) == 9 and len(surfaces["PAD"].triangles) == 8
    assert len(surfaces["MESH"].triangles) == 2 and len(surfaces["PFACE"].triangles) == 2
    k = {tuple(x) for x in surfaces["PAD"].vertices.tolist()}
    assert (E0 + 10, N0 + 10, 101.75) in k
    lines = {lw.name: lw for lw in d.linework}
    assert lines["BRK"].lines[0].coords.shape == (3, 3)
    assert np.allclose(lines["EDGE"].lines[0].coords[:, 2], 100.0)
    assert d.points[0].name == "PTS" and d.points[0].points[0].z == 99.0


def test_12da_tin_strings_and_points(tmp_path):
    d = read_12da(write(tmp_path, "pad.12da", TWELVE_DA))
    (s,) = d.surfaces
    assert s.name == "pad" and len(s.vertices) == 4 and len(s.triangles) == 2
    assert s.triangles.tolist() == [[0, 1, 2], [0, 2, 3]]
    assert np.allclose(s.vertices[2], (520020.0, 2750020.0, 101.75), atol=1e-6)
    (lw,) = d.linework
    assert [x.name for x in lw.lines] == ["crest", "edge"]
    assert lw.lines[1].closed and np.allclose(lw.lines[1].coords[:, 2], 100.0)
    assert d.points[0].points[0].z == 99.5


def test_csv_pnezd_with_a_bom_semicolons_and_decimal_commas(tmp_path):
    p = write(
        tmp_path, "pts.csv", b"\xef\xbb\xbf1;2750010,5;520010,25;100,125;TOE\n2;2750020;520020;101;CREST\n"
    )
    d = read_csv_points(p)
    a, b = d.points[0].points
    assert (a.id, a.n, a.e, a.z, a.code) == ("1", 2750010.5, 520010.25, 100.125, "TOE")
    assert b.code == "CREST"


def test_csv_penzd_by_header_and_plain_nez(tmp_path):
    d = read_csv_points(
        write(tmp_path, "a.csv", "Point,Easting,Northing,Elevation,Code\nA,520010,2750010,100,X\n")
    )
    p = d.points[0].points[0]
    assert (p.id, p.e, p.n, p.z, p.code) == ("A", 520010, 2750010, 100, "X")
    d = read_csv_points(write(tmp_path, "b.txt", "2750010 520010 100\n2750011 520011 101\n"))
    assert [(p.e, p.n) for p in d.points[0].points] == [(520010, 2750010), (520011, 2750011)]


def test_csv_latitude_longitude_points(tmp_path):
    d = read_csv_points(write(tmp_path, "g.csv", "Name,Latitude,Longitude,Height\nA,24.8,51.2,12\n"))
    assert d.crs == {"epsg": 4326}
    assert (d.points[0].points[0].e, d.points[0].points[0].n) == (51.2, 24.8)


# ---------------------------------------------------------------------------------------------
# hostile files: exact refusals naming the line or entity


BILLION_LAUGHS = """<?xml version="1.0"?>
<!DOCTYPE lolz [
 <!ENTITY lol "lol">
 <!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">
]>
<LandXML><Surfaces/>&lol2;</LandXML>
"""

EXTERNAL = """<?xml version="1.0"?>
<!DOCTYPE LandXML [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>
<LandXML>&xxe;</LandXML>
"""


@pytest.mark.parametrize("text", [BILLION_LAUGHS, EXTERNAL])
def test_landxml_with_a_dtd_or_entities_is_refused(tmp_path, text):
    with pytest.raises(JobError) as err:
        read_landxml(write(tmp_path, "bad.xml", text))
    assert str(err.value).startswith('"bad.xml" line 2: the file declares a document type (DTD).')


def test_landxml_not_well_formed_names_the_line(tmp_path):
    with pytest.raises(JobError, match=r'"bad.xml" line 3: the XML is not well formed'):
        read_landxml(write(tmp_path, "bad.xml", "<?xml version='1.0'?>\n<LandXML>\n<Surfaces></Surface>\n"))


def test_landxml_bad_numbers_and_faces_name_the_line(tmp_path):
    text = landxml_text().replace('<P id="5">', '<P id="5">abc ', 1)
    with pytest.raises(JobError, match=r'line \d+: surface "Pad design point: "abc" is not a number'):
        read_landxml(write(tmp_path, "bad.xml", text))
    text = landxml_text().replace("<F>1 2 5</F>", "<F>1 2 99</F>", 1)
    with pytest.raises(JobError, match=r"a face names point 99, which is not in Pnts"):
        read_landxml(write(tmp_path, "bad2.xml", text))


def test_landxml_above_the_triangle_limit_is_refused(tmp_path, monkeypatch):
    monkeypatch.setattr(landxml_mod, "MAX_TRIANGLES", 5)
    with pytest.raises(JobError, match=r'line \d+: the surface "Pad design" has more than 5 triangles'):
        read_landxml(write(tmp_path, "big.xml", landxml_text()))


def test_a_file_above_500_mb_is_refused(tmp_path, monkeypatch):
    p = write(tmp_path, "big.xml", landxml_text())
    monkeypatch.setattr(model, "MAX_FILE_BYTES", 100)
    with pytest.raises(JobError, match=r'^"big.xml": the file is .* above the limit of 500 MB'):
        model.check_size(p)


def test_binary_dxf_and_dwg_are_refused(tmp_path):
    with pytest.raises(JobError, match=r'^"b.dxf": this is a binary DXF'):
        read_dxf(write(tmp_path, "b.dxf", b"AutoCAD Binary DXF\r\n\x1a\x00" + b"\x00" * 40))
    with pytest.raises(JobError, match=r'^"d.dxf": this is a DWG drawing'):
        read_dxf(write(tmp_path, "d.dxf", b"AC1027" + b"\x00" * 40))


def test_a_broken_dxf_group_code_names_its_line(tmp_path):
    text = "0\nSECTION\n2\nENTITIES\nxx\nPOINT\n0\nENDSEC\n0\nEOF\n"
    with pytest.raises(JobError, match=r'^"bad.dxf" line 5: "xx" is not a DXF group code'):
        read_dxf(write(tmp_path, "bad.dxf", text))


def test_a_dxf_with_too_many_entities_is_refused_before_loading(tmp_path, monkeypatch):
    p = dxf_pad(tmp_path / "many.dxf")
    monkeypatch.setattr(dxf_mod, "MAX_ENTITIES", 3)
    with pytest.raises(JobError, match=r'^"many.dxf" line \d+: the drawing has more than 3 entities'):
        read_dxf(p)


def test_a_dxf_layer_above_the_triangle_limit_names_the_entity(tmp_path, monkeypatch):
    p = dxf_pad(tmp_path / "big.dxf")
    monkeypatch.setattr(dxf_mod, "MAX_TRIANGLES", 3)
    with pytest.raises(
        JobError, match=r'^"big.dxf" entity [0-9A-F]+: the layer "PAD" has more than 3 triangles'
    ):
        read_dxf(p)


def test_broken_12da_records_name_their_line(tmp_path):
    bad = TWELVE_DA.replace("520020.0 2750020.0 101.75\n    520030.0", "520020.0 abc 101.75\n    520030.0", 1)
    with pytest.raises(JobError, match=r'^"bad.12da" line 8: string at line 3: "abc" is not a number'):
        read_12da(write(tmp_path, "bad.12da", bad))
    with pytest.raises(JobError, match=r'^"open.12da" line \d+: the file ends inside a block'):
        read_12da(write(tmp_path, "open.12da", 'model "x"\nstring 3d {\n data {\n 1 2 3\n'))
    tri = TWELVE_DA.replace("1 3 4 0 0 0", "1 3 9 0 0 0")
    with pytest.raises(JobError, match=r'^"tri.12da" line 39: the tin "pad" has a triangle naming vertex'):
        read_12da(write(tmp_path, "tri.12da", tri))


def test_csv_with_mixed_separators_is_refused_at_its_line(tmp_path):
    with pytest.raises(
        JobError, match=r'^"m.csv" line 2: the row uses \';\' but the file separates columns with \',\''
    ):
        read_csv_points(write(tmp_path, "m.csv", "1,2750010,520010,100,A\n2;2750020;520020;101;B\n"))


def test_csv_with_latitude_and_longitude_swapped_is_refused(tmp_path):
    with pytest.raises(JobError, match=r'^"s.csv" line 3: the latitude 151.2 .* may be swapped'):
        read_csv_points(
            write(tmp_path, "s.csv", "Name,Latitude,Longitude,Z\nA,-33.8,151.2,1\nB,151.2,-33.8,1\n")
        )


def test_ttm_is_refused_with_the_supported_path(tmp_path):
    with pytest.raises(JobError, match="no published specification"):
        read_design(write(tmp_path, "a.ttm", b"\x00\x01"), "ttm")


# ---------------------------------------------------------------------------------------------
# the pipeline


def test_import_landxml_end_to_end(tmp_path):
    root = project(tmp_path)
    src = write(tmp_path, "Pad design.xml", landxml_text())
    result, rec = run_job(DesignImport(), root, {"src": str(src)})
    assert result["status"] == "done"
    designs = json.loads((root / "survey" / "designs.json").read_text("utf-8"))
    assert designs["schema"] == "aio.designs/1"
    (d,) = designs["designs"]
    assert d["id"] == "Pad-design" and d["format"] == "landxml" and d["units"] == "m"
    assert d["crs"] == CRS and d["calibrated"] is False and d["src"] == "Pad design.xml"
    folder = root / "survey" / "designs" / "Pad-design"
    assert (folder / "Pad design.xml").read_bytes() == src.read_bytes()
    kinds = {x["kind"]: x for x in d["layers"]}
    surf = kinds["surface"]
    assert surf["counts"] == {"triangles": 8, "vertices": 9, "breaklines": 1, "boundaries": 1}
    assert surf["glb"] == "Pad-design.glb" and (folder / surf["glb"]).read_bytes()[:4] == b"glTF"
    tin = read_tin(folder / surf["file"])
    assert tin.header["crs"] == CRS and len(tin.vertices) == 9 and len(tin.triangles) == 8
    assert np.allclose(tin.vertices[4], (E0 + 10, N0 + 10, 101.75), atol=1e-6, rtol=0)
    assert [k for k, _ in tin.chains] == [0, 1] and list(tin.chains[0][1]) == [3, 4, 5]
    assert list(tin.chains[1][1]) == [0, 2, 8, 6]
    al = json.loads((folder / kinds["alignment"]["file"]).read_text("utf-8"))
    assert al["schema"] == "aio.alignment/1" and al["startStation"] == 1000.0
    assert kinds["alignment"]["counts"] == {
        "elements": 3,
        "lines": 1,
        "arcs": 1,
        "spirals": 1,
        "equations": 1,
    }
    pts = json.loads((folder / kinds["points"]["file"]).read_text("utf-8"))
    assert pts["type"] == "FeatureCollection" and pts["crs"] == CRS
    assert pts["features"][0]["properties"] == {"id": "CP1", "code": "CTRL"}
    assert pts["features"][0]["geometry"] == {"type": "Point", "coordinates": [E0 - 5, N0 - 5, 99.5]}
    lw = json.loads((folder / kinds["linework"]["file"]).read_text("utf-8"))
    assert lw["features"][0]["geometry"]["coordinates"][0] == [E0, N0 + 10, 100.25]
    # a second import of the same file gets its own id; the first is kept
    run_job(DesignImport(), root, {"src": str(src)}, job_id="j2")
    designs = json.loads((root / "survey" / "designs.json").read_text("utf-8"))
    assert [x["id"] for x in designs["designs"]] == ["Pad-design", "Pad-design-2"]
    assert (root / "survey" / "designs.json.bak").exists()


def test_import_dxf_in_us_survey_feet_scales_to_metres(tmp_path):
    root = project(tmp_path)
    src = dxf_pad(tmp_path / "pad-usft.dxf", insunits=21, scale=US_FT)
    run_job(DesignImport(), root, {"src": str(src), "layers": ["PAD", "BRK"]})
    (d,) = json.loads((root / "survey" / "designs.json").read_text("utf-8"))["designs"]
    assert d["units"] == "us-ft" and [x["id"] for x in d["layers"]] == ["PAD", "BRK"]
    tin = read_tin(root / "survey" / "designs" / d["id"] / "PAD.tin")
    want = np.asarray(sorted(pad_vertices()))
    got = tin.vertices[np.lexsort((tin.vertices[:, 1], tin.vertices[:, 0]))]
    assert np.abs(got - want).max() < 1e-6


def test_import_12da_and_csv(tmp_path):
    root = project(tmp_path)
    run_job(DesignImport(), root, {"src": str(write(tmp_path, "pad.12da", TWELVE_DA)), "id": "pad12"})
    csv = write(tmp_path, "pts.csv", "1,2750010,520010,100,A\n2,2750020,520020,101,B\n")
    run_job(DesignImport(), root, {"src": str(csv), "name": "Survey points"}, job_id="j2")
    ds = json.loads((root / "survey" / "designs.json").read_text("utf-8"))["designs"]
    assert [d["id"] for d in ds] == ["pad12", "pts"]
    assert ds[1]["name"] == "Survey points" and ds[1]["layers"][0]["counts"] == {"points": 2, "codes": 2}
    tin = read_tin(root / "survey" / "designs" / "pad12" / "pad.tin")
    assert len(tin.vertices) == 4 and len(tin.triangles) == 2


def test_import_places_a_design_from_another_crs(tmp_path):
    root = project(tmp_path)
    csv = write(tmp_path, "g.csv", "Name,Latitude,Longitude,Height\nA,24.8,51.2,12\n")
    run_job(DesignImport(), root, {"src": str(csv)})
    (d,) = json.loads((root / "survey" / "designs.json").read_text("utf-8"))["designs"]
    assert d["crs"] == {"epsg": 4326}
    feature = json.loads((root / "survey" / "designs" / "g" / "g.points.json").read_text("utf-8"))[
        "features"
    ][0]
    e, n, z = feature["geometry"]["coordinates"]
    # 51.2 E is 0.2 degrees east of the zone 39N central meridian (51 E), 24.8 N
    assert 520000 < e < 520300 and 2742000 < n < 2745000 and z == 12


def test_import_refusals(tmp_path):
    root = project(tmp_path)
    pipe = DesignImport()
    src = write(tmp_path, "pad.xml", landxml_text())
    run_job(pipe, root, {"src": str(src), "id": "pad"})
    with pytest.raises(JobError, match='already has a design "pad"'):
        run_job(pipe, root, {"src": str(src), "id": "pad"}, job_id="j2")
    with pytest.raises(JobError, match=r"has no layer Nope. Its layers are: Control, Pad design, CL1"):
        run_job(pipe, root, {"src": str(src), "layers": ["Nope"]}, job_id="j3")
    with pytest.raises(JobError, match="This site has no calibration"):
        run_job(pipe, root, {"src": str(src), "useCalibration": True}, job_id="j4")
    (root / "survey" / "calibration.json").write_text(
        json.dumps({"schema": "aio.site-calibration/1"}), "utf-8"
    )
    with pytest.raises(JobError, match="The site calibration is a draft"):
        run_job(pipe, root, {"src": str(src), "useCalibration": True}, job_id="j5")
    (root / "survey" / "calibration.json").write_text(
        json.dumps({"appliedAt": "2026-10-09T00:00:00Z"}), "utf-8"
    )
    with pytest.raises(JobError, match="has no base projection or adjustment"):
        run_job(pipe, root, {"src": str(src), "useCalibration": True}, job_id="j6")
    dwg = write(tmp_path, "plan.dwg", b"AC1027\x00\x00")
    with pytest.raises(JobError, match="DWG drawing"):
        run_job(pipe, root, {"src": str(dwg)}, job_id="j7")
    nounits = tmp_path / "nounits.dxf"
    dxf_pad(nounits, insunits=0)
    with pytest.raises(JobError, match=r"has no drawing units \(\$INSUNITS\)"):
        run_job(pipe, root, {"src": str(nounits)}, job_id="j8")
    with pytest.raises(JobError, match="Give a CRS or use the site calibration, not both"):
        pipe.validate({"src": str(src), "useCalibration": True, "crs": CRS})
    # nothing was added by a refused import
    ds = json.loads((root / "survey" / "designs.json").read_text("utf-8"))["designs"]
    assert [d["id"] for d in ds] == ["pad"]


CAL_H = {
    "originE": E0,
    "originN": N0,
    "shiftE": -519000.0,
    "shiftN": -2749000.0,
    "rotationRad": 0.3,
    "scale": 1.0002,
}
CAL_V = {"originE": 1000.0, "originN": 1000.0, "shiftM": -2.5, "slopeN": 0.001, "slopeE": -0.002}


@pytest.mark.parametrize("base_epsg", [32639, 32640])
def test_import_places_local_points_through_the_site_calibration(tmp_path, base_epsg):
    """Local grid points go back through G1's calibration to the project CRS (within 1 mm)."""
    from pyproj import Transformer

    from aio_pipelines.geodesy.calibration import apply_horizontal, plane_dz

    root = project(tmp_path)
    truth = np.asarray(pad_vertices()[:4])  # in the project CRS (UTM 39N)
    base = truth.copy()
    if base_epsg != CRS["epsg"]:
        e, n = Transformer.from_crs(CRS["epsg"], base_epsg, always_xy=True).transform(
            truth[:, 0], truth[:, 1]
        )
        base[:, 0], base[:, 1] = e, n
        cal = {**CAL_H, "originE": float(base[0, 0]), "originN": float(base[0, 1])}
    else:
        cal = CAL_H
    # the calibration's model (G1's numpy side, not the PROJ pipeline under test): base to local
    le, ln = apply_horizontal(cal, base[:, 0], base[:, 1])
    lz = base[:, 2] + plane_dz(CAL_V, le, ln)
    (root / "survey").mkdir()
    (root / "survey" / "calibration.json").write_text(
        json.dumps(
            {
                "schema": "aio.site-calibration/1",
                "id": "cal-1",
                "name": "Site grid",
                "projection": {"epsg": base_epsg},
                "horizontal": cal,
                "vertical": CAL_V,
                "pairs": [],
                "computedAt": "2026-10-09T00:00:00Z",
                "appliedAt": "2026-10-09T00:00:00Z",
            }
        ),
        "utf-8",
    )
    rows = "".join(
        f"{k + 1},{n:.6f},{e:.6f},{z:.6f},P\n" for k, (e, n, z) in enumerate(zip(le, ln, lz, strict=True))
    )
    run_job(DesignImport(), root, {"src": str(write(tmp_path, "local.csv", rows)), "useCalibration": True})
    (d,) = json.loads((root / "survey" / "designs.json").read_text("utf-8"))["designs"]
    assert d["calibrated"] is True
    pts = json.loads((root / "survey" / "designs" / d["id"] / d["layers"][0]["file"]).read_text("utf-8"))
    got = np.asarray([f["geometry"]["coordinates"] for f in pts["features"]])
    assert np.abs(got - truth).max() < 1e-3


def test_display_glb_faces_point_up():
    import trimesh

    v = np.asarray(pad_vertices())
    t = np.asarray([(0, 4, 1), (0, 3, 4)])  # the first is clockwise seen from above
    glb = display_glb(v, t, np.asarray([E0, N0, 100.0]))
    mesh = trimesh.load(trimesh.util.wrap_as_stream(glb), file_type="glb", force="mesh")
    assert (mesh.face_normals[:, 1] > 0).all()
