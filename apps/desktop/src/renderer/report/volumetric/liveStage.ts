/**
 * The live 3D stage of the open project as a `CaptureStage` (captureViews.ts), and
 * `takeReportPictures`, the one call the editor makes: it opens the Scene in 3D when needed,
 * takes the pictures, saves them with `report:saveViews` and leaves the person where they were.
 */
import { getActiveStage, type EngineStage, type LabelMode, type SavedView } from '@aio/engine';
import type { Layer, ReportTypeId } from '@aio/schema';
import { volumetric, type SurfaceMode } from '@aio/volumetric';
import { workspace, type Selection } from '@aio/workspace';
import { Vector2, Vector3, type OrthographicCamera, type PerspectiveCamera } from 'three';
import { bridge, shell } from '../../shell';
import { compareStore, engineClient, setHeat } from '../../survey/compareStore';
import { measureStore } from '../../survey/measureStore';
import { cutFillPrefs, wholeSiteHeat } from '../../survey/volumes/cutFill';
import { legendRangeM, siteCutFillQuestion } from '../../workspace/stageCutFill';
import { rasterSwap, stageShow } from '../../workspace/StageShow';
import { timeline } from '../../workspace/timeline';
import {
  captureViews,
  type CaptureOptions,
  type CaptureRequest,
  type CaptureResult,
  type CaptureStage,
  type PictureSurface,
} from './captureViews';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const frame = () =>
  new Promise<void>((r) => {
    requestAnimationFrame(() => {
      r();
    });
  });

/** Rendered at up to twice the picture size and drawn down, for clean outlines. */
const SUPERSAMPLE = 2;
/** Quiet time after the layers report loaded, for the last tiles to come in. */
const QUIET_MS = 1200;

interface Saved {
  screen: ReturnType<typeof shell.getState>['screen'];
  stageMode: ReturnType<typeof shell.getState>['stageMode'];
  view: SavedView;
  labelMode: LabelMode;
  focus: string | null;
  hidden: Record<string, true>;
  selection: Selection | null;
  measure: { selected: string[]; focus: string | null };
  show: { surface: SurfaceMode; outlines: boolean; labels: boolean };
  heat: ReturnType<typeof compareStore.getState>['heat'];
  siteHeat: ReturnType<typeof compareStore.getState>['siteHeat'];
  kit: { surface: SurfaceMode; swipe: boolean } | null;
}

const kitLoaded = () => {
  const s = volumetric.getState().status;
  return s !== 'none' && s !== 'idle';
};

const isRaster = (l: Layer, role: 'ortho' | 'dsm') => l.kind === 'raster' && l.role === role;
const DRAWN: ReadonlySet<Layer['kind']> = new Set(['raster', 'mesh', 'pointcloud', 'basemap']);

/** The live stage, opening the Scene with a 3D view first when needed. */
async function stageNow(): Promise<EngineStage | null> {
  let stage = getActiveStage();
  if (stage) return stage;
  const s = shell.getState();
  if (s.screen !== 'scene') s.go('scene');
  if (s.stageMode === 'map') s.setStageMode('3d');
  for (let i = 0; i < 100 && !stage; i++) {
    await sleep(100);
    stage = getActiveStage();
  }
  if (stage) await sleep(1500);
  return stage;
}

/** Render `camera`'s view of the stage into a `w` x `h` canvas, in one task. */
function renderInto(
  stage: EngineStage,
  camera: PerspectiveCamera | OrthographicCamera,
  w: number,
  h: number,
): HTMLCanvasElement {
  const r = stage.renderer;
  const gl = r.getContext();
  const dims = gl.getParameter(gl.MAX_VIEWPORT_DIMS) as Int32Array | null;
  const maxDim = Math.min(r.capabilities.maxTextureSize, dims?.[0] ?? 4096, dims?.[1] ?? 4096);
  const k = Math.max(1, Math.min(SUPERSAMPLE, maxDim / Math.max(w, h)));
  const size = r.getSize(new Vector2());
  const ratio = r.getPixelRatio();
  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  const g = out.getContext('2d');
  if (!g) throw new Error('No 2D canvas for the picture.');
  try {
    r.setPixelRatio(1);
    r.setSize(Math.round(w * k), Math.round(h * k), false);
    // render and read in the same task, so the drawing buffer still holds the frame
    r.render(stage.scene, camera);
    g.imageSmoothingQuality = 'high';
    g.drawImage(r.domElement, 0, 0, w, h);
  } finally {
    r.setPixelRatio(ratio);
    r.setSize(size.x, size.y, false);
    stage.requestRender();
  }
  return out;
}

