import { registerAppHooks, registerFrameSource, ToolError } from '@aio/ai';
import { registerIssueHistory, setFlightPoses } from '@aio/annotate';
import {
  configureEngine,
  getActiveStage,
  meshTemplates,
  registerEngineAdapters,
} from '@aio/engine';
import { captureMap, registerMapAdapters } from '@aio/maps';
import { pointcloudSettings, registerPointcloudAdapters } from '@aio/pointcloud';
import { t } from '@aio/ui';
import { loadFlight, registerVideoAdapters, videoRig } from '@aio/video';
import { volumetric } from '@aio/volumetric';
import { assetUrl, workspace, type OpenProject } from '@aio/workspace';
import { registerAgentPlaces } from './agentPlaces';
import { IssueHistoryPanel } from './audit/HistoryPanel';
import { graphics } from './graphics';
import { graphicsReport, memoryWatch } from './memoryWatch';
import { requestGlobe } from './globe/request';
import { bridge, shell } from './shell';
import { COMPARE_GPU_BYTES, compareRuntime } from './workspace/compare';

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
    // a lost WebGL context steps the graphics tier down for the session (memoryWatch.ts)
    onGpuEvent: (e) => {
      memoryWatch().onGpuEvent(e);
    },
  });
  // GPU tier: pixel ratio, shadows, point budget and EDL before the first stage exists
  graphics().getState().apply();
  memoryWatch();
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
    // M10 Globe: list_sites and show_on_globe
    listSites: async () => {
      const r = await bridge.call('globe:sites', {});
      if (!r.ok) throw new ToolError(r.error);
      if (!r.value.ok) throw new ToolError(r.value.error);
      return r.value.sites;
    },
    showOnGlobe: (projectId) => {
      requestGlobe(projectId);
      shell.getState().go('globe');
    },
  });
  // Stockpiles and road chainages for find_places and fly_to.
  registerAgentPlaces();
  // The issue detail's History reads the project journal (M9).
  registerIssueHistory(IssueHistoryPanel);
  // Inspection hook for the end-to-end tests and DevTools (read the clock, the live scene).
  Object.assign(window, {
    __stratlas: {
      workspace,
      stage: getActiveStage,
      volumetric,
      graphics,
      /** Tier, detection facts and memory now (diagnostics, the performance tests). */
      memory: graphicsReport,
      pointcloud: pointcloudSettings,
      /** The video rig of the live stage (calibration tests: logged pose, model view). */
      videoRig: () => {
        const stage = getActiveStage();
        return stage ? videoRig(stage) : null;
      },
      /** Comparing dates: the second 3D view, the camera link, the maps, the shared models. */
      compare: () => ({
        ...compareRuntime,
        models: meshTemplates.stats(),
        gpuLimit: COMPARE_GPU_BYTES[graphics().getState().tier],
      }),
    },
  });
  shareFlightPoses(workspace.getState().project);
  workspace.subscribe((s, prev) => {
    if (s.project !== prev.project) shareFlightPoses(s.project);
  });
}
