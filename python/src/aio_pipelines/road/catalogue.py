"""Road distress classes, the ASTM D6433 distress each counts as, and the severity model.

The ten delivered classes, their ids, labels and colours, and the severity model match the 1st
Ring Road importer (``packages/project/src/import/ringroad-model.ts``: ``ROAD_CATALOGUE``,
``ROAD_SEVERITY_MODEL``), so a built road and the imported one read the same in the app. The
distress key and quantity kind per class are the delivered builder's ``TYPES`` table
(``grid_pci.py``): area classes count square feet, length classes feet, potholes a count.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

SEVERITY_MODEL_ID = "road-astm-d6433"
CATALOGUE_ID = "road-distress"


@dataclass(frozen=True)
class DistressClass:
    id: str
    label: str
    color: str
    #: Key of the deduct curve in pci_curves.json, or None when it does not count towards PCI.
    distress: str | None
    #: How the quantity is measured: "area" (ft2), "length" (ft) or "count".
    kind: str
    #: Names the delivered data (shapefile ``DefectName``) uses for it.
    names: tuple[str, ...] = ()


# The delivered ten, in the importer's order.
CLASSES: tuple[DistressClass, ...] = (
    DistressClass(
        "longitudinal-cracking",
        "Longitudinal cracking",
        "#3fa9f5",
        "longitudinal_transverse_cracking",
        "length",
        ("Longitudinal Cracking",),
    ),
    DistressClass(
        "transverse-cracking",
        "Transverse cracking",
        "#b68ef8",
        "longitudinal_transverse_cracking",
        "length",
        ("Transverse Cracking",),
    ),
    DistressClass("bleeding", "Bleeding", "#ff7a2d", "bleeding", "area", ("Bleeding",)),
    DistressClass("raveling", "Raveling", "#2ec4b6", "raveling", "area", ("Raveling", "Ravelling")),
    DistressClass(
        "block-cracking", "Block cracking", "#fad34b", "block_cracking", "area", ("Block Cracking",)
    ),
    DistressClass(
        "alligator-cracking",
        "Alligator cracking",
        "#ee3f4b",
        "alligator_cracking",
        "area",
        ("Alligator Cracker", "Alligator Cracking", "Fatigue Cracking"),
    ),
    DistressClass(
        "patching",
        "Patching",
        "#9be15d",
        "patching_and_utility_cut_patching",
        "area",
        ("Patching", "Utility Cut Patching"),
    ),
    DistressClass("potholes", "Potholes", "#ff4fa3", "potholes", "count", ("Potholes", "Pothole")),
    DistressClass("rutting", "Rutting", "#ffffff", "rutting", "area", ("Rutting",)),
    DistressClass("edge-cracking", "Edge cracking", "#c9a36b", "edge_cracking", "length", ("Edge Cracking",)),
)

# Other ASTM D6433 asphalt distresses, added to a project's catalogue when the data has them.
EXTRA: tuple[DistressClass, ...] = (
    DistressClass("bumps-and-sags", "Bumps and sags", "#a0c4ff", "bumps_and_sags", "length"),
    DistressClass("corrugation", "Corrugation", "#bdb2ff", "corrugation", "area"),
    DistressClass("depression", "Depression", "#7aa6c2", "depression", "area"),
    DistressClass(
        "joint-reflection-cracking",
        "Joint reflection cracking",
        "#c39bd3",
        "joint_reflection_cracking",
        "length",
    ),
    DistressClass(
        "lane-shoulder-drop-off", "Lane or shoulder drop-off", "#d4a373", "lane_shoulder_drop_off", "length"
    ),
    DistressClass("polished-aggregate", "Polished aggregate", "#cdb4db", "polished_aggregate", "area"),
    DistressClass("railroad-crossing", "Railroad crossing", "#8d99ae", "railroad_crossing", "area"),
    DistressClass("shoving", "Shoving", "#f4a261", "shoving", "area"),
    DistressClass("slippage-cracking", "Slippage cracking", "#e76f51", "slippage_cracking", "area"),
    DistressClass("swell", "Swell", "#90be6d", "swell", "area"),
    DistressClass("weathering", "Weathering", "#adb5bd", "weathering", "area"),
)

ALL = CLASSES + EXTRA


def _key(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", "", s.lower())


_LOOKUP: dict[str, DistressClass] = {}
for _c in ALL:
    for _n in (_c.id, _c.label, *(_c.names), *((_c.distress,) if _c.distress else ())):
        _LOOKUP.setdefault(_key(_n), _c)


def slug(s: str, fallback: str = "other") -> str:
    v = re.sub(r"[^a-z0-9]+", "-", s.strip().lower()).strip("-")
    return v or fallback


def class_of(name: str) -> DistressClass:
    """The class of a defect type name (delivered name, class id, label or ASTM key, any case).

    An unknown name becomes its own class that does not count towards PCI.
    """
    c = _LOOKUP.get(_key(name))
    if c:
        return c
    label = name.strip() or "Other"
    return DistressClass(slug(label), label[0].upper() + label[1:], "#95a0ab", None, "area")


STAGE_LABEL = {1: "Few", 2: "Intermediate", 3: "Extensive"}
_STAGES = {"few": 1, "low": 1, "intermediate": 2, "medium": 2, "extensive": 3, "high": 3}


def stage_of(value: object) -> int | None:
    """Delivered stage (Few, Intermediate, Extensive), a severity word or 1 to 3; None if absent."""
    if value is None:
        return None
    if isinstance(value, bool):
        return None
    if isinstance(value, int | float) and int(value) == value and 1 <= value <= 3:
        return int(value)
    if isinstance(value, str):
        s = value.strip().lower()
        if s in _STAGES:
            return _STAGES[s]
        if s in ("1", "2", "3"):
            return int(s)
    return None


SEVERITY_MODEL = {
    "id": SEVERITY_MODEL_ID,
    "name": "Road distress (ASTM D6433)",
    "levels": [
        {
            "value": 1,
            "label": "Low",
            "color": "#fad34b",
            "criteria": "Delivered stage Few. Low severity per ASTM D6433 (screening grade from the ortho, crack width and depth not measured).",
            "action": "Monitor",
        },
        {
            "value": 2,
            "label": "Medium",
            "color": "#ff7a2d",
            "criteria": "Delivered stage Intermediate. Medium severity per ASTM D6433 (screening grade from the ortho).",
            "action": "Plan maintenance",
        },
        {
            "value": 3,
            "label": "High",
            "color": "#ee3f4b",
            "criteria": "Delivered stage Extensive. High severity per ASTM D6433 (screening grade from the ortho).",
            "action": "Plan repair",
        },
    ],
}


def catalogue_entry(c: DistressClass) -> dict[str, str]:
    return {"id": c.id, "label": c.label, "color": c.color, "severityModel": SEVERITY_MODEL_ID}


def catalogue(extra: list[DistressClass] | None = None) -> dict[str, object]:
    classes = [catalogue_entry(c) for c in CLASSES]
    known = {c["id"] for c in classes}
    for c in extra or []:
        if c.id not in known:
            classes.append(catalogue_entry(c))
            known.add(c.id)
    return {
        "id": CATALOGUE_ID,
        "name": "Asphalt road distress",
        "assetType": "road",
        "classes": classes,
    }
