import { registerAppHooks, registerFrameSource } from '@aio/ai';
import { setFlightPoses } from '@aio/annotate';
import { configureEngine, getActiveStage, registerEngineAdapters } from '@aio/engine';
import { captureMap, registerMapAdapters } from '@aio/maps';
import { pointcloudSettings, registerPointcloudAdapters } from '@aio/pointcloud';
import { t } from '@aio/ui';
import { loadFlight, registerVideoAdapters, videoRig } from '@aio/video';
import { volumetric } from '@aio/volumetric';
import { assetUrl, workspace, type OpenProject } from '@aio/workspace';
import { graphics } from './graphics';
import { shell } from './shell';

let started = false;

/**
 * Hand every clip's flight poses to the annotation runtime (cross-view back-projection) as soon as
 * a project opens. Clips of one flight share a pose file; `loadFlight` fetches each file once and
 * the 3D video rig reuses the same promise.
 */
function shareFlightPoses(project: OpenProject | null) {
  if (!project) return;
  for (const layer of project.manifest.layers) {
    if (layer.kind !== 'video') continue;
    let url: string;
    try {
      url = assetUrl(project.id, layer.flight.src);
    } catch {
      continue;
    }
    loadFlight(url).then(
      (flight) => {
        if (workspace.getState().project?.id === project.id)
          setFlightPoses(layer.id, flight.samples);
      },
      (e: unknown) => {
        console.warn(`Flight poses for "${layer.name}" could not be loaded`, e);
      },
    );
  }
}

/**
 * App composition, once at startup: engine configuration and every stream's layer adapters, so
 * SceneView creates meshes, rasters, point clouds, video rigs and the basemap ground.
 */
export function bootstrap(): void {
  if (started) return;
  started = true;
  configureEngine({
    resolveUrl: assetUrl,
    devTools: import.meta.env.DEV,
    // marker tooltips and lists speak the app's language
    text: (key, vars) => t(key, vars),
  });
  // GPU tier: pixel ratio, shadows, point budget and EDL before the first stage exists
  graphics().getState().apply();
  registerEngineAdapters();
  registerPointcloudAdapters();
  registerVideoAdapters();
  registerMapAdapters();
  // Agent seams: the map's frame for capture_frame, and screens the agent's tools can open.
  registerFrameSource('map', () => captureMap());
  registerAppHooks({
    openReview: () => {
      shell.getState().go('review');
    },
  });
  // Inspection hook for the end-to-end tests and DevTools (read the clock, the live scene).
  Object.assign(window, {
    __stratlas: {
      workspace,
      stage: getActiveStage,
      volumetric,
      graphics,
      pointcloud: pointcloudSettings,
      /** The video rig of the live stage (calibration tests: logged pose, model view). */
      videoRig: () => {
        const stage = getActiveStage();
        return stage ? videoRig(stage) : null;
      },
    },
  });
  shareFlightPoses(workspace.getState().project);
  workspace.subscribe((s, prev) => {
    if (s.project !== prev.project) shareFlightPoses(s.project);
  });
}
