/**
 * Comparisons in the renderer (M11 G4, PRD SRV-1 and SRV-2): the survey engine worker for the open
 * project, its prepared surfaces and designs, and the results of each measurement's comparison
 * items. The focused polygon is computed when its inputs change (its stored results' fingerprints
 * no longer match), and while its vertices are dragged (live numbers, not stored). A result whose
 * fingerprint no longer matches is shown as **Stale, recompute**, never as current. Results the
 * app computes on its own (on focus) are derived, not a person's edit: they do not mark the file
 * unsaved and are written with the next save; Recompute is the person's and is saved as an edit.
 *
 * Volumetric parity (W3, W4): a measurement's volume per survey date (`computeSeries`) is computed
 * on demand, when a chart, the volumes view or a report asks, and stored per date with its
 * fingerprint (derived, not an edit); the spread across bases (`useSpread`) is shown, never
 * stored. A carried kit figure is never stale and never replaced on its own: only the person's
 * Recompute (`recomputeStandard`) replaces it, keeping the old figure as "was".
 */
import { useEffect } from 'react';
import {
  outlineOn,
  pileNeighbours,
  SPREAD_BASES,
  seriesApplies,
  seriesRequests,
  type BaseSpread,
  type DraftRegion,
} from '@aio/survey';
import type {
  ComparisonItem,
  ComparisonResult,
  DesignEntry,
  HeightTiles,
  ProjectManifest,
  SitePoint,
  SurfaceRef,
  SurveyMeasurement,
  SurveyPrepareParams,
} from '@aio/schema';
import { t } from '@aio/ui';
import { createStore, useStore } from 'zustand';
import { captureShift, shiftKey, workspace } from '@aio/workspace';
import { bridge, jobs } from '../shell';
import { connectEngine, RunCancelled, startEngineWorker, type EngineClient } from './engineClient';
import { designs as designsStore } from './designsStore';
import type { EnginePort, HeatGrid, ItemShare, RunReply } from './engineProtocol';
import { storedPoints } from './measureDates';
import { fetchKitText } from './kitHeights';
import { prepareKitSurfaces } from './kitSurface';
import { refreshQa, sourceOfCapture } from './qaStore';
import { prepareRunningOn, preparedSurfaces } from './surfaceStates';
import { carriedItem, datesToRun, lineUps, seriesDate, seriesKeyOf } from './seriesRule';
import {
  acceptKitQuietly,
  measureInputsKey,
  measureStore,
  type KitAccepted,
  replaceWithStandard,
  setComputedResults,
  setSeries,
  updateMeasurement,
} from './measureStore';

export interface CaptureInfo {
  id: string;
  label: string;
  date: string;
}

export interface Computed {
  /** The ring the numbers are for (to tell live numbers from the stored geometry). */
  ringKey: string;
  results: ComparisonResult[];
  heat: HeatGrid[];
  /** The in-tolerance share of each design item (compliance to design). */
  shares: ItemShare[];
  ms: number;
  live: boolean;
  /**
   * Run for the heat map only: the stored results are current. A carried kit figure's item is
   * left out of `results` (the stored figure is what is shown), so no reader shows the engine's.
   */
  heatOnly?: boolean;
}

export interface HeatView {
  show3d: boolean;
  show2d: boolean;
  contours: boolean;
  /** The item (by id) whose difference is drawn, or null for the first. */
  item: string | null;
}

export type CompareDialog = 'materials' | 'site' | null;

/** A kit pyramid index (`aio.tiles/1`) as the whole-site job writes its heat map. */
export interface SiteTiles {
  levels: { z: number; tileSize: number; cols: number; rows: number; pattern: string }[];
  /** Local frame (x east, y up, z south) corners: top left, top right, bottom left. */
  corners: { tl: number[]; tr: number[]; bl: number[] };
}

/** The whole-site comparison (a `survey.compare` site job) and its draft regions. */
export interface SiteRun {
  job: string | null;
  progress: number;
  /** Project folder of the job's outputs. */
  out: string;
  from: SurfaceRef;
  to: SurfaceRef;
  deadbandM: number | null;
  result: ComparisonResult | null;
  tiles: SiteTiles | null;
  drafts: DraftRegion[];
  error: string | null;
}

export interface CompareState {
  projectId: string | null;
  root: string | null;
  status: 'idle' | 'loading' | 'ready' | 'error';
  error: string | null;
  surfaces: HeightTiles[];
  designs: DesignEntry[];
  /** In date order. */
  captures: CaptureInfo[];
  /** Fingerprints of each measurement's items as they would be now (item order). */
  current: Record<string, string[]>;
  computed: Record<string, Computed>;
  running: Record<string, boolean>;
  problems: Record<string, string>;
  heat: HeatView;
  /**
   * The whole site's cut and fill between the compare pair, drawn when no focused measurement has
   * a heat map of its own (Show, Cut & fill in a survey project: workspace/stageCutFill.ts).
   */
  siteHeat: HeatGrid | null;
  dialog: CompareDialog;
  /** A tonnage typed into a measurement's weight calculator (display only, never stored). */
  tonnes: Record<string, number>;
  /** A running `survey.prepare` job. */
  preparing: string | null;
  site: SiteRun | null;
  /** Draft regions shown on the map (ticked to accept). */
  showDrafts: boolean;
  /**
   * The fingerprint each measurement's per-date result would have now, by `<item> <capture>`
   * (only what `computeSeries` has looked at).
   */
  seriesCurrent: Record<string, Record<string, string>>;
  /** The inputs (`inputsKey`: items and ring) `seriesCurrent` was worked out for, per measurement. */
  seriesInputs: Record<string, string>;
  /** Each measurement's spread across bases, for the item fingerprint in `key` (never stored). */
  spreads: Record<string, { key: string; value: BaseSpread | null | 'computing' }>;
}

