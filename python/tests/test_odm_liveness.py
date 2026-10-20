"""The activity meter: a busy but silent ODM stretch stays alive, an idle one reports quiet."""

from __future__ import annotations

import re
from datetime import UTC, datetime
from pathlib import Path

import pytest

from aio_pipelines.photo.odm.liveness import BUSY_EVERY_S, Liveness, iso_at

FIXTURE = Path(__file__).parent / "fixtures" / "odm_log" / "resumed-run.txt"
STAMP = re.compile(r"^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d),(\d{3}) ")


def _stamp(line: str) -> float:
    m = STAMP.match(line)
    assert m
    dt = datetime.strptime(m.group(1), "%Y-%m-%d %H:%M:%S").replace(tzinfo=UTC)
    return dt.timestamp() + int(m.group(2)) / 1000


def _stretch() -> tuple[float, float]:
    """The busy stretch of the fixture: from the 16:46:13,380 line to the 16:52:39,944 one."""
    lines = FIXTURE.read_text(encoding="utf-8").splitlines()
    first = next(x for x in lines if x.startswith("2026-01-01 16:46:13,380"))
    last = next(x for x in lines if x.startswith("2026-01-01 16:52:39,944"))
    return _stamp(first), _stamp(last)


class _Clock:
    def __init__(self, t: float) -> None:
        self.t = t

    def __call__(self) -> float:
        return self.t


def test_a_busy_silent_stretch_stays_alive() -> None:
    start, end = _stretch()
    clock = _Clock(start)
    live = Liveness(Path("w"), clock=clock, cpu=lambda _pid: (clock.t - start) * 0.8, mtime=lambda _p: None)
    live.touch()
    worst = 0.0
    while clock.t <= end:
        live.poll(1)
        worst = max(worst, clock.t - live.last_at)
        clock.t += 1.0
    assert worst <= BUSY_EVERY_S + 1


def test_an_idle_silent_stretch_is_reported_as_quiet() -> None:
    start, end = _stretch()
    clock = _Clock(start)
    live = Liveness(Path("w"), clock=clock, cpu=lambda _pid: 7.0, mtime=lambda _p: 100.0)
    live.touch()
    while clock.t < end:
        live.poll(1)
        clock.t += 1.0
    clock.t = end
    live.poll(1)
    assert clock.t - live.last_at == pytest.approx(386.564, abs=0.01)


def test_a_new_file_in_the_work_folder_counts() -> None:
    clock = _Clock(1000.0)
    mtimes = {"matches": 5.0}

    def mtime(p: Path) -> float | None:
        return mtimes.get(p.name, 1.0)

    live = Liveness(Path("w"), clock=clock, cpu=lambda _pid: 1.0, mtime=mtime)
    for _ in range(60):
        if clock.t == 1040.0:
            mtimes["matches"] = 9.0
        live.poll(1)
        clock.t += 1.0
    assert 1040.0 <= live.last_at <= 1040.0 + BUSY_EVERY_S
    assert live.last_at > 1000.0


def test_a_line_or_count_touches() -> None:
    clock = _Clock(50.0)
    live = Liveness(Path("w"), clock=clock, cpu=lambda _pid: 0.0, mtime=lambda _p: None)
    assert live.last_at == 50.0
    clock.t = 60.0
    live.touch()
    assert live.last_at == 60.0
    live.touch(55.0)
    assert live.last_at == 60.0
    live.touch(70.0)
    assert live.last_at == 70.0


def test_iso_at() -> None:
    assert iso_at(0) == "1970-01-01T00:00:00.000Z"
    assert iso_at(1768581973.38) == "2026-01-16T16:46:13.380Z"
