/**
 * Taking the volumetric report's pictures from the 3D stage (spec section 7, plan Task 22): per
 * date a Photo and an Elevation top down and a 3D view from the south-east, and the compared
 * pair's Cut & fill top down. The top-down shots share one frame over the yard (`framing.ts`),
 * rendered through an orthographic camera straight down; the 3D shot records where it saw each
 * pile's centre. The stage is driven through `CaptureStage` (the live one is `liveStage.ts`): the
 * person's date, surface, camera, selection and labels are put back afterwards, also when a shot
 * fails, and `pictureRun` says a run is going so the progress card covers the stage meanwhile.
 */
import {
  REPORT_VIEWS_MAX,
  REPORT_VIEWS_SCHEMA,
  type ReportView,
  type ReportViewKind,
  type ReportViewsFrame,
  type SurveyMeasurement,
  type Vec3,
  type HeatmapStyle,
} from '@aio/schema';
import { projectToLocal } from '@aio/geo';
import { outlineOn } from '@aio/survey';
import type { OrthographicCamera, PerspectiveCamera } from 'three';
import { createStore } from 'zustand/vanilla';
import { angledCamera, frameFor, pixelOf, topDownCamera, yardExtent, type Extent } from './framing';

/** The Show control's surface a shot is taken on. */
export type PictureSurface = 'photo' | 'elev' | 'change';

/** A camera pose in the stage's local frame (`EngineStage.saveView`). */
export interface StagePose {
  position: [number, number, number];
  target: [number, number, number];
}

/**
 * What a capture drives. `save` returns whatever `restore` needs to put the person's view back:
 * date in focus, Show surface, camera pose, selection and label visibility.
 */
export interface CaptureStage {
  /** The project origin [E, N, H]: local = projectToLocal(site, origin). */
  readonly origin: Vec3;
  /** The stage camera's vertical field of view and the canvas aspect, for aiming it. */
  readonly view: { fovDeg: number; aspect: number };
  save(): unknown;
  restore(token: unknown): void | Promise<void>;
  /** Pile outlines on, labels and overlays off, nothing selected. */
  prepare(): void | Promise<void>;
  /** Bring a survey date into focus. */
  showDate(capture: string): void | Promise<void>;
  /** Show a surface on the date; false when the date has none (no DSM, no prepared surfaces). */
  showSurface(
    surface: PictureSurface,
    at: { capture: string; pair?: { from: string; to: string } },
  ): Promise<boolean>;
  /** Point the stage camera so the content of a shot loads at the right detail. */
  aim(pose: StagePose): void;
  /** Wait for the date's tiles (and the heat map) to settle, at most `timeoutMs`. */
  settle(timeoutMs: number, what: 'tiles' | 'heat'): Promise<void>;
  /** Render the stage's scene through `camera` into a `w` x `h` JPEG at `quality`. */
  shoot(
    camera: PerspectiveCamera | OrthographicCamera,
    w: number,
    h: number,
    quality: number,
  ): Promise<Uint8Array<ArrayBuffer>>;
  /** The drawn ground height under a site point, when the stage can say it. */
  heightAt?(e: number, n: number): number | null;
  /**
   * The cut and fill settings the heat map on the stage is drawn with now (read right after the
   * Cut & fill shot), saved on the frame as `cutFill` for page C's key and legend.
   */
  cutFillSettings?(): FrameCutFill | null;
}

/** The stage heat map's "Ignore under" deadband, legend half span and colours (`frame.cutFill`). */
export interface FrameCutFill {
  thresholdM: number;
  rangeM: number;
  style?: Pick<HeatmapStyle, 'stops' | 'stepped' | 'inverted'>;
}

export interface CaptureRequest {
  projectId: string;
  /** The survey dates to picture, oldest first. */
  dates: readonly string[];
  /** The compared pair: the cut and fill picture, of `to` against `from`. */
  pair: { from: string; to: string } | null;
  /** The report's piles: their outlines frame the yard and place the 3D markers. */
  piles: readonly (Pick<SurveyMeasurement, 'id' | 'points'> &
    Partial<Pick<SurveyMeasurement, 'outlines'>>)[];
  /** The inputs' fingerprint, saved to tell when the pictures are stale. */
  fingerprint: string;
  /** Longest side of the top-down pictures (2000 by default). */
  maxSide?: number;
}

