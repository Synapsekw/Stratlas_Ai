"""The pipelines this pack offers. Heavy libraries load inside the steps, so listing is fast."""

from __future__ import annotations

from .aik.pipelines import AikCameras, AikProject, AikRecords
from .change.cloud import ChangeCloud
from .change.frames import ChangeFrames
from .change.mesh import ChangeMesh
from .change.raster import ChangeRaster
from .change.surface import ChangeSurface
from .design.importer import DesignImport
from .drawing.pipeline import DrawingImport
from .geodesy.calibration import GeoCalibration
from .haul.analyse import HaulAnalyse
from .hydro.flood import HydroFlood
from .hydro.flow import HydroFlow
from .hydro.rainfall import HydroRainfall
from .inspection.pipeline import InspectionRun
from .modelfit.fit import ModelFitCloud
from .opf.exporter import OpfExport
from .opf.importer import OpfImport
from .packs.imagery import ImageryPack
from .packs.terrain import TerrainPack
from .photo.align import PhotoAlign
from .photo.georef import PhotoGeoref
from .photo.products import PhotoProducts
from .pointcloud import PointcloudToCopc
from .road.pipeline import RoadBuild
from .runtime import Pipeline
from .selftest import SelfTest
from .survey.cleanup import SurveyCleanup
from .survey.compare import SurveyCompare
from .survey.export import SurveyExport
from .survey.overlay import SurveyOverlay
from .survey.prepare import SurveyPrepare
from .survey.qa import SurveyQa
from .survey.section import SurveySection
from .tiles.cloud import TilesCloud
from .tiles.mesh import TilesMesh
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
        # M10 (pipeline pack 0.4.0); each stream fills its own module
        PhotoAlign(),
        PhotoGeoref(),
        PhotoProducts(),
        OpfImport(),
        OpfExport(),
        TilesMesh(),
        TilesCloud(),
        ImageryPack(),
        TerrainPack(),
        # M11 (pipeline pack 0.5.0); each stream fills its own module
        SurveyPrepare(),
        SurveyCompare(),
        SurveyOverlay(),
        SurveySection(),
        SurveyExport(),
        SurveyQa(),
        SurveyCleanup(),
        DesignImport(),
        GeoCalibration(),
        HydroFlood(),
        HydroFlow(),
        HydroRainfall(),
        HaulAnalyse(),
    ]
    return {p.name: p for p in items}