const initial = (): Omit<CompareState, 'heat' | 'dialog'> => ({
  projectId: null,
  root: null,
  status: 'idle',
  error: null,
  surfaces: [],
  designs: [],
  captures: [],
  current: {},
  computed: {},
  running: {},
  problems: {},
  tonnes: {},
  preparing: null,
  site: null,
  siteHeat: null,
  showDrafts: true,
  seriesCurrent: {},
  seriesInputs: {},
  spreads: {},
});

export const compareStore = createStore<CompareState>()(() => ({
  ...initial(),
  heat: { show3d: true, show2d: true, contours: false, item: null },
  dialog: null,
}));

export function useCompare<T>(selector: (s: CompareState) => T): T {
  return useStore(compareStore, selector);
}

const set = (patch: Partial<CompareState>) => {
  compareStore.setState(patch);
};
const get = () => compareStore.getState();

let engine: EngineClient | null = null;
let startEngine: () => EngineClient = startEngineWorker;
/** Tests hand in a port (a MessageChannel served by `serveEngine`). */
export function setEnginePort(port: EnginePort | null): void {
  engine?.dispose();
  engine = port ? connectEngine(port) : null;
}
/** Tests hand in how an engine is started (null: the module worker again). */
export function setEngineStarter(start: (() => EnginePort) | null): void {
  engine?.dispose();
  engine = null;
  startEngine = start ? () => connectEngine(start()) : startEngineWorker;
}
function client(): EngineClient {
  if (engine?.stopped()) {
    // the engine died (its requests failed with why): another one, told the same project, so the
    // next Recompute works without restarting the app
    const context = engine.context();
    engine = startEngine();
    if (context) engine.setContext(context);
  }
  engine ??= startEngine();
  return engine;
}

// ---------------------------------------------------------------- the project

export const ringOf = (points: readonly SitePoint[]): [number, number][] =>
  points.map((p) => [p[0], p[1]]);
const ringKey = (points: readonly SitePoint[]) => JSON.stringify(ringOf(points));

/** The survey a measurement is viewed on: its own for a survey-scoped one, else the latest. */
export const captureOf = (m: SurveyMeasurement): string | undefined =>
  m.scope.kind === 'survey' ? m.scope.capture : undefined;

/**
 * The other piles' outlines next to `ring` on `capture` (the engine's `neighbours`: an edge shared
 * with one is left out of the perimeter base), from the measurements as they are now. `capture`
 * absent: the date the measurement is viewed on (its own survey, else the latest).
 */
export function neighboursOf(
  m: SurveyMeasurement,
  ring: readonly SitePoint[],
  capture?: string,
): [number, number][][] {
  const date = capture ?? captureOf(m) ?? get().captures.at(-1)?.id;
  const all = measureStore.getState().file.measurements;
  return pileNeighbours({ id: m.id, scope: m.scope, points: ring }, all, date);
}

/** Only when there are any: a request without them is the one it always was. */
const withNeighbours = (nb: [number, number][][]) => (nb.length > 0 ? { neighbours: nb } : {});

/**
 * What the pile's figures over time depend on beyond its own inputs: the outlines of the piles it
 * shares an edge with on each date (a neighbour moved, its dates are worked out again).
 */
export function neighboursKey(m: SurveyMeasurement): string {
  if (m.family !== 'polygon' || m.points.length < 3) return '';
  return JSON.stringify(get().captures.map((c) => neighboursOf(m, outlineOn(m, c.id), c.id)));
}

/** Load the open project's surfaces and designs and hand them to the engine. */
export async function loadCompare(
  project: { id: string; root: string; manifest: ProjectManifest } | null,
): Promise<void> {
  const id = project?.id ?? null;
  if (id === get().projectId && get().status !== 'error' && id !== null) return;
  carriedInputs.clear();
  set({
    ...initial(),
    projectId: id,
    root: project?.root ?? null,
    status: id ? 'loading' : 'idle',
  });
  if (!project) return;
  const captures = [...project.manifest.captures]
    .sort((a, b) => (a.date === b.date ? 0 : a.date < b.date ? -1 : 1))
    .map((c) => ({ id: c.id, label: c.label, date: c.date }));
  set({ captures });
  await refreshSurfaces();
}

/**
 * Read `survey:surfaces` and `survey:readDesigns` again (after a prepare job). The QA store's
 * surfaces (the cards' dates) are read again with them. A read that fails while the surfaces read
 * before are in place (a refresh in the background) keeps them and the store ready; only the first
 * read of a project's surfaces fails the store.
 */
export async function refreshSurfaces(): Promise<void> {
  void refreshQa();
  const projectId = get().projectId;
  if (!projectId) return;
  const [s, d] = await Promise.all([
    bridge.call('survey:surfaces', { projectId }),
    bridge.call('survey:readDesigns', { projectId }),
  ]);
  if (get().projectId !== projectId) return;
  if (!s.ok || !s.value.ok) {
    const error = !s.ok ? s.error : s.value.ok ? '' : s.value.error;
    if (get().status === 'ready') {
      console.warn(`The survey surfaces could not be read again: ${error}`);
      return;
    }
    set({ status: 'error', error });
    return;
  }
  const surfaces = s.value.surfaces;
  // designs are G6's; without them the pickers offer surveys and bases only
  const designs = d.ok && d.value.ok ? d.value.file.designs : [];
  pushContext(projectId, surfaces, designs);
  set({ status: 'ready', error: null, surfaces, designs, current: {} });
  scheduleCheck();
}

/** Every date's line-up as one key, the turn included: a change of any of it pushes the context again. */
function shiftsKeyOf(manifest: Parameters<typeof captureShift>[0] | null | undefined): string {
  if (!manifest) return '';
  return manifest.captures
    .map((c) => `${c.id}:${shiftKey(captureShift(manifest, c.id))}`)
    .join(';');
}