export interface CaptureOptions {
  /** Saves the pictures (`report:saveViews`). */
  save(
    frame: ReportViewsFrame,
    files: { name: string; data: Uint8Array<ArrayBuffer> }[],
  ): Promise<{ ok: boolean; error?: string | undefined }>;
  onProgress?(done: number, total: number): void;
  /** Time limit for the tiles of one shot, ms. */
  tileTimeoutMs?: number;
  /** Time limit for the heat map, ms. */
  heatTimeoutMs?: number;
}

export type CaptureResult = { ok: true; frame: ReportViewsFrame } | { ok: false; error: string };

/** A picture run in progress: the progress card covers the stage while `running`. */
export interface PictureRunState {
  running: boolean;
  done: number;
  total: number;
}

export const pictureRun = createStore<PictureRunState>()(() => ({
  running: false,
  done: 0,
  total: 0,
}));

export const MAX_SIDE = 2000;
/** The 3D picture's width over height. */
export const ASPECT_3D = 1.5;
/** JPEG quality: photo and 3D 0.80, the maps (elevation, cut and fill) 0.88. */
export const QUALITY: Record<ReportViewKind, number> = {
  photo: 0.8,
  '3d': 0.8,
  elevation: 0.88,
  cutfill: 0.88,
};

export interface PlannedShot {
  kind: ReportViewKind;
  capture: string;
  pair?: string;
  /** The view's name: its file without `.jpg`. */
  name: string;
  file: string;
}

const SURFACE_OF: Record<ReportViewKind, PictureSurface> = {
  photo: 'photo',
  '3d': 'photo',
  elevation: 'elev',
  cutfill: 'change',
};

/**
 * The shots in the order they are taken: per date Photo, 3D (on the photo) and Elevation, then
 * the pair's Cut & fill. Only the newest dates whose pictures fit in `REPORT_VIEWS_MAX`.
 */
export function planShots(
  dates: readonly string[],
  pair: { from: string; to: string } | null,
): PlannedShot[] {
  const room = Math.floor((REPORT_VIEWS_MAX - (pair ? 1 : 0)) / 3);
  const kept = dates.slice(Math.max(0, dates.length - room));
  const offset = dates.length - kept.length;
  const out: PlannedShot[] = [];
  const shot = (kind: ReportViewKind, capture: string, name: string, pairOf?: string) =>
    out.push({ kind, capture, name, file: `${name}.jpg`, ...(pairOf ? { pair: pairOf } : {}) });
  kept.forEach((capture, i) => {
    const n = String(offset + i + 1);
    shot('photo', capture, `photo-${n}`);
    shot('3d', capture, `3d-${n}`);
    shot('elevation', capture, `elevation-${n}`);
  });
  if (pair) shot('cutfill', pair.to, 'cutfill', pair.from);
  return out;
}

/** The lowest and highest height of the piles' outlines. */
function heightsOf(req: CaptureRequest): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  for (const m of req.piles)
    for (const ring of [m.points, ...(m.outlines ?? []).map((o) => o.points)])
      for (const p of ring) {
        lo = Math.min(lo, p[2]);
        hi = Math.max(hi, p[2]);
      }
  return Number.isFinite(lo) ? [lo, hi] : [0, 0];
}

