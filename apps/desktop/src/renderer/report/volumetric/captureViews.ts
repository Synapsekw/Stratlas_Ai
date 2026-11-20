/**
 * Taking the volumetric report's pictures from the 3D stage (spec section 7, plan Task 22): per
 * date a Photo and an Elevation top down and a 3D view from the south-east, and the compared
 * pair's Cut & fill top down. The top-down shots share one frame over the yard (`framing.ts`),
 * rendered through an orthographic camera straight down; the 3D shot records where it saw each
 * pile's centre.
 *
 * Each pile also gets pictures of its own (layout plan 2026-11-20, sections 4 and 5): a photo
 * straight down on the latest and on the compared date, both on one 4:3 frame around its outlines,
 * and a 3D picture of its box pinned to the latest date, whatever date the pile is filed under.
 *
 * The stage is driven through `CaptureStage` (the live one is `liveStage.ts`): the person's date,
 * surface, camera, selection and labels are put back afterwards, also when a shot fails, and
 * `pictureRun` says a run is going so the progress card covers the stage meanwhile.
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
import { t as tr } from '@aio/ui';
import { createStore } from 'zustand/vanilla';
import {
  angledCamera,
  frameFor,
  pileFrame,
  pixelOf,
  topDownCamera,
  yardExtent,
  type Extent,
} from './framing';

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
  /**
   * Wait for the date's tiles (and the heat map) to settle, at most `timeoutMs`. `pile` is the
   * short wait of a pile's own picture: the date's layers are in already.
   */
  settle(timeoutMs: number, what: 'tiles' | 'heat' | 'pile'): Promise<void>;
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
   * Draw a pile's box as it is on the survey date `capture`, whatever is focused, selected or on
   * screen; `null` takes the box away. Resolves once that is drawn: false when the box did not
   * come within the stage's time limit.
   */
  openPile(id: string | null, capture?: string): Promise<boolean>;
  /** The measurements' own outlines on or off (the report draws a pile photo's outline itself). */
  showOutlines(on: boolean): void | Promise<void>;
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
  /**
   * The report's piles in the report's order (largest first): their outlines frame the yard and
   * place the 3D markers, and the first that fit get pictures of their own (`planShots`). `label`
   * is the pile's name on the progress card.
   */
  piles: readonly (Pick<SurveyMeasurement, 'id' | 'points'> &
    Partial<Pick<SurveyMeasurement, 'outlines' | 'label'>>)[];
  /** Each survey date as the progress card names it, by capture id. */
  dateLabels?: Readonly<Record<string, string>>;
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
  /** Time limit for the tiles of one pile picture, ms. */
  pileTimeoutMs?: number;
}

export type CaptureResult =
  | {
      ok: true;
      frame: ReportViewsFrame;
      /** The piles past the cap: they have no pictures of their own. */
      unpictured: string[];
    }
  | { ok: false; error: string };

/** A picture run in progress: the progress card covers the stage while `running`. */
export interface PictureRunState {
  running: boolean;
  /** Stop was asked (Escape or Stop on the progress card): the run ends after the current shot. */
  stopping: boolean;
  done: number;
  total: number;
  /** What is pictured now ("Site, 12 Mar 2026", "Pile 4 of 31: Pile D"); empty between runs. */
  label: string;
}

export const pictureRun = createStore<PictureRunState>()(() => ({
  running: false,
  stopping: false,
  done: 0,
  total: 0,
  label: '',
}));

/** The error a stopped run returns; nothing is saved and the person's view comes back. */
export const picturesStopped = (): string => tr('vreport.pictures.stopped');

/**
 * Ask the picture run to stop after its current shot. Asked while the card is up but before the
 * run has started (the Scene still opening), the run stops before its first shot.
 */
export function stopPictures(): void {
  pictureRun.setState({ stopping: true });
}

/** A new picture run may start: forget an earlier stop (the progress card calls it on opening). */
export function resetPictureStop(): void {
  pictureRun.setState({ stopping: false });
}

