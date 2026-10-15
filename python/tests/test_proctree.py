"""Child processes (their tree, their memory, ending them) and the tool runner."""

import os
import subprocess
import sys
import threading
import time
from pathlib import Path

import pytest

from aio_pipelines.photo import native, proctree
from aio_pipelines.photo.proctree import (
    START_TOLERANCE_S,
    descendants,
    end_process,
    kill,
    kill_list,
    memory_limit,
    memory_status,
    process_memory,
    process_started,
    process_tree,
    tree_memory,
)
from aio_pipelines.runtime import JobError


class _Ctx:
    """The parts of StepContext run_tool uses."""

    def __init__(self):
        self.cancel_event = threading.Event()
        self.seen: list[tuple[float, str | None]] = []

    def progress(self, f, m=None):
        self.seen.append((f, m))


def test_run_tool_hands_the_exit_code_and_last_lines_to_fail(tmp_path: Path):
    def fail(code: int, lines: list[str]) -> JobError:
        return JobError(f"code {code}: {lines[-1]}")

    script = "import sys; print('one'); print('two'); sys.exit(137)"
    with pytest.raises(JobError, match="code 137: two"):
        native.run_tool(_Ctx(), [sys.executable, "-c", script], "probe", tmp_path, fail=fail)


@pytest.mark.skipif(sys.platform != "win32", reason="a command line string is how Windows starts run.bat")
def test_run_tool_takes_a_command_line_string(tmp_path: Path):
    line = f'"{sys.executable}" -c "print(41 + 1)"'
    assert native.run_tool(_Ctx(), line, "probe", tmp_path).strip() == "42"


def test_the_old_failure_message_stays_without_fail(tmp_path: Path):
    with pytest.raises(JobError, match="probe failed: boom"):
        native.run_tool(
            _Ctx(), [sys.executable, "-c", "import sys; print('boom'); sys.exit(1)"], "probe", tmp_path
        )


def test_the_memory_limit_is_at_most_three_quarters_and_respects_free_memory():
    gb = 10**9
    assert memory_limit(64 * gb, 60 * gb) == 48 * gb
    assert memory_limit(64 * gb, 10 * gb) == 9 * gb
    assert memory_limit(0, 0) == 0
    total, avail = memory_status()
    assert total > 0 and 0 < avail <= total


# Windows never updates a parent PID. When a parent ends and its PID is given to a new process,
# the old children still name that PID, so the new process seems to have children it never
# started. The fabricated trees below are (PID, parent PID) with the time each process started.


def _started(times):
    return lambda pid: times.get(pid)


def test_a_reused_pid_does_not_adopt_the_children_of_the_process_that_had_it():
    # 400 is the engine, with its own child and grandchild. 80 was started long ago by a process
    # that has ended; the engine was given that PID. 84 is 80's child, younger than the engine.
    links = [(4, 0), (80, 400), (84, 80), (300, 4), (400, 300), (404, 400), (408, 404)]
    times = {4: 1.0, 80: 50.0, 84: 2000.0, 300: 900.0, 400: 1000.0, 404: 1000.2, 408: 1003.0}
    assert descendants(400, links, _started(times)) == [400, 404, 408]


def test_a_reused_pid_below_the_root_adopts_nobody_either():
    # the engine's child 404 has the PID of an ended process whose child 90 lives on
    links = [(400, 300), (404, 400), (408, 404), (90, 404), (94, 90)]
    times = {400: 1000.0, 404: 1000.2, 408: 1003.0, 90: 500.0, 94: 1100.0}
    assert descendants(400, links, _started(times)) == [400, 404, 408]


def test_a_loop_of_parent_pids_ends():
    # 400's own parent PID, 500, now belongs to its child; 600 names itself, as the idle process does
    links = [(400, 500), (500, 400), (504, 500), (600, 600)]
    times = {400: 1000.0, 500: 1001.0, 504: 1002.0, 600: 1.0}
    assert descendants(400, links, _started(times)) == [400, 500, 504]
    assert descendants(600, links, _started(times)) == [600]
    # without start times too (other systems re-parent, so every link there is a live one)
    assert descendants(400, links) == [400, 500, 504]
    assert descendants(1, [(1, 3), (2, 1), (3, 2), (2, 1)]) == [1, 2, 3]


def test_a_child_may_start_on_the_same_clock_tick_as_its_parent():
    links = [(404, 400), (408, 400), (412, 400)]
    times = {
        400: 1000.0,
        404: 1000.0,
        408: 1000.0 - START_TOLERANCE_S / 2,
        412: 1000.0 - START_TOLERANCE_S * 2,
    }
    assert descendants(400, links, _started(times)) == [400, 404, 408]


def test_a_process_that_ends_during_the_walk_is_left_out_and_the_rest_is_counted():
    links = [(404, 400), (408, 404), (412, 400), (416, 412)]
    times = {400: 1000.0, 404: None, 408: 1002.0, 412: 1001.0, 416: 1003.0}  # 404 is gone
    assert descendants(400, links, _started(times)) == [400, 412, 416]
    assert descendants(400, links, _started({})) == [400]  # the root itself is gone


def test_the_processes_to_end_leave_out_an_older_process_that_names_the_pid():
    # 400 has a child and a grandchild; 80 is older and names 400 (a reused PID), 84 is below 80
    links = [(80, 400), (84, 80), (400, 300), (404, 400), (408, 404)]
    times = {80: 50.0, 84: 2000.0, 400: 1000.0, 404: 1000.2, 408: 1003.0}
    assert kill_list(400, links, _started(times)) == [(404, 1000.2), (408, 1003.0)]
    assert kill_list(400, links, _started({**times, 400: None})) == []  # the root cannot be read