function pushContext(projectId: string, surfaces: HeightTiles[], designs: DesignEntry[]): void {
  const settings = measureStore.getState().settings;
  const manifest = workspace.getState().project?.manifest;
  client().setContext({
    base: `aio://project/${encodeURIComponent(projectId)}/`,
    surfaces,
    captures: get().captures.map((c) => c.id),
    designs,
    // the same line-ups the report's engine is handed (`seriesRule.ts`)
    ...lineUps(manifest),
    site: {
      verticalDatum: settings.verticalDatum,
      ...(settings.calibration ? { calibration: settings.calibration } : {}),
    },
  });
}

/**
 * The site's designs changed (a vertical offset, an archived layer, an import): hand them to the
 * engine, whose fingerprints then mark the affected results stale (the focused one is computed).
 */
export function takeDesigns(file: { designs: DesignEntry[] }): void {
  const { projectId, status, surfaces } = get();
  if (!projectId || status !== 'ready') return;
  if (JSON.stringify(file.designs) === JSON.stringify(get().designs)) return;
  pushContext(projectId, surfaces, file.designs);
  set({ designs: file.designs, current: {} });
  scheduleCheck();
}

// ---------------------------------------------------------------- staleness

/** True when the stored result for an item is not current (marked, or its inputs changed). */
export function isStale(
  s: Pick<CompareState, 'current'>,
  m: SurveyMeasurement,
  r: ComparisonResult,
): boolean {
  // a kit figure carried over is what it was: shown as from an earlier version, never stale
  if (r.carried) return false;
  if (r.status === 'stale') return true;
  const k = m.items.findIndex((it) => it.id === r.item);
  const fp = s.current[m.id]?.[k];
  return fp !== undefined && fp !== r.fingerprint;
}

/** Work out the current fingerprints of polygon measurements with items (all, or some). */
export async function checkFingerprints(ids?: readonly string[]): Promise<void> {
  if (get().status !== 'ready') return;
  const ms = measureStore
    .getState()
    .file.measurements.filter(
      (m) => m.family === 'polygon' && m.items.length > 0 && (!ids || ids.includes(m.id)),
    );
  const out: Record<string, string[]> = {};
  for (const m of ms) {
    const capture = captureOf(m);
    try {
      out[m.id] = await client().fingerprints({
        ring: ringOf(m.points),
        items: m.items,
        ...(capture !== undefined ? { capture } : {}),
        ...withNeighbours(neighboursOf(m, m.points)),
      });
    } catch {
      // the engine stopped: leave the stored status as it is
    }
  }
  set({ current: { ...get().current, ...out } });
}

// ---------------------------------------------------------------- computing

const HEAT_CELLS = 192;

/**
 * Compute a measurement's items now. Stored on the measurement unless `live` (dragging): then the
 * numbers are shown and the stored results stay until the edit ends. `auto` (the app computing
 * the focused polygon on its own) stores them as derived results that leave the file saved; a
 * person's Recompute stores them as an edit.
 */
export function compute(
  id: string,
  opts: {
    live?: boolean;
    auto?: boolean;
    heatOnly?: boolean;
    keepCarried?: boolean;
    points?: readonly SitePoint[];
    /**
     * The accepted measurement, with the inputs it was computed from, goes here instead of being
     * stored as an edit (`acceptCarriedQuietly`); only when every carried item computed in full.
     */
    onAccepted?: (a: KitAccepted) => void;
  } = {},
): Promise<RunReply | null> {
  const run = computeNow(id, opts);
  flights.set(id, run);
  void run.finally(() => {
    if (flights.get(id) === run) flights.delete(id);
  });
  return run;
}

/**
 * The latest run in flight of each measurement. The check after a change waits for the focused
 * measurement's run rather than starting its own over it: a run with the same key cancels the
 * one before, so the check used to throw a person's Recompute away (it answered null) and store
 * its own derived result in its place.
 */
const flights = new Map<string, Promise<RunReply | null>>();
/** The newest run started for each measurement (to tell a replaced run from a stopped one). */
const latestRun = new Map<string, number>();
let runSeq = 0;