async function jpeg(c: HTMLCanvasElement, quality: number): Promise<Uint8Array<ArrayBuffer>> {
  const blob = await new Promise<Blob | null>((r) => {
    c.toBlob(r, 'image/jpeg', quality);
  });
  if (!blob) throw new Error('The picture could not be encoded.');
  return new Uint8Array(await blob.arrayBuffer());
}

/** The open project's live stage as a capture stage; null without a project or a 3D view. */
export async function liveStage(): Promise<CaptureStage | null> {
  const project = workspace.getState().project;
  if (!project) return null;
  const before = { screen: shell.getState().screen, stageMode: shell.getState().stageMode };
  const stage = await stageNow();
  if (!stage) return null;
  const origin = project.manifest.origin;

  const layers = () => workspace.getState().project?.manifest.layers ?? [];
  const dateOf = (id: string) => timeline.getState().index?.of[id] ?? '';

  const swapRasters = (to: 'photo' | 'elev') => {
    const ws = workspace.getState();
    const { show, hide } = rasterSwap(layers(), timeline.getState().index?.of ?? {}, ws.hidden, to);
    if (show.length > 0 || hide.length > 0) ws.applyVisibility(show, hide);
  };
  const heatOn = (on: boolean) => {
    const heat = compareStore.getState().heat;
    if (heat.show3d !== on || heat.show2d !== on) setHeat({ show3d: on, show2d: on });
  };

  // the deadband the last whole-site heat map was asked with (null: none drawn by the capture)
  let heatThresholdM: number | null = null;

  return {
    origin,
    get view() {
      return { fovDeg: stage.camera.fov, aspect: stage.camera.aspect || 1.6 };
    },
    save(): Saved {
      const ms = measureStore.getState();
      const ss = stageShow.getState();
      const cs = compareStore.getState();
      const vs = volumetric.getState();
      return {
        ...before,
        view: stage.saveView(),
        labelMode: stage.labelMode,
        focus: timeline.getState().focus,
        hidden: { ...workspace.getState().hidden },
        selection: workspace.getState().selection,
        measure: { selected: [...ms.selected], focus: ms.focus },
        show: { surface: ss.surface, outlines: ss.outlines, labels: ss.labels },
        heat: { ...cs.heat },
        siteHeat: cs.siteHeat,
        kit: kitLoaded() ? { surface: vs.surface, swipe: vs.swipe } : null,
      };
    },
    async restore(token) {
      const t = token as Saved;
      const tl = timeline.getState();
      if (t.focus && tl.focus !== t.focus) tl.focusSurvey(t.focus);
      if (t.kit) {
        const v = volumetric.getState();
        v.setSurface(t.kit.surface);
        if (v.swipe !== t.kit.swipe) v.setSwipe(t.kit.swipe);
      }
      // the layers exactly as they were shown and hidden
      const ws = workspace.getState();
      const now = ws.hidden;
      const show = Object.keys(now).filter((id) => !t.hidden[id]);
      const hide = Object.keys(t.hidden).filter((id) => !now[id]);
      if (show.length > 0 || hide.length > 0) ws.applyVisibility(show, hide);
      compareStore.setState({ heat: t.heat, siteHeat: t.siteHeat });
      stageShow.setState(t.show);
      measureStore.setState(t.measure);
      ws.select(t.selection);
      stage.setLabelMode(t.labelMode);
      stage.restoreView(t.view, false);
      stage.requestRender();
      await frame();
      const sh = shell.getState();
      if (sh.stageMode !== t.stageMode) sh.setStageMode(t.stageMode);
      if (sh.screen !== t.screen) sh.go(t.screen);
    },
    prepare() {
      stageShow.setState({ outlines: true, labels: false });
      measureStore.setState({ selected: [], focus: null });
      workspace.getState().select(null);
      stage.setLabelMode('off');
      const v = volumetric.getState();
      if (kitLoaded() && v.swipe) v.setSwipe(false);
    },
    showDate(capture) {
      if (timeline.getState().focus !== capture) timeline.getState().focusSurvey(capture);
    },
    async showSurface(surface: PictureSurface, at) {
      if (kitLoaded()) {
        volumetric.getState().setSurface(surface);
        return true;
      }
      if (surface !== 'change') {
        if (
          surface === 'elev' &&
          !layers().some((l) => isRaster(l, 'dsm') && dateOf(l.id) === at.capture)
        )
          return false;
        heatOn(false);
        compareStore.setState({ siteHeat: null });
        swapRasters(surface);
        stageShow.setState({ surface });
        return true;
      }
      swapRasters('photo');
      const cs = compareStore.getState();
      const question = siteCutFillQuestion({
        wanted: true,
        engineReady: cs.status === 'ready',
        pair: at.pair ?? null,
        surfaces: cs.surfaces,
        thresholdM: cutFillPrefs.getState().thresholdM,
      });
      if (!question) return false;
      heatOn(true);
      heatThresholdM = question.thresholdM;
      stageShow.setState({ surface: 'change' });
      const grid = await wholeSiteHeat(
        question.refs,
        question.thresholdM,
        question.cellM,
        (req) => engineClient().site(req, 'report-pictures-site'),
        { pair: question.pk },
      );
      compareStore.setState({ siteHeat: grid });
      return grid !== null;
    },
    aim(pose) {
      stage.restoreView(pose, false);
      stage.requestRender();
    },
    async settle(timeoutMs, what) {
      const until = Date.now() + timeoutMs;
      if (what === 'heat') {
        while (Date.now() < until && !kitLoaded() && compareStore.getState().siteHeat === null)
          await sleep(100);
      } else {
        const hidden = workspace.getState().hidden;
        const wanted = layers().filter((l) => DRAWN.has(l.kind) && !hidden[l.id]);
        while (Date.now() < until && !wanted.every((l) => stage.layerLoaded(l.id)))
          await sleep(100);
      }
      stage.requestRender();
      await sleep(Math.min(QUIET_MS, Math.max(0, until - Date.now())));
      await frame();
      await frame();
    },
    async shoot(camera, w, h, quality) {
      if (stage.contextLost) throw new Error('The 3D view lost its graphics context.');
      return jpeg(renderInto(stage, camera, w, h), quality);
    },
    cutFillSettings() {
      if (kitLoaded() || heatThresholdM === null || compareStore.getState().siteHeat === null)
        return null;
      const { stops, stepped, inverted } = measureStore.getState().settings.heatmap;
      const style = { stops, stepped, inverted };
      return { thresholdM: heatThresholdM, rangeM: legendRangeM(style), style };
    },
    heightAt(e, n) {
      const [x, , z] = [e - origin[0], 0, 0 - (n - origin[1])];
      const hit = stage.raycastRay(new Vector3(x, 20_000, z), new Vector3(0, -1, 0));
      return hit ? hit.point.y + origin[2] : null;
    },
  };
}

/**
 * Take the report's pictures from the live stage and save them (`report:saveViews`). The
 * progress card reads `pictureRun` (captureViews.ts).
 */
export async function takeReportPictures(
  req: CaptureRequest,
  opts: { report?: ReportTypeId; onProgress?: CaptureOptions['onProgress'] } = {},
): Promise<CaptureResult> {
  const stage = await liveStage();
  if (!stage) return { ok: false, error: 'The 3D view is not available for this project.' };
  const report = opts.report ?? 'volumetric';
  return captureViews(req, stage, {
    ...(opts.onProgress ? { onProgress: opts.onProgress } : {}),
    save: async (frame, files) => {
      const r = await bridge.call('report:saveViews', {
        projectId: req.projectId,
        report,
        frame,
        files: files.map((f) => ({ name: f.name, data: f.data })),
      });
      return r.ok ? r.value : { ok: false, error: r.error };
    },
  });
}
