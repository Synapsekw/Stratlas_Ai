"""Task functions for test_photo_pool: a worker process imports them by name."""

import os
import time

from aio_pipelines.runtime import JobError

STATE: dict = {}


def init(offset: int) -> None:
    STATE["offset"] = offset


def add(x: int) -> int:
    return x + STATE["offset"]


def slow(x: int) -> int:
    time.sleep(30)
    return x


def refuse(x: int) -> int:
    raise JobError(f"The photo {x} could not be read: broken")


def die(x: int) -> int:
    if x == 2:
        os._exit(3)
    time.sleep(0.2)
    return x
