"""A synthetic three-sector telecom site for the ``rf.coverage`` tests. No real site data.

The tower stands at a made-up point in UTM zone 40N; three accepted panels face 0, 120 and 240
degrees grid, 40 m above the tower-base ground, with one LTE 1800 MHz carrier each.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

SITE_E = 500_000.0
SITE_N = 2_700_000.0
GROUND_Z = 12.0
HEIGHT_M = 40.0
CONVERGENCE = 0.8
AZIMUTHS = (0.0, 120.0, 240.0)
DOWNTILT = 2.0
ETILT = 4.0
POWER_DBM = 43.0
FEEDER_DB = 0.5

ANTENNA = {
    "kind": "antenna",
    "id": "generic-panel-65-17",
    "vendor": "Generic",
    "model": "Panel 65 deg 17 dBi",
    "source": "generic assumption, not a vendor product",
    "verified": False,
    "ports": [
        {
            "id": "p1",
            "bandRangeMhz": [698, 2690],
            "gainDbi": 17,
            "hBeamwidthDeg": 65,
            "vBeamwidthDeg": 10,
            "frontToBackDb": 28,
            "etilt": {"minDeg": 0, "maxDeg": 10, "stepDeg": 1},
            "patterns": [],
        }
    ],
}
RADIO = {
    "kind": "radio",
    "id": "generic-rru-2x40w",
    "vendor": "Generic",
    "model": "RRU 2T2R 40 W",
    "source": "generic assumption, not a vendor product",
    "verified": False,
    "bandRangeMhz": [1710, 1880],
    "txPorts": 2,
    "rxPorts": 2,
    "maxPowerDbmPerPort": 46,
    "maxBandwidthMhz": 75,
    "mounting": "tower",
}

STUDY = {
    "model": "tr38901",
    "environment": "uma",
    "ueHeightM": 1.5,
    "marginPreset": "outdoor",
    "bodyLossDb": 3,
    "edgeProbability": 0.9,
    "shadowSigmaDb": 8,
    "thresholds": {"excellentDbm": -80, "goodDbm": -95, "fairDbm": -105, "poorDbm": -115},
    "gridResolutionM": 25,
    "radiusM": 1500,
}


def unit(k: int, az: float, status: str = "accepted", kind: str = "panel", **over: Any) -> dict[str, Any]:
    u: dict[str, Any] = {
        "id": f"ant-s{k + 1}",
        "name": f"A{k + 1}",
        "kind": kind,
        "kindBasis": "geometry",
        "status": status,
        "box": {
            "centre": [
                SITE_E + [0.0, 0.9, -0.9][k % 3],
                SITE_N + [0.6, -0.4, -0.4][k % 3],
                GROUND_Z + HEIGHT_M,
            ],
            "axes": [[1, 0, 0], [0, 0, 1], [0, 1, 0]],
            "extents": [0.4, 1.8, 0.2],
        },
        "support": 400,
        "azimuthGridDeg": {"value": az, "basis": "measured", "quality": {"basis": "measured"}},
        "downtiltDeg": {"value": DOWNTILT, "basis": "measured", "quality": {"basis": "measured"}},
        "convergenceDeg": CONVERGENCE,
        "photos": [],
        "user": {},
        "runId": "run-synth",
        "createdAt": "2026-10-17T08:00:00Z",
    }
    u.update(over)
    return u


def settings(antenna_id: str, **over: Any) -> dict[str, Any]:
    s: dict[str, Any] = {
        "antennaId": antenna_id,
        "equipment": {"kind": "separate", "antenna": ANTENNA["id"], "radio": RADIO["id"]},
        "etiltDeg": ETILT,
        "active": True,
        "carriers": [
            {
                "id": "l1800",
                "radioUnit": RADIO["id"],
                "port": "p1",
                "tech": "lte",
                "band": "B3",
                "bandwidthMhz": 20,
                "powerDbmPerPort": POWER_DBM,
                "feederLossDb": FEEDER_DB,
            }
        ],
    }
    s.update(over)
    return s


def write_site(
    root: Path,
    units: list[dict[str, Any]] | None = None,
    study: dict[str, Any] | None = None,
    antennas: list[dict[str, Any]] | None = None,
    sectors: list[dict[str, Any]] | None = None,
    crs: dict[str, Any] | None = None,
    ground_z: float | None = GROUND_Z,
    catalogue: list[dict[str, Any]] | None = None,
    antennas_version: int = 1,
) -> Path:
    units = units if units is not None else [unit(k, az) for k, az in enumerate(AZIMUTHS)]
    (root / "telecom").mkdir(parents=True, exist_ok=True)
    (root / "rf").mkdir(parents=True, exist_ok=True)
    manifest = {
        "schema": "aio.project/1",
        "id": "synthetic-rf",
        "name": "Synthetic RF site",
        "crs": crs if crs is not None else {"epsg": 32640},
        "origin": [SITE_E, SITE_N, 0.0],
        "captures": [],
        "layers": [],
        "severityModels": [],
        "classCatalogues": [],
    }
    (root / "manifest.json").write_text(json.dumps(manifest), "utf-8")
    run: dict[str, Any] = {"id": "run-synth", "north": "grid", "warnings": []}
    if ground_z is not None:
        run["groundZ"] = ground_z
    # the antenna-detection file id is built in two parts (schema registry scan)
    (root / "telecom" / "antennas.json").write_text(
        json.dumps({"schema": f"aio.antennas/{antennas_version}", "run": run, "units": units}), "utf-8"
    )
    ids = [u["id"] for u in units]
    sectors_file = {
        "schema": "aio.rf-sectors/1",
        "sectors": sectors
        if sectors is not None
        else [{"id": f"sec-s{k + 1}", "name": f"S{k + 1}", "antennaIds": [i]} for k, i in enumerate(ids)],
        "antennas": antennas if antennas is not None else [settings(i) for i in ids],
        "study": {**STUDY, **(study or {})},
    }
    (root / "rf" / "sectors.json").write_text(json.dumps(sectors_file), "utf-8")
    (root / "rf" / "catalogue.json").write_text(
        json.dumps(
            {
                "schema": "aio.rf-catalogue/1",
                "entries": catalogue if catalogue is not None else [ANTENNA, RADIO],
            }
        ),
        "utf-8",
    )
    return root