async function computeNow(
  id: string,
  opts: {
    live?: boolean;
    auto?: boolean;
    heatOnly?: boolean;
    keepCarried?: boolean;
    points?: readonly SitePoint[];
    /** As `compute`'s. */
    onAccepted?: (a: KitAccepted) => void;
  },
): Promise<RunReply | null> {
  const m = measureStore.getState().file.measurements.find((x) => x.id === id);
  if (m?.family !== 'polygon' || m.items.length === 0 || get().status !== 'ready') return null;
  const points = opts.points ?? m.points;
  if (points.length < 3) return null;
  // the app on its own, and Recompute all (`keepCarried`), keep a carried kit figure unless the
  // person edited its points or items since (taken as accepting the standard base); a person's
  // Recompute of the one pile always accepts it
  const keeping = opts.auto === true || (opts.keepCarried === true && hasCarried(m));
  const accepting = !keeping || acceptedByEdit(m);
  set({ running: { ...get().running, [id]: true } });
  const mine = ++runSeq;
  latestRun.set(id, mine);
  const asked = inputsKey(m, opts.points === undefined);
  try {
    const capture = captureOf(m);
    const toleranceM = measureStore.getState().settings.deadbandM;
    const r = await client().run(
      {
        ring: ringOf(points),
        items: m.items,
        ...(capture !== undefined ? { capture } : {}),
        heat: HEAT_CELLS,
        ...(toleranceM !== undefined ? { toleranceM } : {}),
        ...withNeighbours(neighboursOf(m, points)),
      },
      id,
    );
    const live = opts.live === true;
    const problems = Object.fromEntries(Object.entries(get().problems).filter(([k]) => k !== id));
    // the items (or the ring) changed while it ran: these numbers are for what was asked, not for
    // what the measurement is now, so nothing is stored or taken as current; the change itself
    // schedules the next run (an older answer stored here showed as current until then)
    const now = measureStore.getState().file.measurements.find((x) => x.id === id);
    if (!now || inputsKey(now, opts.points === undefined) !== asked) {
      set({ running: { ...get().running, [id]: false }, problems });
      return r;
    }
    // the app's own acceptance takes only figures computed in full for every carried item: one
    // refused or partial (part of the pile off a surface) keeps the pile as it is, its kit figures
    // and their dates included, and nothing is stored
    const quietRefused =
      opts.onAccepted !== undefined &&
      !now.items.every(
        (it) =>
          !carriedItem(now, it.id) || r.results.some((x) => x.item === it.id && x.status === 'ok'),
      );
    // a carried item the person has not accepted shows its stored figure, not the engine's
    const keepCarried = opts.heatOnly === true || (keeping && !accepting) || quietRefused;
    const shown = keepCarried
      ? r.results.flatMap((x) => {
          if (!carriedItem(now, x.item)) return [x];
          const kept = now.results.find((y) => y.item === x.item);
          return kept ? [kept] : [];
        })
      : r.results;
    set({
      computed: {
        ...get().computed,
        [id]: {
          ringKey: ringKey(points),
          results: shown,
          heat: r.heat,
          shares: r.shares,
          ms: r.ms,
          live,
          ...(opts.heatOnly ? { heatOnly: true } : {}),
        },
      },
      running: { ...get().running, [id]: false },
      problems,
    });
    if (!live && !measureStore.getState().readOnly && !quietRefused) {
      const byItem = new Map(r.results.map((x) => [x.item, x]));
      const merged = (x: SurveyMeasurement, keep: boolean) =>
        x.items.flatMap((it) => {
          const old = x.results.find((y) => y.item === it.id);
          // the app never replaces a carried kit figure on its own (nor adds one to an absent
          // pile's): only the person does
          const res = keep && carriedItem(x, it.id) ? old : (byItem.get(it.id) ?? old);
          return res ? [res] : [];
        });
      if (!accepting) setComputedResults(id, (x) => merged(x, true));
      else if (opts.auto && !hasCarried(now)) setComputedResults(id, (x) => merged(x, false));
      else if (opts.onAccepted) {
        // accepted by the app once the surfaces exist: handed back, stored as a migration
        const next = acceptStandard(now, r.results);
        opts.onAccepted({ m: { ...next, results: merged(next, false) }, key: asked });
      } else
        updateMeasurement(id, (x) => {
          // accepted: the carried kit figures are replaced and kept as "was"
          const next = acceptStandard(x, r.results);
          return { ...next, results: merged(next, false) };
        });
      if (accepting) carriedInputs.delete(id);
      set({
        current: { ...get().current, [id]: r.results.map((x) => x.fingerprint) },
      });
    }
    return r;
  } catch (e) {
    if (e instanceof RunCancelled) {
      // replaced by a newer run of this measurement: that one says when it is done. Cancelled
      // with nothing in its place (the engine stopped): it is no longer running
      if (latestRun.get(id) === mine) set({ running: { ...get().running, [id]: false } });
      return null;
    }
    set({
      running: { ...get().running, [id]: false },
      problems: { ...get().problems, [id]: e instanceof Error ? e.message : String(e) },
    });
    return null;
  }
}

/** What a run computes for: the items (their labels aside) and, unless given, the ring. */
const inputsKey = (m: SurveyMeasurement, withRing: boolean): string =>
  measureInputsKey(m, withRing);

/**
 * "Recompute with the standard base" (W3): the person's Recompute of a measurement whose figure
 * was carried over from the kit. The engine's result replaces the carried one, which is kept in
 * the measurement's history ("was X m³"), and the carried figures over time go (their dates are
 * computed on demand). An edit. Null when done (or replaced by a newer run, which stores), else
 * why not: a read-only project, the engine not ready, an outline of fewer than 3 points.
 */
export async function recomputeStandard(id: string): Promise<string | null> {
  if (measureStore.getState().readOnly) return 'This project is read-only.';
  if (get().status !== 'ready') return t('vol.card.engineStarting');
  const m = measureStore.getState().file.measurements.find((x) => x.id === id);
  if (m && m.points.length < 3) return t('vol.card.needPoints');
  set({ problems: Object.fromEntries(Object.entries(get().problems).filter(([k]) => k !== id)) });
  const r = await compute(id);
  if (r) return null;
  // no answer and no problem: replaced by a newer run (that one stores)
  return get().problems[id] ?? null;
}

/** The measurement still holds a figure carried from an earlier version (now or over time). */
export const hasCarried = (m: SurveyMeasurement): boolean =>
  m.results.some((r) => r.carried !== undefined) ||
  (m.series ?? []).some((r) => r.carried !== undefined);

/**
 * The measurement holds a figure carried from an earlier version that Recompute all keeps: one
 * whose points or items were not edited since (an edit is taken as accepting the standard base).
 */
export const keepsCarried = (m: SurveyMeasurement): boolean => hasCarried(m) && !acceptedByEdit(m);

/**
 * The inputs (`inputsKey`) each measurement with carried kit figures had when first seen. Its
 * points or items edited since: the person is taken as accepting the standard base.
 */
const carriedInputs = new Map<string, string>();

function noteCarried(ms: readonly SurveyMeasurement[]): void {
  for (const m of ms)
    if (!carriedInputs.has(m.id) && hasCarried(m)) carriedInputs.set(m.id, inputsKey(m, true));
}

function acceptedByEdit(m: SurveyMeasurement): boolean {
  if (!hasCarried(m)) return false;
  const was = carriedInputs.get(m.id);
  return was !== undefined && was !== inputsKey(m, true);
}

/**
 * The measurement with the engine's results accepted in place of the carried kit figures: each
 * carried figure is kept as "was" (`replaceWithStandard`). A pile absent on the latest date (no
 * stored result, carried figures over time) keeps its latest carried figure as "was" too.
 */
