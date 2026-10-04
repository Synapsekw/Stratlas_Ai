"""Ports of kit contact.py (sheets, grid, crop), DAMAC sheetpx.py and kit adapters/detections.py."""

import json

import pytest
from PIL import Image

from aio_pipelines.aik import contact as Ct
from aio_pipelines.aik import detections as D
from aio_pipelines.aik.config import KitJob


def photos(tmp_path, n, size=(2560, 1920)):
    out = []
    for i in range(n):
        p = tmp_path / f"p{i + 1:03d}.jpg"
        Image.new("RGB", size, (40 + i * 10, 90, 120)).save(p)
        out.append({"id": f"p{i + 1:03d}", "path": str(p), "pw": size[0], "ph": size[1]})
    return out


def test_sheets_follow_the_kit_grid_and_label_each_photo(tmp_path):
    ps = photos(tmp_path, 14)
    layout = Ct.sheet_layout(ps, per=12, width=1800)
    assert [s["name"] for s in layout] == ["sheet-00", "sheet-01"]
    assert layout[0]["size"] == [1800, 900]  # 4 columns of 450, 3 rows of 300
    c = layout[0]["cells"][5]
    assert (c["x"], c["y"]) == (450 + 2, 300 + 2)  # second row, second column
    # the thumbnail Pillow makes for a 4:3 photo inside 446 x 296
    with Image.open(ps[5]["path"]) as im:
        im.thumbnail((446, 296))
        assert (c["w"], c["h"]) == im.size
    files = Ct.sheets(layout, str(tmp_path / "contact"))
    with Image.open(files[1]) as sh:
        assert sh.size == (1800, 900)
        assert sh.getpixel((1700, 850)) == (20, 20, 20)  # empty cells stay the sheet colour
    before = (tmp_path / "contact" / "sheet-00.jpg").stat().st_mtime_ns
    Ct.sheets(layout, str(tmp_path / "contact"))  # resume: written sheets are kept
    assert (tmp_path / "contact" / "sheet-00.jpg").stat().st_mtime_ns == before


def test_a_box_on_a_sheet_maps_back_to_review_copy_pixels(tmp_path):
    layout = Ct.sheet_layout(photos(tmp_path, 3), per=12, width=1800)
    c = layout[0]["cells"][2]
    s = c["w"] / c["pw"]
    hit = Ct.sheet_to_photo(
        layout[0], [c["x"] + 100 * s, c["y"] + 200 * s, c["x"] + 300 * s, c["y"] + 260 * s]
    )
    assert hit["image"] == "p003"
    assert hit["bbox"] == pytest.approx([100, 200, 300, 260], abs=1)
    assert Ct.sheet_to_photo(layout[0], [1700, 800, 1710, 810]) is None


def test_grid_and_crop(tmp_path):
    (p,) = photos(tmp_path, 1, (1000, 750))
    assert Ct.grid(p["path"], str(tmp_path / "g.jpg")) == (1000, 750)
    with Image.open(tmp_path / "g.jpg") as g:
        assert g.getpixel((100, 400))[0] > 200  # the yellow line at x = 100
    Ct.crop(p["path"], (10, 20, 210, 120), str(tmp_path / "c.jpg"))
    with Image.open(tmp_path / "c.jpg") as c:
        assert c.size == (200, 100)


def kit_job(tmp_path):
    (tmp_path / "photos").mkdir()
    Image.new("RGB", (1000, 750)).save(tmp_path / "photos" / "p001.jpg")
    Image.new("RGB", (1000, 750)).save(tmp_path / "photos" / "p002.jpg")
    cams = {"photos": [
        {"id": "p001", "name": "DJI_0001.JPG", "source_name": "f1/DJI_0001.JPG", "file": "photos/p001.jpg",
         "width": 4000, "height": 3000},
        {"id": "p002", "name": "DJI_0002.JPG", "file": "photos/p002.jpg", "width": 4000, "height": 3000},
    ]}  # fmt: skip
    (tmp_path / "cameras.json").write_text(json.dumps(cams))
    return KitJob({"job": {"profile": "telecom-tower"}}, tmp_path)


def test_kit_detections_scale_from_the_original_to_the_review_copy(tmp_path):
    job = kit_job(tmp_path)
    src = tmp_path / "dets.json"
    src.write_text(json.dumps([
        {"image": "DJI_0001.JPG", "class": "corrosion", "bbox": [400, 300, 800, 600], "note": "Rust"},
        {"image": "p001", "class": "corrosion", "bbox": [0.1, 0.1, 0.2, 0.2], "normalized": True},
        {"image": "DJI_0002", "class": "corrosion", "bbox": [10, 10, 50, 50], "space": "preview", "severity": 3},
        {"image": "nope.jpg", "class": "corrosion", "bbox": [0, 0, 1, 1]},
    ]))  # fmt: skip
    D.convert(job, str(src), log=lambda m: None)
    doc = json.loads((tmp_path / "assessment.json").read_text())
    f = doc["findings"]
    assert [x["id"] for x in f] == ["p001-1", "p001-2", "p002-1"]
    assert f[0]["bbox"] == [100.0, 75.0, 200.0, 150.0]  # 4000 x 3000 original -> 1000 x 750 copy
    assert f[1]["bbox"] == [100.0, 75.0, 200.0, 150.0]
    assert f[2]["bbox"] == [10, 10, 50, 50] and f[2]["severity"] == 3
    assert f[0]["severity"] == 2  # telecom-tower corrosion class default
    assert doc["photos"]["p001"] == {"status": "finding", "note": "Rust"}
    assert doc["method"] == "detections imported (kit)"


def test_coco_and_yolo_inputs(tmp_path):
    coco = {"images": [{"id": 1, "file_name": "DJI_0001.JPG", "width": 4000, "height": 3000}],
            "categories": [{"id": 5, "name": "Rust"}],
            "annotations": [{"image_id": 1, "category_id": 5, "bbox": [400, 300, 400, 300], "score": 0.7,
                             "attributes": {"severity": 1, "note": "n"}}]}  # fmt: skip
    (tmp_path / "coco.json").write_text(json.dumps(coco))
    d = D.read_detections(str(tmp_path / "coco.json"), "coco", class_map={"Rust": "corrosion"})
    assert d == [{"image": "DJI_0001.JPG", "width": 4000, "height": 3000, "class": "corrosion",
                  "bbox": [400, 300, 800, 600], "severity": 1, "note": "n", "confidence": 0.7}]  # fmt: skip
    y = tmp_path / "yolo"
    y.mkdir()
    (y / "DJI_0001.txt").write_text("1 0.5 0.5 0.2 0.1 0.9\n0 0.1 0.1 0.1\n")
    d = D.read_detections(str(y), "yolo", names=["crack", "corrosion"])
    assert d == [{"image": "DJI_0001", "class": "corrosion", "bbox": pytest.approx([0.4, 0.45, 0.6, 0.55]),
                  "normalized": True, "confidence": 0.9}]  # fmt: skip