export const MAX_SIDE = 2000;
/** The 3D picture's width over height. */
export const ASPECT_3D = 1.5;
/** A pile's own pictures, px: 4:3, as its card prints them. */
export const PILE_W = 800;
export const PILE_H = 600;
/** The margin around a pile in its own photo, as a share of its size. */
const PILE_MARGIN = 0.22;
/** JPEG quality: photo and 3D 0.80, the maps (elevation, cut and fill) 0.88. */
export const QUALITY: Record<ReportViewKind, number> = {
  photo: 0.8,
  '3d': 0.8,
  elevation: 0.88,
  cutfill: 0.88,
  'pile-photo': 0.8,
  'pile-3d': 0.8,
};

export interface PlannedShot {
  kind: ReportViewKind;
  capture: string;
  pair?: string;
  /** The view's name: its file without `.jpg`. */
  name: string;
  file: string;
  /** The pile kinds: the measurement pictured. */
  pile?: string;
}

/** The shots of a run, and the piles that got no pictures of their own because of the cap. */
export interface ShotPlan {
  shots: PlannedShot[];
  unpictured: string[];
}

const SURFACE_OF: Record<ReportViewKind, PictureSurface> = {
  photo: 'photo',
  '3d': 'photo',
  elevation: 'elev',
  cutfill: 'change',
  'pile-photo': 'photo',
  'pile-3d': 'photo',
};

/**
 * The dates a pile is pictured on. `latest` is the date the report is about (the compared pair's
 * later date, else the newest): the pile's 3D picture is taken there, always. `photos` are the
 * dates of its photos, the compared date first.
 */
export function pileDates(
  dates: readonly string[],
  pair: { from: string; to: string } | null,
): { latest: string | null; photos: string[] } {
  const latest = pair?.to ?? dates.at(-1) ?? null;
  if (latest === null) return { latest, photos: [] };
  return { latest, photos: pair && pair.from !== latest ? [pair.from, latest] : [latest] };
}

/**
 * The shots in the order they are taken, each date in one go so its layers load once: per date
 * Photo and 3D, the piles' photos when the date is a pictured one, the piles' 3D pictures on the
 * latest date, then Elevation, and the pair's Cut & fill after its later date.
 *
 * The site pictures come first in the budget (`REPORT_VIEWS_MAX`): only the newest dates that
 * fit. `piles` are the report's pile ids in report order; the first that still fit get their
 * pictures (`pile-<k>-photo-<n>` per pictured date, `pile-<k>-3d`), the rest come back as
 * `unpictured`. A pile is pictured whole or not at all.
 */