function acceptStandard(
  m: SurveyMeasurement,
  results: readonly ComparisonResult[],
): SurveyMeasurement {
  const order = get().captures.map((c) => c.id);
  let next = m;
  for (const res of results) {
    if (!carriedItem(next, res.item)) continue;
    const old = next.results.find((y) => y.item === res.item);
    if (old) {
      next = replaceWithStandard(next, res);
      continue;
    }
    const rows = (next.series ?? []).filter((y) => y.item === res.item && y.carried);
    const latest = rows.reduce<ComparisonResult | undefined>(
      (a, y) => (!a || order.indexOf(seriesDate(y)) >= order.indexOf(seriesDate(a)) ? y : a),
      undefined,
    );
    next = replaceWithStandard(
      latest ? { ...next, results: [...next.results, latest] } : next,
      res,
    );
  }
  return next;
}

/**
 * Compute every item of every given measurement (Recompute all, bulk). A figure carried from an
 * earlier version stays as it is: replacing those is `recomputeCarried`, its own confirmed action.
 */
export async function computeAll(
  ids: readonly string[],
  opts: { auto?: boolean } = {},
): Promise<void> {
  for (const id of ids) await compute(id, { ...opts, keepCarried: true });
}

/** The given measurements that still hold a figure carried from an earlier version. */
export function carriedIds(ids: readonly string[]): string[] {
  const all = measureStore.getState().file.measurements;
  return ids.filter((id) => {
    const m = all.find((x) => x.id === id);
    return m !== undefined && hasCarried(m);
  });
}

/**
 * "Recompute N earlier-version piles with the standard base": `recomputeStandard` for each of
 * the given measurements that holds a carried figure. The reasons any could not be done.
 */
export async function recomputeCarried(ids: readonly string[]): Promise<string[]> {
  const why: string[] = [];
  for (const id of carriedIds(ids)) {
    const r = await recomputeStandard(id);
    if (r) why.push(r);
  }
  return why;
}

/**
 * The app's own acceptance of the standard base for the given converted piles once their surfaces
 * are ready (ADR 0013 point 4): computed as `recomputeCarried` does, kept with the kit figure as
 * was, but stored as a migration (`acceptKitQuietly`): written on the saved baseline, no edit, no
 * undo step. A pile whose carried items do not all compute in full (refused, or partly off a
 * surface) stays carried, as does one edited while it ran. Nothing in a read-only project or
 * before the engine is ready. The ids accepted.
 */
export async function acceptCarriedQuietly(ids: readonly string[]): Promise<string[]> {
  const ms = measureStore.getState();
  const projectId = ms.projectId;
  if (!projectId || ms.readOnly || ms.status !== 'ready' || get().status !== 'ready') return [];
  const done: KitAccepted[] = [];
  for (const id of carriedIds(ids)) {
    await compute(id, {
      onAccepted: (a) => {
        done.push(a);
      },
    });
  }
  return acceptKitQuietly(projectId, done);
}

// ---------------------------------------------------------------- results over time (W4)

/**
 * True when a stored per-date result is not current: marked stale, or its date's inputs changed
 * since (its fingerprint is not the one `computeSeries` last worked out). A carried kit figure
 * is never stale.
 */
export function seriesStale(m: SurveyMeasurement, r: ComparisonResult): boolean {
  if (r.carried) return false;
  if (r.status === 'stale') return true;
  // the points or items changed since the dates were looked at: stale until computed again
  const inputs = get().seriesInputs[m.id];
  if (inputs !== undefined && inputs !== inputsKey(m, true)) return true;
  const fp = get().seriesCurrent[m.id]?.[seriesKeyOf(r)];
  return fp !== undefined && fp !== r.fingerprint;
}

/** The series run of each measurement in flight: a second ask waits, then looks again. */
const seriesFlights = new Map<string, Promise<boolean>>();

/**
 * Compute a measurement's volume per survey date (all dates, or `opts.captures`): only the dates
 * whose row is missing or stale, for each item with a `current` side. Stored per date with its
 * fingerprint (`setSeries`: derived, not an edit). A read-only project (a package) works its dates
 * out too, held in memory and never written. A run the
 * measurement outgrew (its items or ring changed while it ran) stores nothing. Nothing for an item
 * with carried kit figures: its chart shows the kit's history until the person accepts the
 * standard base (no mixed series). True when something was stored.
 */
export function computeSeries(id: string, opts: { captures?: string[] } = {}): Promise<boolean> {
  const before = seriesFlights.get(id) ?? Promise.resolve(false);
  const run = before.catch(() => false).then(() => computeSeriesNow(id, opts));
  seriesFlights.set(id, run);
  void run
    .finally(() => {
      if (seriesFlights.get(id) === run) seriesFlights.delete(id);
    })
    .catch(() => undefined);
  return run;
}