/** The stage camera's pose for a top-down shot: straight down (a hair south), the extent in view. */
function topPose(
  extent: Extent,
  origin: Vec3,
  heights: readonly [number, number],
  view: CaptureStage['view'],
): StagePose {
  const [e0, n0, e1, n1] = extent;
  const c = projectToLocal([(e0 + e1) / 2, (n0 + n1) / 2, (heights[0] + heights[1]) / 2], origin);
  const half = Math.tan(((view.fovDeg / 2) * Math.PI) / 180);
  const d = (Math.max((n1 - n0) / 2, (e1 - e0) / 2 / view.aspect) / half) * 1.05;
  return { position: [c[0], c[1] + d, c[2] + d * 1e-3], target: [c[0], c[1], c[2]] };
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Take the pictures, save them with their frame, and put the person's view back. */
export async function captureViews(
  req: CaptureRequest,
  stage: CaptureStage,
  opts: CaptureOptions,
): Promise<CaptureResult> {
  if (pictureRun.getState().running)
    return { ok: false, error: 'Pictures are already being taken.' };
  const rings = req.piles.flatMap((m) => [
    m.points,
    ...req.dates.map((c) => outlineOn({ points: m.points, outlines: m.outlines }, c)),
  ]);
  const extent = yardExtent(rings);
  if (!extent || req.dates.length === 0)
    return { ok: false, error: 'The report has no piles to picture.' };

  const shots = planShots(req.dates, req.pair);
  const frame = frameFor(extent, req.maxSide ?? MAX_SIDE);
  const heights = heightsOf(req);
  const top = topDownCamera(frame, stage.origin, heights);
  const topAim = topPose(frame.extent, stage.origin, heights, stage.view);
  const w3 = Math.max(frame.widthPx, frame.heightPx);
  const h3 = Math.round(w3 / ASPECT_3D);
  const angled = angledCamera(frame.extent, stage.origin, heights, ASPECT_3D);
  const [e0, n0, e1, n1] = frame.extent;
  const mid = projectToLocal(
    [(e0 + e1) / 2, (n0 + n1) / 2, (heights[0] + heights[1]) / 2],
    stage.origin,
  );
  const angledAim: StagePose = {
    position: [angled.position.x, angled.position.y, angled.position.z],
    target: [mid[0], mid[1], mid[2]],
  };
  const tileMs = opts.tileTimeoutMs ?? 15_000;
  const heatMs = opts.heatTimeoutMs ?? 30_000;

  const total = shots.length;
  pictureRun.setState({ running: true, done: 0, total });
  opts.onProgress?.(0, total);
  const token = stage.save();
  const views: ReportView[] = [];
  const files: { name: string; data: Uint8Array<ArrayBuffer> }[] = [];
  const markers3d: Record<string, Record<string, [number, number]>> = {};
  let failed: string | null = null;
  let cutFill: FrameCutFill | null = null;
  try {
    await stage.prepare();
    let date: string | null = null;
    // the surface shown on `date`; a new date asks for its surface again
    let surface: PictureSurface | null = null;
    let have = true;
    for (const [i, s] of shots.entries()) {
      const want = SURFACE_OF[s.kind];
      if (s.capture !== date) {
        await stage.showDate(s.capture);
        date = s.capture;
        surface = null;
      }
      if (surface !== want) {
        const pair = s.pair ? { from: s.pair, to: s.capture } : undefined;
        have = await stage.showSurface(want, { capture: s.capture, ...(pair ? { pair } : {}) });
        surface = want;
      }
      if (have) {
        const is3d = s.kind === '3d';
        stage.aim(is3d ? angledAim : topAim);
        await stage.settle(tileMs, 'tiles');
        if (s.kind === 'cutfill') await stage.settle(heatMs, 'heat');
        const data = is3d
          ? await stage.shoot(angled, w3, h3, QUALITY[s.kind])
          : await stage.shoot(top, frame.widthPx, frame.heightPx, QUALITY[s.kind]);
        views.push({
          name: s.name,
          kind: s.kind,
          capture: s.capture,
          ...(s.pair ? { pair: s.pair } : {}),
          file: s.file,
        });
        files.push({ name: s.file, data });
        if (s.kind === 'cutfill') cutFill = stage.cutFillSettings?.() ?? null;
        if (is3d) markers3d[s.capture] = pileMarkers(req, s.capture, stage, angled, w3, h3);
      }
      pictureRun.setState({ done: i + 1 });
      opts.onProgress?.(i + 1, total);
    }
  } catch (e) {
    failed = message(e);
  } finally {
    try {
      await stage.restore(token);
    } catch (e) {
      failed ??= message(e);
    }
    pictureRun.setState({ running: false });
  }
  if (failed !== null) return { ok: false, error: failed };

  const out: ReportViewsFrame = {
    schema: REPORT_VIEWS_SCHEMA,
    extent: frame.extent,
    widthPx: frame.widthPx,
    heightPx: frame.heightPx,
    mPerPx: frame.mPerPx,
    views,
    markers3d,
    fingerprint: req.fingerprint,
    ...(cutFill ? { cutFill } : {}),
  };
  const saved = await opts.save(out, files);
  return saved.ok ? { ok: true, frame: out } : { ok: false, error: saved.error ?? 'Not saved.' };
}

/** Where the 3D camera saw each pile's centre on `capture` (its outline on that date). */
function pileMarkers(
  req: CaptureRequest,
  capture: string,
  stage: CaptureStage,
  camera: PerspectiveCamera,
  w: number,
  h: number,
): Record<string, [number, number]> {
  const out: Record<string, [number, number]> = {};
  for (const m of req.piles) {
    const ring = outlineOn({ points: m.points, outlines: m.outlines }, capture);
    if (ring.length === 0) continue;
    const mean = (k: 0 | 1 | 2) => ring.reduce((s, p) => s + p[k], 0) / ring.length;
    const e = mean(0);
    const n = mean(1);
    const z = stage.heightAt?.(e, n) ?? mean(2);
    const px = pixelOf(camera, projectToLocal([e, n, z], stage.origin), w, h);
    if (px) out[m.id] = px;
  }
  return out;
}
