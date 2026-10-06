"""The pipelines this pack offers. Heavy libraries load inside the steps, so listing is fast."""

from __future__ import annotations

from .aik.pipelines import AikCameras, AikProject, AikRecords
from .change.cloud import ChangeCloud
from .change.frames import ChangeFrames
from .change.mesh import ChangeMesh
from .change.raster import ChangeRaster
from .change.surface import ChangeSurface
from .drawing.pipeline import DrawingImport
from .inspection.pipeline import InspectionRun
from .modelfit.fit import ModelFitCloud
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
        # M8 (pipeline pack 0.3.0); each stream fills its own module
        ChangeRaster(),
        ChangeSurface(),
        ChangeCloud(),
        ChangeMesh(),
        ChangeFrames(),
        DrawingImport(),
        ModelFitCloud(),
    ]
    return {p.name: p for p in items}