async function computeSeriesNow(id: string, opts: { captures?: string[] }): Promise<boolean> {
  // a read-only project (a package) works its dates out too: held in memory, never written
  if (get().status !== 'ready') return false;
  const m = measureStore.getState().file.measurements.find((x) => x.id === id);
  if (m?.family !== 'polygon' || m.points.length < 3) return false;
  const items = m.items.filter((it) => seriesApplies(it) && !carriedItem(m, it.id));
  // every date is fingerprinted (so `seriesCurrent` is whole for these inputs); the asked are run
  const captures = get().captures.map((c) => c.id);
  const wanted = new Set(opts.captures ?? captures);
  if (items.length === 0 || captures.length === 0) return false;
  const scope = captureOf(m);
  // each survey date is worked out inside that date's own outline (bug 1b): one run per outline
  // and with the piles next to it on that date: a run per outline and set of neighbours
  const runs = seriesRequests(m, captures).flatMap((run) => {
    const byKey = new Map<
      string,
      { ring: readonly SitePoint[]; captures: string[]; nb: [number, number][][] }
    >();
    for (const c of run.captures) {
      const nb = neighboursOf(m, run.ring, c);
      const key = JSON.stringify(nb);
      const known = byKey.get(key);
      if (known) known.captures.push(c);
      else byKey.set(key, { ring: run.ring, captures: [c], nb });
    }
    return [...byKey.values()];
  });
  const asked = inputsKey(m, true);
  const prints: Record<string, string> = {};
  const out: ComparisonResult[] = [];
  try {
    for (const item of items) {
      for (const run of runs) {
        const ring = ringOf(run.ring);
        const req = {
          ring,
          item,
          captures: run.captures,
          ...(scope !== undefined ? { scope } : {}),
          ...withNeighbours(run.nb),
        };
        const fps = await client().seriesFingerprints(req);
        run.captures.forEach((c, j) => {
          const fp = fps[j];
          if (fp !== undefined) prints[`${item.id} ${c}`] = fp;
        });
        const need = datesToRun(m, item.id, run.captures, fps, wanted);
        if (need.length > 0)
          out.push(
            ...(await client().series({ ...req, captures: need }, `series:${id}:${item.id}`)),
          );
      }
    }
  } catch (e) {
    // replaced by a newer run of the same item: that one stores its dates
    if (e instanceof RunCancelled) return false;
    throw e;
  }
  const now = measureStore.getState().file.measurements.find((x) => x.id === id);
  if (!now || inputsKey(now, true) !== asked) return false;
  set({
    seriesCurrent: { ...get().seriesCurrent, [id]: prints },
    seriesInputs: { ...get().seriesInputs, [id]: asked },
  });
  if (out.length === 0) return false;
  setSeries(id, out);
  return true;
}

// ---------------------------------------------------------------- the spread across bases (W3)

/**
 * The item a measurement's spread is for: its first, when its base is one of `SPREAD_BASES` and
 * its figure is not carried from the kit (the spread was not worked out from that figure).
 */
export function spreadItem(m: SurveyMeasurement): ComparisonItem | null {
  const it = m.family === 'polygon' ? m.items[0] : undefined;
  if (!it || carriedItem(m, it.id)) return null;
  const f = it.from;
  const ok = SPREAD_BASES.some(
    (b) =>
      b.kind === f.kind &&
      (b.kind !== 'reference' || (f.kind === 'reference' && f.mode === b.mode)),
  );
  return ok ? it : null;
}

/** Spread runs in flight, by measurement and item fingerprint (one run per fingerprint). */
const spreadFlights = new Map<string, Promise<BaseSpread | null>>();

/**
 * The spread across bases of a measurement's first item (W3), worked out once per item
 * fingerprint and kept in `spreads` (never stored on the measurement). Null without one: a base
 * outside `SPREAD_BASES`, too few bases, a zero mean, or a read-only project.
 */
export async function computeSpread(id: string): Promise<BaseSpread | null> {
  if (measureStore.getState().readOnly || get().status !== 'ready') return null;
  const m = measureStore.getState().file.measurements.find((x) => x.id === id);
  const item = m ? spreadItem(m) : null;
  if (!m || !item || m.points.length < 3) return null;
  const capture = captureOf(m);
  const ring = ringOf(m.points);
  const at = {
    ...(capture !== undefined ? { capture } : {}),
    ...withNeighbours(neighboursOf(m, m.points)),
  };
  let fp: string | undefined;
  try {
    [fp] = await client().fingerprints({ ring, items: [item], ...at });
  } catch {
    return null;
  }
  const key = `${id} ${fp ?? ''}`;
  const known = get().spreads[id];
  if (known?.key === key && known.value !== 'computing') return known.value;
  let run = spreadFlights.get(key);
  if (!run) {
    run = client().spread({ ring, item, ...at }, `spread:${id}`);
    spreadFlights.set(key, run);
    set({ spreads: { ...get().spreads, [id]: { key, value: 'computing' } } });
  }
  try {
    const value = await run;
    if (get().spreads[id]?.key === key)
      set({ spreads: { ...get().spreads, [id]: { key, value } } });
    return value;
  } catch (e) {
    if (e instanceof RunCancelled) {
      // replaced by a newer run, or the engine stopped: not computing any more
      if (get().spreads[id]?.key === key && get().spreads[id]?.value === 'computing')
        set({
          spreads: Object.fromEntries(Object.entries(get().spreads).filter(([k]) => k !== id)),
        });
      return null;
    }
    // the renderer's console is the app's log (main writes it to renderer.log)
    console.warn(`The spread across bases of ${id} could not be computed`, e);
    if (get().spreads[id]?.key === key)
      set({ spreads: { ...get().spreads, [id]: { key, value: null } } });
    return null;
  } finally {
    spreadFlights.delete(key);
  }
}

/**
 * The spread across bases of a measurement's first item: worked out when shown and again when
 * its inputs change ('computing' meanwhile), null without one. Not stored.
 */
export function useSpread(id: string): BaseSpread | null | 'computing' {
  const m = useStore(measureStore, (s) => s.file.measurements.find((x) => x.id === id));
  const readOnly = useStore(measureStore, (s) => s.readOnly);
  const ready = useCompare((s) => s.status === 'ready');
  const fp = useCompare((s) => s.current[id]?.[0]);
  const entry = useCompare((s) => s.spreads[id]);
  const item = m ? spreadItem(m) : null;
  const points = m?.points;
  useEffect(() => {
    if (ready && !readOnly && item) void computeSpread(id);
  }, [id, item, points, fp, ready, readOnly]);
  if (readOnly || !item) return null;
  return entry?.value ?? 'computing';
}

// ---------------------------------------------------------------- following the focus

let timer: ReturnType<typeof setTimeout> | null = null;
let liveTimer: ReturnType<typeof setTimeout> | null = null;

