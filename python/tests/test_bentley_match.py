"""bentley/match.py: photos found by file name under the chosen folder."""

from aio_pipelines.bentley.match import file_name, match_photos, photo_id


def _files(root, *rels):
    for r in rels:
        p = root / r
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(b"\xff\xd8\xff")


def test_case_and_drive_do_not_matter(tmp_path):
    _files(tmp_path, "Mapping/Orbit/cam_0001_v.jpg")
    m = match_photos({"0": "R:/RAW/Job/Mapping/Orbit/CAM_0001_V.JPG"}, tmp_path)
    assert m.found == {"0": tmp_path / "Mapping/Orbit/cam_0001_v.jpg"} and m.missing == []


def test_duplicates_are_told_apart_by_their_folder(tmp_path):
    _files(tmp_path, "flight-a/IMG_1.JPG", "flight-b/IMG_1.JPG")
    m = match_photos({"0": "R:/x/flight-a/IMG_1.JPG", "1": "R:/x/flight-b/IMG_1.JPG"}, tmp_path)
    assert m.found["0"].parent.name == "flight-a" and m.found["1"].parent.name == "flight-b"


def test_a_name_matched_twice_is_ambiguous_and_missing(tmp_path):
    _files(tmp_path, "a/IMG_1.JPG", "b/IMG_1.JPG")
    m = match_photos({"0": "R:/x/c/IMG_1.JPG"}, tmp_path)
    assert m.found == {} and m.missing == ["0"] and m.ambiguous == ["0"]


def test_missing_photos_are_listed_and_backslashes_split(tmp_path):
    _files(tmp_path, "IMG_2.JPG")
    m = match_photos({"0": "R:\\x\\IMG_1.JPG", "1": "R:\\x\\IMG_2.JPG"}, tmp_path)
    assert m.missing == ["0"] and set(m.found) == {"1"} and m.names["0"] == "IMG_1.JPG"
    assert file_name("R:\\a\\b.JPG") == "b.JPG"


def test_one_file_is_never_given_to_two_photos(tmp_path):
    _files(tmp_path, "IMG_1.JPG")
    m = match_photos({"0": "R:/a/IMG_1.JPG", "1": "R:/b/IMG_1.JPG"}, tmp_path)
    assert list(m.found) == ["0"] and m.missing == ["1"]


def test_photo_ids_are_safe_and_unique():
    taken: set[str] = set()
    assert photo_id("CAM_0001_V.JPG", taken) == "CAM_0001_V"
    assert photo_id("CAM_0001_V.jpg", taken) == "CAM_0001_V-2"
    assert photo_id("__.jpg", taken) == "photo"
