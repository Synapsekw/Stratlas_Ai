/**
 * Comparisons in the renderer (M11 G4, PRD SRV-1 and SRV-2): the survey engine worker for the open
 * project, its prepared surfaces and designs, and the results of each measurement's comparison
 * items. The focused polygon is computed when its inputs change (its stored results' fingerprints
 * no longer match), and while its vertices are dragged (live numbers, not stored). A result whose
 * fingerprint no longer matches is shown as **Stale, recompute**, never as current. Results the
 * app computes on its own (on focus) are derived, not a person's edit: they do not mark the file
 * unsaved and are written with the next save; Recompute is the person's and is saved as an edit.
 */
import type { DraftRegion } from '@aio/survey';
import type {
  ComparisonResult,
  DesignEntry,
  HeightTiles,
  ProjectManifest,
  SitePoint,
  SurfaceRef,
  SurveyMeasurement,
  SurveyPrepareParams,
} from '@aio/schema';
import { createStore, useStore } from 'zustand';
import { bridge } from '../shell';
import { connectEngine, RunCancelled, startEngineWorker, type EngineClient } from './engineClient';
import type { EnginePort, HeatGrid, RunReply } from './engineProtocol';
import { measureStore, setComputedResults, updateMeasurement } from './measureStore';

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
  ms: number;
  live: boolean;
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
  dialog: CompareDialog;
  /** A tonnage typed into a measurement's weight calculator (display only, never stored). */
  tonnes: Record<string, number>;
  /** A running `survey.prepare` job. */
  preparing: string | null;
  site: SiteRun | null;
  /** Draft regions shown on the map (ticked to accept). */
  showDrafts: boolean;
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
  showDrafts: true,
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
/** Tests hand in a port (a MessageChannel served by `serveEngine`). */
export function setEnginePort(port: EnginePort | null): void {
  engine?.dispose();
  engine = port ? connectEngine(port) : null;
}
function client(): EngineClient {
  engine ??= startEngineWorker();
  return engine;
}

// ---------------------------------------------------------------- the project

export const ringOf = (points: readonly SitePoint[]): [number, number][] =>
  points.map((p) => [p[0], p[1]]);
const ringKey = (points: readonly SitePoint[]) => JSON.stringify(ringOf(points));

/** The survey a measurement is viewed on: its own for a survey-scoped one, else the latest. */
export const captureOf = (m: SurveyMeasurement): string | undefined =>
  m.scope.kind === 'survey' ? m.scope.capture : undefined;