/** After a change: refresh the fingerprints, and compute the focused polygon when it is stale. */
export function scheduleCheck(delayMs = 120): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    void (async () => {
      // a run of the focused measurement is still out: decide once it has answered
      const focus = measureStore.getState().focus;
      if (focus) await flights.get(focus);
      await checkFingerprints();
      const s = measureStore.getState();
      noteCarried(s.file.measurements);
      const m = s.file.measurements.find((x) => x.id === s.focus);
      if (m?.family !== 'polygon' || m.items.length === 0) return;
      const cur = get().current[m.id] ?? [];
      const accepted = acceptedByEdit(m);
      const needs = m.items.some((it, k) => {
        // a carried kit figure waits for the person: "Recompute with the standard base", or an
        // edit of its points or items
        if (!accepted && carriedItem(m, it.id)) return false;
        const r = m.results.find((x) => x.item === it.id);
        return !r || r.status === 'stale' || r.fingerprint !== cur[k];
      });
      const shown = get().computed[m.id];
      if (needs) await compute(m.id, { auto: true });
      else if (!shown || shown.live || shown.ringKey !== ringKey(m.points))
        // stored results are current: compute once more for the heat map only
        await compute(m.id, { live: true, heatOnly: true });
    })();
  }, delayMs);
}

/** While vertices are dragged: live numbers for the edited ring. */
function scheduleLive(id: string, points: readonly SitePoint[]): void {
  if (liveTimer) clearTimeout(liveTimer);
  liveTimer = setTimeout(() => {
    liveTimer = null;
    void compute(id, { live: true, points });
  }, 40);
}

/**
 * The vertices being edited as the saved runs see them. Editing happens where a measurement is
 * drawn (its date's shift added); every run, live or saved, reads the stored frame.
 */
export function editedStoredPoints(
  m: Pick<SurveyMeasurement, 'scope'>,
  edited: readonly SitePoint[],
  manifest: Parameters<typeof storedPoints>[2],
): SitePoint[] {
  return storedPoints(edited, m.scope, manifest);
}

let unsubscribe: (() => void) | null = null;
/** Follow the measurements store and the site's designs (once). */
export function followMeasurements(): () => void {
  if (unsubscribe) return unsubscribe;
  const offDesigns = designsStore.subscribe((s, prev) => {
    if (s.file && s.file !== prev.file && s.projectId === get().projectId) takeDesigns(s.file);
  });
  // a line-up changes the fingerprints: hand the engine the new shifts, then check again
  let shiftsKey = shiftsKeyOf(workspace.getState().project?.manifest);
  const offShifts = workspace.subscribe((ws, prev) => {
    if (ws.project === prev.project) return;
    const key = shiftsKeyOf(ws.project?.manifest);
    if (key === shiftsKey) return;
    shiftsKey = key;
    const { projectId, status, surfaces, designs } = get();
    if (!projectId || status !== 'ready') return;
    pushContext(projectId, surfaces, designs);
    scheduleCheck();
  });
  noteCarried(measureStore.getState().file.measurements);
  const off = measureStore.subscribe((s, prev) => {
    if (s.file !== prev.file) noteCarried(s.file.measurements);
    if (s.editing && s.focus && s.editing.points !== prev.editing?.points) {
      const m = s.file.measurements.find((x) => x.id === s.focus);
      if (m?.family === 'polygon' && m.items.length > 0 && s.editing.points.length >= 3)
        scheduleLive(
          m.id,
          editedStoredPoints(m, s.editing.points, workspace.getState().project?.manifest ?? null),
        );
    }
    if (
      s.file !== prev.file ||
      s.focus !== prev.focus ||
      s.settings !== prev.settings ||
      (s.editing === null) !== (prev.editing === null)
    )
      scheduleCheck();
  });
  unsubscribe = () => {
    off();
    offDesigns();
    offShifts();
    unsubscribe = null;
  };
  return unsubscribe;
}

/** The engine client (the whole-site regions run there too). */
export function engineClient(): EngineClient {
  return client();
}

export function setSite(site: SiteRun | null): void {
  set({ site });
}

export function patchSite(patch: Partial<SiteRun>): void {
  const cur = get().site;
  if (cur) set({ site: { ...cur, ...patch } });
}

export function setHeat(patch: Partial<HeatView>): void {
  set({ heat: { ...get().heat, ...patch } });
}

export function openCompareDialog(dialog: CompareDialog): void {
  set({ dialog });
}

export function setTonnes(id: string, tonnes: number | null): void {
  const next = Object.fromEntries(Object.entries(get().tonnes).filter(([k]) => k !== id));
  if (tonnes !== null && Number.isFinite(tonnes)) next[id] = tonnes;
  set({ tonnes: next });
}

// ---------------------------------------------------------------- preparing surfaces

const safeId = (s: string) =>
  s
    .replace(/[^A-Za-z0-9._-]/g, '-')
    .replace(/^[^A-Za-z0-9]+/, '')
    .slice(0, 80) || 'surface';

/**
 * `survey.prepare` parameters for every survey date without a prepared surface: its DSM raster,
 * else its point cloud (as the QA checks prepare one), each with its `capture`. A DSM with no date
 * is prepared too, unless `only` names the dates to cover.
 */