def test_a_process_started_while_its_parent_was_being_ended_is_found_by_the_next_walk():
    # 400 and 404 were ended. 412 names 404 and started before 404 ended: its child, with 420
    # below it. 416 names 404 too but started after that: a child of the process that has PID
    # 404 now (started by 77), and that process is not listed either.
    ended = {400: (1000.0, 1009.0), 404: (1000.2, 1010.0)}
    links = [(404, 77), (412, 404), (416, 404), (420, 412)]
    times = {404: 1015.0, 412: 1005.0, 416: 1020.0, 420: 1006.0}
    assert kill_list(400, links, _started(times), ended) == [(412, 1005.0), (420, 1006.0)]


WINDOWS_ONLY = pytest.mark.skipif(
    os.name != "nt", reason="only Windows keeps the parent PID of an ended process"
)


def _sleeper(code="import time; time.sleep(60)", **kw):
    return subprocess.Popen(
        [sys.executable, "-c", code],
        stdin=subprocess.DEVNULL,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        **kw,
    )


def _child_with_grandchild():
    """A process of this test with a child of its own; gives the Popen and the grandchild's PID."""
    code = (
        "import subprocess, sys, time\n"
        "p = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'])\n"
        "print(p.pid, flush=True)\n"
        "time.sleep(60)\n"
    )
    child = _sleeper(code, stdout=subprocess.PIPE, text=True)
    return child, int(child.stdout.readline())


def _running(listed):
    """Which of these (PID, start) are still the running processes they were."""
    now = {p for p, _ in proctree.process_links()}
    return [p for p, t in listed if p in now and process_started(p) == t]


def _gone(listed, seconds=5.0):
    t0 = time.monotonic()
    while _running(listed) and time.monotonic() - t0 < seconds:
        time.sleep(0.1)
    return not _running(listed)


@WINDOWS_ONLY
def test_the_tree_of_a_real_process_has_its_descendants_and_no_older_process(reused_pid):
    """A reused PID with real processes: the stranger, older than the child this test starts,
    names the child's PID as its parent. The child's own child must still be counted."""
    child, grandchild = _child_with_grandchild()
    try:
        assert process_started(reused_pid.pid) < process_started(child.pid) <= process_started(grandchild)
        assert process_started(0x7FFFFFFC) is None  # no such process
        assert (reused_pid.pid, child.pid) in proctree.process_links()
        tree = process_tree(child.pid)
        assert tree[0] == child.pid and grandchild in tree
        assert reused_pid.pid not in tree
        assert process_memory(grandchild) > 0 and proctree.process_memory(reused_pid.pid) == 10**12
        assert tree_memory(child.pid) < 10**12
    finally:
        kill(child)
        child.stdout.close()


@WINDOWS_ONLY
def test_kill_ends_the_child_and_everything_below_it():
    child, grandchild = _child_with_grandchild()
    try:
        tree = [(p, process_started(p)) for p in process_tree(child.pid)]
        assert grandchild in [p for p, _ in tree] and _running(tree) == [p for p, _ in tree]
        kill(child)
        assert child.poll() is not None
        assert _gone(tree[1:])
    finally:
        kill(child)
        child.stdout.close()


@WINDOWS_ONLY
def test_kill_leaves_an_older_process_that_names_the_childs_pid_alone(reused_pid):
    """Only processes this test or its fixture started are ever in reach of the kill."""
    child, grandchild = _child_with_grandchild()
    try:
        assert (reused_pid.pid, child.pid) in proctree.process_links()
        others = [(p, process_started(p)) for p in process_tree(reused_pid.pid)]
        tree = [(p, process_started(p)) for p in process_tree(child.pid)]
        assert grandchild in [p for p, _ in tree] and not {p for p, _ in others} & {p for p, _ in tree}
        kill(child)
        assert child.poll() is not None and _gone(tree[1:])
        assert reused_pid.poll() is None
        assert _running(others) == [p for p, _ in others]
    finally:
        kill(child)
        child.stdout.close()


@WINDOWS_ONLY
def test_a_pid_given_to_another_process_since_the_walk_is_not_ended():
    # the real interpreter, not the environment's launcher: one process, nothing below it
    child = subprocess.Popen(
        [getattr(sys, "_base_executable", sys.executable), "-c", "import time; time.sleep(60)"],
        stdin=subprocess.DEVNULL,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    try:
        t = process_started(child.pid)
        # listed with another start: the PID was given out again, and its new owner is left alone
        assert end_process(child.pid, t - 30.0) == "gone"
        time.sleep(0.3)
        assert child.poll() is None
        assert end_process(child.pid, t) == "ended"
        assert child.wait(timeout=5) is not None
        assert end_process(0x7FFFFFFC, t) == "gone"  # no such process
    finally:
        child.kill()
        child.wait()


def test_the_cpu_time_of_a_tree_counts_a_busy_child_and_keeps_what_ended():
    from aio_pipelines.photo.proctree import TreeCpu, process_cpu_seconds, tree_programs

    busy = "import time\nend = time.monotonic() + 1.5\nwhile time.monotonic() < end:\n    pass\n"
    child = subprocess.Popen(
        [sys.executable, "-c", busy], creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0)
    )
    try:
        cpu = TreeCpu()
        assert cpu.sample(child.pid) == 0.0  # the first sample is the baseline
        names = [Path(name).stem.lower() for _, name in tree_programs(child.pid)]
        assert names[0] == Path(sys.executable).stem.lower()  # the tool first (Windows may add conhost)
        time.sleep(1.0)
        assert cpu.sample(child.pid) > 0.3
        child.wait(timeout=10)
        assert cpu.sample(child.pid) > 0.3  # an ended process keeps the time it used
        assert process_cpu_seconds(0x7FFFFFFC) is None
    finally:
        kill(child)
