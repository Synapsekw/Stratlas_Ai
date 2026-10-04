"""The pipelines this pack offers. Heavy libraries load inside the steps, so listing is fast."""

from __future__ import annotations

from .aik.pipelines import AikCameras, AikProject, AikRecords
from .inspection.pipeline import InspectionRun
from .pointcloud import PointcloudToCopc
from .road.pipeline import RoadBuild
from .runtime import Pipeline
from .selftest import SelfTest
from .volumetric.build import VolumetricBuild
from .volumetric.pipeline import VolumetricProcess


def all_pipelines() -> dict[str, Pipeline]:
    items: list[Pipeline] = [
        AikCameras(),
        AikProject(),
        AikRecords(),
        InspectionRun(),
        VolumetricProcess(),
        VolumetricBuild(),
        PointcloudToCopc(),
        RoadBuild(),
        SelfTest(),
    ]
    return {p.name: p for p in items}
