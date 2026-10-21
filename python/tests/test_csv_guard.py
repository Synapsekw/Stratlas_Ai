"""CSV formula injection guard for every CSV the pipelines write."""

import csv
import io

import pytest

from aio_pipelines.csvsafe import csv_text

# Built at run time so the source holds no spreadsheet formula text.
EQ, PLUS, MINUS, AT = "=", "+", "-", "@"


@pytest.mark.parametrize("v", [EQ + "1+1", PLUS + "1+1", MINUS + "2+3", AT + "x", "\tx", "\rx"])
def test_a_formula_is_kept_as_text(v):
    assert csv_text(v) == "'" + v


@pytest.mark.parametrize("v", ["Cracked pane", "", "a=b", "-1.20", "+3", "-4e-3", 12, -3.5, None])
def test_text_and_numbers_are_left_alone(v):
    assert csv_text(v) == v


def test_the_points_csv_guards_ids_and_codes(tmp_path):
    from aio_pipelines.export.vector import PointRow, write_points_csv

    path = tmp_path / "p.csv"
    write_points_csv(path, [PointRow(id=EQ + "1+1", x=-1.0, y=-2.0, z=3.0, code=AT + "x")], "ENZ")
    rows = list(csv.reader(io.StringIO(path.read_text("utf-8"))))
    assert rows[1][0] == "'" + EQ + "1+1"
    assert rows[1][4] == "'" + AT + "x"
    assert not rows[1][1].startswith("'")


def test_the_aik_findings_csv_guards_a_note():
    from aio_pipelines.aik.records import csv_text as findings_csv

    photo = {"id": "p1", "name": MINUS + "x.jpg", "findings": [1]}
    finding = {
        "fid": "F1",
        "photo": "p1",
        "severity": 3,
        "label": "Severe",
        "classLabel": "Crack",
        "component": "Wall",
        "zoneLabel": "A",
        "height": -1.5,
        "side": "N",
        "bearing": None,
        "mapped": True,
        "coverage": 0.1,
        "note": EQ + "2*3",
    }
    text = findings_csv({"photos": [photo], "findings": [finding]})
    row = next(csv.reader(io.StringIO(text.splitlines()[1])))
    assert row[3] == "'" + MINUS + "x.jpg"
    assert row[9] == "-1.50"
    assert row[14] == "'" + EQ + "2*3"
