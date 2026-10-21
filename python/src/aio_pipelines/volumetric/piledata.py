"""Per pile and date working arrays between the ``process`` and ``package`` steps.

They live in the job's staging folder, which is part of the project and so untrusted on resume:
the file is an ``.npz`` read with ``allow_pickle=False`` (never a pickle, which runs code).
"""

from __future__ import annotations

import io
import json
from pathlib import Path
from typing import Any

import numpy as np

from ..runtime import atomic_write_bytes

ARRAYS = ("z", "m", "toe", "tg")
BASES = ("low", "avg", "plane", "tin")


def save_piledata(path: Path, pd: dict[tuple[str, str], dict[str, Any]]) -> None:
    index = []
    arrays: dict[str, np.ndarray] = {}
    for n, ((pid, e), d) in enumerate(pd.items()):
        index.append(
            {
                "pile": pid,
                "epoch": e,
                "bbox5": [int(v) for v in d["bbox5"]],
                "groundToeFrac": float(d["ground_toe_frac"]),
            }
        )
        for k in ARRAYS:
            arrays[f"{n}_{k}"] = np.asarray(d[k])
        for k in BASES:
            arrays[f"{n}_base_{k}"] = np.asarray(d["bases"][k])
    arrays["index"] = np.frombuffer(json.dumps(index).encode("utf-8"), dtype=np.uint8)
    buf = io.BytesIO()
    np.savez(buf, **arrays)
    atomic_write_bytes(path, buf.getvalue())


def load_piledata(path: Path) -> dict[tuple[str, str], dict[str, Any]]:
    out: dict[tuple[str, str], dict[str, Any]] = {}
    with np.load(path, allow_pickle=False) as z:
        index = json.loads(z["index"].tobytes().decode("utf-8"))
        for n, ent in enumerate(index):
            y0, y1, x0, x1 = (int(v) for v in ent["bbox5"])
            d: dict[str, Any] = {k: z[f"{n}_{k}"] for k in ARRAYS}
            d["bbox5"] = (y0, y1, x0, x1)
            d["bases"] = {k: z[f"{n}_base_{k}"] for k in BASES}
            d["ground_toe_frac"] = float(ent["groundToeFrac"])
            out[(str(ent["pile"]), str(ent["epoch"]))] = d
    return out
