"""captures.py: a survey date found or added as the app's captureForDate does."""

import pytest

from aio_pipelines.captures import capture_for_date


def test_an_existing_date_is_found_and_a_new_one_added_in_date_order():
    m = {"captures": [{"id": "capture-2026-03-09", "label": "Survey", "date": "2026-03-09"}]}
    assert capture_for_date(m, "2026-03-09") == "capture-2026-03-09"
    assert capture_for_date(m, "2026-03-04") == "capture-2026-03-04"
    assert [c["date"] for c in m["captures"]] == ["2026-03-04", "2026-03-09"]
    assert m["captures"][0] == {"id": "capture-2026-03-04", "label": "Survey", "date": "2026-03-04"}


def test_a_taken_id_gets_a_suffix_and_a_bad_date_is_refused():
    m = {"captures": [{"id": "capture-2026-03-04", "label": "Old", "date": "2026-01-01"}]}
    assert capture_for_date(m, "2026-03-04") == "capture-2026-03-04-2"
    with pytest.raises(ValueError):
        capture_for_date({}, "4 March")