export function planShots(
  dates: readonly string[],
  pair: { from: string; to: string } | null,
  piles: readonly string[] = [],
): ShotPlan {
  const room = Math.floor((REPORT_VIEWS_MAX - (pair ? 1 : 0)) / 3);
  const kept = dates.slice(Math.max(0, dates.length - room));
  const offset = dates.length - kept.length;
  const of = pileDates(dates, pair);
  const photoOn = new Set(of.photos.filter((c) => kept.includes(c)));
  const threeDOn = of.latest !== null && kept.includes(of.latest) ? of.latest : null;
  const perPile = photoOn.size + (threeDOn === null ? 0 : 1);
  const left = REPORT_VIEWS_MAX - kept.length * 3 - (pair ? 1 : 0);
  const pictured = perPile > 0 ? piles.slice(0, Math.max(0, Math.floor(left / perPile))) : [];
  const out: PlannedShot[] = [];
  const shot = (
    kind: ReportViewKind,
    capture: string,
    name: string,
    more: { pair?: string; pile?: string } = {},
  ) => out.push({ kind, capture, name, file: `${name}.jpg`, ...more });
  const cutFill = () => {
    if (pair) shot('cutfill', pair.to, 'cutfill', { pair: pair.from });
  };
  // right after its later date's own pictures; at the end when that date is not pictured
  const cutAfter = pair !== null && kept.includes(pair.to) ? pair.to : null;
  kept.forEach((capture, i) => {
    const n = String(offset + i + 1);
    shot('photo', capture, `photo-${n}`);
    shot('3d', capture, `3d-${n}`);
    if (photoOn.has(capture))
      pictured.forEach((pile, k) =>
        shot('pile-photo', capture, `pile-${String(k + 1)}-photo-${n}`, { pile }),
      );
    if (capture === threeDOn)
      pictured.forEach((pile, k) => shot('pile-3d', capture, `pile-${String(k + 1)}-3d`, { pile }));
    shot('elevation', capture, `elevation-${n}`);
    if (capture === cutAfter) cutFill();
  });
  if (cutAfter === null) cutFill();
  return { shots: out, unpictured: piles.slice(pictured.length) };
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

  const plan = planShots(
    req.dates,
    req.pair,
    req.piles.map((m) => m.id),
  );
  const shots = plan.shots;
  const pileOf = new Map(req.piles.map((m) => [m.id, m]));
  const pileNo = new Map(req.piles.map((m, k) => [m.id, k + 1]));
  const pictured = req.piles.length - plan.unpictured.length;
  const photoDates = pileDates(req.dates, req.pair).photos;
  const labelOf = (s: PlannedShot): string => {
    if (s.kind === 'cutfill') return tr('vreport.pictures.progressChange');
    const m = s.pile === undefined ? undefined : pileOf.get(s.pile);
    if (!m) return tr('vreport.pictures.progressSite', { date: req.dateLabels?.[s.capture] ?? '' });
    const n = pileNo.get(m.id) ?? 0;
    return tr('vreport.pictures.progressPile', {
      n,
      total: pictured,
      pile: m.label ?? String(n),
    });
  };
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
  const pileMs = opts.pileTimeoutMs ?? 6000;

  const total = shots.length;
  // the card counts from the start ("Picture 1 of 22"), so it names the first picture from the
  // start too, while the stage is still being made ready
  const first = shots[0];
  pictureRun.setState({ running: true, done: 0, total, label: first ? labelOf(first) : '' });
  opts.onProgress?.(0, total);
  const token = stage.save();
  const views: ReportView[] = [];
  const files: { name: string; data: Uint8Array<ArrayBuffer> }[] = [];
  const markers3d: Record<string, Record<string, [number, number]>> = {};
  let failed: string | null = null;
  let cutFill: FrameCutFill | null = null;
  // the measurements' own outlines are off for the length of the piles' photos only
  let outlines = true;
  const setOutlines = async (on: boolean) => {
    if (outlines === on) return;
    outlines = on;
    await stage.showOutlines(on);
  };
  try {
    await stage.prepare();
    let date: string | null = null;
    // the surface shown on `date`; a new date asks for its surface again
    let surface: PictureSurface | null = null;
    let have = true;
    for (const [i, s] of shots.entries()) {
      if (pictureRun.getState().stopping) {
        failed = picturesStopped();
        break;
      }
      pictureRun.setState({ label: labelOf(s) });
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
      const pile = s.pile === undefined ? undefined : pileOf.get(s.pile);
      await setOutlines(s.kind !== 'pile-photo');
      if (have && pile) {
        const taken = await pileShot(pile, s, photoDates, stage, pileMs);
        if (taken) {
          views.push({
            name: s.name,
            kind: s.kind,
            capture: s.capture,
            file: s.file,
            pile: pile.id,
            ...(taken.extent ? { extent: taken.extent } : {}),
          });
          files.push({ name: s.file, data: taken.data });
        }
      } else if (have && s.pile === undefined) {
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
      await setOutlines(true);
    } catch (e) {
      failed ??= message(e);
    }
    try {
      await stage.restore(token);
    } catch (e) {
      failed ??= message(e);
    }
  }
  // the run counts as going until its save: a stop asked during the last shot or while the view
  // comes back still keeps it from being saved
  // the label stays: the card is still up while the export goes on to write its file, and an
  // empty line beside "Picture 22 of 22" reads as a fault (the next run names its first picture)
  const end = () => {
    pictureRun.setState({ running: false, stopping: false });
  };
  if (failed === null && pictureRun.getState().stopping) failed = picturesStopped();
  if (failed !== null) {
    end();
    return { ok: false, error: failed };
  }

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
  let saved: Awaited<ReturnType<CaptureOptions['save']>>;
  try {
    saved = await opts.save(out, files);
  } finally {
    end();
  }
  return saved.ok
    ? { ok: true, frame: out, unpictured: plan.unpictured }
    : { ok: false, error: saved.error ?? 'Not saved.' };
}

/** The 3D picture of a pile: from the south-east, a little flatter and longer than the site's. */
const PILE_3D_VIEW = { azimuthDeg: 135, elevationDeg: 32, fovDeg: 35 } as const;

/**
 * One picture of one pile, or null when it cannot be taken (no outline, or its box did not come).
 *
 * `pile-photo`: straight down on the frame around the pile's outlines on every pictured date
 * (`pileFrame`), so the latest and the compared photo cover the same ground; the view carries that
 * `extent`. `pile-3d`: the pile's box pinned to the shot's date (`stage.openPile`), from the
 * south-east, framed on the pile and the space above it where the box's lifted top is drawn. The
 * pin is always taken away again, also when the shot throws.
 */
async function pileShot(
  m: CaptureRequest['piles'][number],
  s: PlannedShot,
  photoDates: readonly string[],
  stage: CaptureStage,
  timeoutMs: number,
): Promise<{ data: Uint8Array<ArrayBuffer>; extent?: [number, number, number, number] } | null> {
  const own = { points: m.points, outlines: m.outlines };
  const aspect = PILE_W / PILE_H;
  const quality = QUALITY[s.kind];
  if (s.kind === 'pile-photo') {
    const rings = photoDates.map((c) => outlineOn(own, c));
    const extent = pileFrame(rings, aspect, PILE_MARGIN);
    if (!extent) return null;
    const heights = pileHeights(rings, extent, stage);
    stage.aim(topPose(extent, stage.origin, heights, stage.view));
    await stage.settle(timeoutMs, 'pile');
    const camera = topDownCamera({ extent }, stage.origin, heights);
    return { data: await stage.shoot(camera, PILE_W, PILE_H, quality), extent };
  }
  const ring = outlineOn(own, s.capture);
  const bounds = yardExtent([ring], { margin: 0, minMarginM: 0 });
  if (!bounds) return null;
  // read before the box is drawn: the height is the ground's, not the box's lifted top
  const [lo, top] = pileHeights([ring], bounds, stage);
  const shown = await stage.openPile(m.id, s.capture);
  try {
    if (!shown) return null;
    // the box's top is drawn lifted above the pile: keep the space over it in view
    const heights: [number, number] = [lo, top + Math.max(top - lo, 1) * 0.6];
    const camera = angledCamera(bounds, stage.origin, heights, aspect, PILE_3D_VIEW);
    const [e0, n0, e1, n1] = bounds;
    const mid = projectToLocal([(e0 + e1) / 2, (n0 + n1) / 2, (lo + top) / 2], stage.origin);
    stage.aim({
      position: [camera.position.x, camera.position.y, camera.position.z],
      target: [mid[0], mid[1], mid[2]],
    });
    await stage.settle(timeoutMs, 'pile');
    return { data: await stage.shoot(camera, PILE_W, PILE_H, quality) };
  } finally {
    await stage.openPile(null);
  }
}

/**
 * The lowest and highest height of a pile for its cameras: its outlines' heights, and the drawn
 * surface at the centre of `extent` when the stage can say it (the outline lies on the toe).
 */
function pileHeights(
  rings: readonly (readonly (readonly number[])[])[],
  extent: Extent,
  stage: CaptureStage,
): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  for (const ring of rings)
    for (const p of ring) {
      const z = p[2];
      if (z === undefined) continue;
      lo = Math.min(lo, z);
      hi = Math.max(hi, z);
    }
  if (!Number.isFinite(lo)) return [0, 0];
  const at = stage.heightAt?.((extent[0] + extent[2]) / 2, (extent[1] + extent[3]) / 2);
  return [lo, Math.max(hi, at ?? hi)];
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