/** Load the open project's surfaces and designs and hand them to the engine. */
export async function loadCompare(
  project: { id: string; root: string; manifest: ProjectManifest } | null,
): Promise<void> {
  const id = project?.id ?? null;
  if (id === get().projectId && get().status !== 'error' && id !== null) return;
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

/** Read `survey:surfaces` and `survey:readDesigns` again (after a prepare job). */
export async function refreshSurfaces(): Promise<void> {
  const projectId = get().projectId;
  if (!projectId) return;
  const [s, d] = await Promise.all([
    bridge.call('survey:surfaces', { projectId }),
    bridge.call('survey:readDesigns', { projectId }),
  ]);
  if (get().projectId !== projectId) return;
  if (!s.ok || !s.value.ok) {
    set({ status: 'error', error: !s.ok ? s.error : s.value.ok ? '' : s.value.error });
    return;
  }
  const surfaces = s.value.surfaces;
  // designs are G6's; without them the pickers offer surveys and bases only
  const designs = d.ok && d.value.ok ? d.value.file.designs : [];
  const settings = measureStore.getState().settings;
  client().setContext({
    base: `aio://project/${encodeURIComponent(projectId)}/`,
    surfaces,
    captures: get().captures.map((c) => c.id),
    designs,
    site: {
      verticalDatum: settings.verticalDatum,
      ...(settings.calibration ? { calibration: settings.calibration } : {}),
    },
  });
  set({ status: 'ready', error: null, surfaces, designs, current: {} });
  scheduleCheck();
}

// ---------------------------------------------------------------- staleness

/** True when the stored result for an item is not current (marked, or its inputs changed). */
export function isStale(
  s: Pick<CompareState, 'current'>,
  m: SurveyMeasurement,
  r: ComparisonResult,
): boolean {
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
export async function compute(
  id: string,
  opts: { live?: boolean; auto?: boolean; points?: readonly SitePoint[] } = {},
): Promise<RunReply | null> {
  const m = measureStore.getState().file.measurements.find((x) => x.id === id);
  if (m?.family !== 'polygon' || m.items.length === 0 || get().status !== 'ready') return null;
  const points = opts.points ?? m.points;
  if (points.length < 3) return null;
  set({ running: { ...get().running, [id]: true } });
  try {
    const capture = captureOf(m);
    const r = await client().run(
      {
        ring: ringOf(points),
        items: m.items,
        ...(capture !== undefined ? { capture } : {}),
        heat: HEAT_CELLS,
      },
      id,
    );
    const live = opts.live === true;
    const problems = Object.fromEntries(Object.entries(get().problems).filter(([k]) => k !== id));
    set({
      computed: {
        ...get().computed,
        [id]: { ringKey: ringKey(points), results: r.results, heat: r.heat, ms: r.ms, live },
      },
      running: { ...get().running, [id]: false },
      problems,
    });
    if (!live && !measureStore.getState().readOnly) {
      const byItem = new Map(r.results.map((x) => [x.item, x]));
      const merged = (x: SurveyMeasurement) =>
        x.items.flatMap((it) => {
          const res = byItem.get(it.id) ?? x.results.find((y) => y.item === it.id);
          return res ? [res] : [];
        });
      if (opts.auto) setComputedResults(id, merged);
      else updateMeasurement(id, (x) => ({ ...x, results: merged(x) }));
      set({
        current: { ...get().current, [id]: r.results.map((x) => x.fingerprint) },
      });
    }
    return r;
  } catch (e) {
    if (e instanceof RunCancelled) return null;
    set({
      running: { ...get().running, [id]: false },
      problems: { ...get().problems, [id]: e instanceof Error ? e.message : String(e) },
    });
    return null;
  }
}

/** Compute every item of every given measurement (Recompute all, bulk). */
export async function computeAll(ids: readonly string[]): Promise<void> {
  for (const id of ids) await compute(id);
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
      await checkFingerprints();
      const s = measureStore.getState();
      const m = s.file.measurements.find((x) => x.id === s.focus);
      if (m?.family !== 'polygon' || m.items.length === 0) return;
      const cur = get().current[m.id] ?? [];
      const needs = m.items.some((it, k) => {
        const r = m.results.find((x) => x.item === it.id);
        return !r || r.status === 'stale' || r.fingerprint !== cur[k];
      });
      const shown = get().computed[m.id];
      if (needs) await compute(m.id, { auto: true });
      else if (!shown || shown.live || shown.ringKey !== ringKey(m.points))
        // stored results are current: compute once more for the heat map only
        await compute(m.id, { live: true });
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

let unsubscribe: (() => void) | null = null;
/** Follow the measurements store (once). */
export function followMeasurements(): () => void {
  if (unsubscribe) return unsubscribe;
  const off = measureStore.subscribe((s, prev) => {
    if (s.editing && s.focus && s.editing.points !== prev.editing?.points) {
      const m = s.file.measurements.find((x) => x.id === s.focus);
      if (m?.family === 'polygon' && m.items.length > 0 && s.editing.points.length >= 3)
        scheduleLive(m.id, s.editing.points);
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

/** `survey.prepare` parameters for every capture's DSM raster that is not prepared yet. */
export function prepareParams(
  manifest: Pick<ProjectManifest, 'captures' | 'layers'>,
  prepared: readonly HeightTiles[],
): SurveyPrepareParams | null {
  const have = new Set(prepared.flatMap((p) => (p.source.kind === 'dsm' ? [p.source.layer] : [])));
  const label = new Map(manifest.captures.map((c) => [c.id, c.label]));
  const surfaces: SurveyPrepareParams['surfaces'] = [];
  for (const l of manifest.layers) {
    if (l.kind !== 'raster' || l.role !== 'dsm' || have.has(l.id)) continue;
    const capture = l.capture;
    surfaces.push({
      id: safeId(l.id),
      name: capture ? `${label.get(capture) ?? capture} DSM` : l.name,
      source: { kind: 'dsm', layer: l.id },
      ...(capture ? { capture } : {}),
    });
  }
  return surfaces.length ? { surfaces: surfaces.slice(0, 50) } : null;
}

/** Start `survey.prepare` for the DSMs not prepared yet; the surfaces are read again when done. */
export async function prepareSurfaces(
  manifest: Pick<ProjectManifest, 'captures' | 'layers'>,
): Promise<string | null> {
  const { root, surfaces } = get();
  if (!root) return 'No project is open.';
  const params = prepareParams(manifest, surfaces);
  if (!params) return 'Every survey surface is prepared.';
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