export function prepareParams(
  manifest: Pick<ProjectManifest, 'captures' | 'layers'>,
  prepared: readonly HeightTiles[],
  only?: readonly string[],
): SurveyPrepareParams | null {
  const haveLayer = new Set(prepared.flatMap((p) => ('layer' in p.source ? [p.source.layer] : [])));
  const haveDate = new Set(prepared.flatMap((p) => (p.capture ? [p.capture] : [])));
  const label = new Map(manifest.captures.map((c) => [c.id, c.label]));
  const wanted = only ? new Set(only) : null;
  const surfaces: SurveyPrepareParams['surfaces'] = [];
  const taken = new Set<string>();
  for (const l of manifest.layers) {
    if (l.kind !== 'raster' || l.role !== 'dsm' || l.capture || wanted || haveLayer.has(l.id))
      continue;
    surfaces.push({ id: safeId(l.id), name: l.name, source: { kind: 'dsm', layer: l.id } });
  }
  for (const c of manifest.captures) {
    if ((wanted && !wanted.has(c.id)) || haveDate.has(c.id) || taken.has(c.id)) continue;
    const source = sourceOfCapture(manifest, c.id);
    if (!source || haveLayer.has(source.layer)) continue;
    taken.add(c.id);
    surfaces.push({
      id: safeId(source.layer),
      name: `${label.get(c.id) ?? c.id} ${source.kind === 'dsm' ? 'DSM' : 'cloud'}`,
      source,
      capture: c.id,
    });
  }
  return surfaces.length ? { surfaces: surfaces.slice(0, 50) } : null;
}

/**
 * Make the kit DSM surfaces (`kitSurface.ts`) of the dates in `only` (every kit date when absent)
 * that lack a prepared surface, written through `survey:writeSurface`. The dates being made are
 * not published here (the caller does). An error sentence, or null.
 */
export async function makeKitSurfaces(
  projectId: string,
  manifest: Pick<ProjectManifest, 'captures' | 'layers' | 'crs'>,
  prepared: readonly HeightTiles[],
  only?: readonly string[],
  onPreparing?: (captures: readonly string[]) => void,
): Promise<{ made: string[]; error: string | null }> {
  const base = `aio://project/${encodeURIComponent(projectId)}/`;
  return prepareKitSurfaces(
    manifest,
    prepared,
    {
      readVolumes: async () => {
        const r = await bridge.call('project:readVolumes', { projectId });
        if (!r.ok) throw new Error(r.error);
        if (!r.value.ok) throw new Error(r.value.error);
        return r.value.volumes;
      },
      readText: (path) => fetchKitText(`${base}${path}`),
      write: async (tiles, files) => {
        const r = await bridge.call('survey:writeSurface', { projectId, tiles, files });
        if (!r.ok) return r.error;
        return r.value.ok ? null : r.value.error;
      },
      ...(onPreparing ? { onPreparing } : {}),
    },
    only,
  );
}

/**
 * The kit DSM surfaces of `only` made, the dates shown as preparing meanwhile, and the surfaces
 * read again and published when any was made (no job ends to do it). An error sentence, or null.
 */
async function prepareKitDates(
  projectId: string,
  manifest: Pick<ProjectManifest, 'captures' | 'layers' | 'crs'>,
  prepared: readonly HeightTiles[],
  only?: readonly string[],
): Promise<string | null> {
  const r = await makeKitSurfaces(projectId, manifest, prepared, only, (captures) => {
    if (preparedSurfaces.getState().projectId === projectId)
      preparedSurfaces.setState({ kitPreparing: [...captures] });
  });
  if (r.made.length > 0) {
    const s = await bridge.call('survey:surfaces', { projectId });
    if (s.ok && s.value.ok && preparedSurfaces.getState().projectId === projectId)
      preparedSurfaces.setState({ surfaces: s.value.surfaces });
    await refreshSurfaces();
  }
  return r.error;
}

/**
 * Start one `survey.prepare` job for the dates `captures` names that have no prepared surface yet
 * (a chip's Prepare). The surfaces are read again when it ends (`surfacesWatch`). An error
 * sentence, or null.
 */
export async function prepareDates(captures: readonly string[]): Promise<string | null> {
  const project = workspace.getState().project;
  if (!project) return t('lineUp.read.noProject');
  const s = await bridge.call('survey:surfaces', { projectId: project.id });
  if (!s.ok) return s.error;
  if (!s.value.ok) return s.value.error;
  const kitError = await prepareKitDates(project.id, project.manifest, s.value.surfaces, captures);
  const params = prepareParams(project.manifest, s.value.surfaces, captures);
  if (!params) return kitError;
  const r = await bridge.call('jobs:start', {
    pipeline: 'survey.prepare',
    project: project.root,
    params,
  });
  if (!r.ok) return r.error;
  return r.value.ok ? null : r.value.error;
}

/**
 * Start `survey.prepare` for the DSMs not prepared yet; the surfaces are read again when done. A
 * prepare job already at work on the project (the one started in the background when it opened,
 * or one asked for before) is preparing them: none is started beside it, which would write the
 * same surfaces twice at once.
 */
export async function prepareSurfaces(
  manifest: Pick<ProjectManifest, 'captures' | 'layers' | 'crs'>,
): Promise<string | null> {
  const { root, surfaces, projectId } = get();
  if (!root) return 'No project is open.';
  if (prepareRunningOn(jobs.getState().jobs, root)) return null;
  const kitError = projectId ? await prepareKitDates(projectId, manifest, surfaces) : null;
  const params = prepareParams(manifest, get().surfaces);
  if (!params) return kitError ?? 'Every survey surface is prepared.';
  const r = await bridge.call('jobs:start', { pipeline: 'survey.prepare', project: root, params });
  if (!r.ok) return r.error;
  if (!r.value.ok) return r.value.error;
  const jobId = r.value.job.id;
  set({ preparing: jobId });
  const aio = window.aio as typeof window.aio | undefined;
  const off = aio?.on('jobs:event', (e) => {
    if (e.type !== 'update' || e.job.id !== jobId) return;
    if (e.job.status === 'done' || e.job.status === 'failed' || e.job.status === 'cancelled') {
      off?.();
      set({
        preparing: null,
        ...(e.job.status === 'done'
          ? {}
          : { error: e.job.error ?? 'The surfaces could not be prepared.' }),
      });
      if (e.job.status === 'done') void refreshSurfaces();
    }
  });
  return null;
}
