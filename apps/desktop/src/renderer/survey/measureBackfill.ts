/**
 * Files older measurements (the legacy `site` scope) under their survey dates, once per project
 * and session. A measurement whose source layer has a date goes to that date; any other goes to the
 * date whose prepared surface its stored heights clearly match. `planBackfill` is pure (the ground
 * heights come from `env.ground`); `followBackfill` runs it as one undoable edit with one note.
 */
import { isAnnotateReadOnly } from '@aio/annotate';
import type { HeightTiles, PickedOn, ProjectManifest, SurveyMeasurement } from '@aio/schema';
import { surfaceOfCapture } from '@aio/survey';
import { t } from '@aio/ui';
import { captureIndex, workspace, type CaptureIndex } from '@aio/workspace';
import { compareStore, computeAll } from './compareStore';
import { groundAt, hasPrepared } from './dateSurfaces';
import { storedPoints } from './measureDates';
import type { Repicker } from './measureMove';
import { baseLayer } from './measureSource';
import {
  measureStore,
  replaceMeasurements,
  setMeasureNote,
  type MeasureState,
} from './measureStore';
import {
  createMeasureVisibilityMemory,
  measureStorage,
  type MeasureVisibilityMemory,
} from './measureVisibility';

/** A stored height within this of a date's surface counts as picked on it (m). */
export const BACKFILL_TOL_M = 0.1;
/** How much worse every other prepared date must match for a match to be clear (m). */
export const BACKFILL_MARGIN_M = 0.25;

export interface BackfillEnv {
  manifest: Pick<ProjectManifest, 'captures' | 'layers' | 'origin'>;
  index: CaptureIndex;
  surfaces: readonly HeightTiles[];
  ground: Repicker['ground'];
}

const MODEL_KINDS: ReadonlySet<string> = new Set(['mesh', 'pointcloud']);

function median(xs: readonly number[]): number {
  if (xs.length === 0) return Number.POSITIVE_INFINITY;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 === 1 ? (s[mid] ?? Infinity) : ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2;
}

/** The measurement on `capture`, re-stored so it stays where it is drawn now. */
function filedOn(
  m: SurveyMeasurement,
  capture: string,
  layer: string | undefined,
  pickedOn: PickedOn[],
  manifest: BackfillEnv['manifest'],
): SurveyMeasurement {
  const scope = { kind: 'survey' as const, capture };
  const out: SurveyMeasurement = {
    ...m,
    scope,
    // a site-wide measurement is drawn where it is stored
    points: storedPoints(m.points, scope, manifest),
    pickedOn,
    // measured against its date's data now: the site-wide results are worked out again
    results: m.results.map((r) => ({ ...r, status: 'stale' as const })),
  };
  if (layer) out.source = { layer };
  else delete out.source;
  return out;
}

/**
 * The `site`-scoped measurements of `ms` that can be filed, rewritten onto their dates. One whose
 * source layer is dated goes to that date without sampling. Any other is sampled on every prepared
 * date: it goes to the one whose median |stored Z - surface Z| is at most `BACKFILL_TOL_M` while
 * every other prepared date's is at least `BACKFILL_MARGIN_M` larger; it takes that date's DSM
 * (else its base layer) as source and, per vertex, `'ground'` within the tolerance, else `'model'`.
 * The rest are left out (they stay under "Needs a date").
 */
export async function planBackfill(
  ms: readonly SurveyMeasurement[],
  env: BackfillEnv,
): Promise<SurveyMeasurement[]> {
  const { manifest, index, surfaces, ground } = env;
  const known = new Set(manifest.captures.map((c) => c.id));
  const prepared = manifest.captures
    .map((c) => ({ capture: c.id, surface: surfaceOfCapture(surfaces, c.id) }))
    .filter((p): p is { capture: string; surface: HeightTiles } => p.surface !== null);
  const out: SurveyMeasurement[] = [];
  for (const m of ms) {
    if (m.scope.kind !== 'site' || m.points.length === 0) continue;
    const layer = m.source?.layer;
    const dated = layer ? index.of[layer] : undefined;
    if (layer && dated && known.has(dated)) {
      const kind = manifest.layers.find((l) => l.id === layer)?.kind;
      const fallback: PickedOn = kind && MODEL_KINDS.has(kind) ? 'model' : 'ground';
      const pickedOn =
        m.pickedOn?.length === m.points.length ? [...m.pickedOn] : m.points.map(() => fallback);
      out.push(filedOn(m, dated, layer, pickedOn, manifest));
      continue;
    }
    if (prepared.length === 0) continue;
    const scored = await Promise.all(
      prepared.map(async (p) => {
        const z = await ground(p.capture, m.points);
        const off = m.points.map((q, i) => Math.abs(q[2] - (z[i] ?? Number.NaN)));
        return { ...p, off, score: median(off.filter((d) => Number.isFinite(d))) };
      }),
    );
    const best = scored.reduce((a, b) => (b.score < a.score ? b : a));
    if (!(best.score <= BACKFILL_TOL_M)) continue;
    const clear = scored.every((s) => s === best || s.score >= best.score + BACKFILL_MARGIN_M);
    if (!clear) continue;
    const src = best.surface.source;
    const source = src.kind === 'dsm' ? src.layer : baseLayer(index, manifest, best.capture);
    const pickedOn = best.off.map((d): PickedOn => (d <= BACKFILL_TOL_M ? 'ground' : 'model'));
    out.push(filedOn(m, best.capture, source, pickedOn, manifest));
  }
  return out;
}

// ---------------------------------------------------------------- the runner

/**
 * A project's backfill this session: `running`; `waiting` (it ran while no date had a prepared
 * surface and left site-wide measurements unfiled: it runs once more, height matching only, when
 * a date's surface is prepared); `done`. `filed` holds the ids it filed, never filed again (an
 * Undo puts them back for good); `undo` is its last filing while that can still be undone.
 */
interface Run {
  phase: 'running' | 'waiting' | 'done';
  filed: Set<string>;
  undo?: { seq: number; ids: readonly string[] };
}
const runs = new Map<string, Run>();

/** Where the measurements a person put back with Undo are remembered, per project. */
export const BACKFILL_DECLINED_KEY = 'quadrion.measure.backfillDeclined';
/**
 * The ids an Undo of the backfill put back, per project in this renderer's localStorage (view
 * state of this computer, never written to `measurements.json`): never filed again, in any session.
 */
let declined: MeasureVisibilityMemory = createMeasureVisibilityMemory(
  measureStorage(),
  BACKFILL_DECLINED_KEY,
);
/** Tests: remember declined ids here instead. */
export function setBackfillDeclined(m: MeasureVisibilityMemory): void {
  declined = m;
}

/** Tests: forget which projects were backfilled. */
export function forgetBackfills(): void {
  runs.clear();
}

const anyPrepared = (manifest: ProjectManifest, surfaces: readonly HeightTiles[]) =>
  manifest.captures.some((c) => hasPrepared(surfaces, c.id));

/** The open project when a backfill may run on it now, else null. */
function ready(): { id: string; manifest: ProjectManifest } | null {
  const ms = measureStore.getState();
  const cs = compareStore.getState();
  const project = workspace.getState().project;
  if (!project || ms.status !== 'ready' || ms.projectId !== project.id) return null;
  if (cs.status !== 'ready' || cs.projectId !== project.id) return null;
  if (ms.readOnly || isAnnotateReadOnly()) return null;
  if (project.manifest.captures.length === 0) return null;
  return { id: project.id, manifest: project.manifest };
}

/** The site-wide measurements the backfill may still file. */
function candidates(id: string, r: Run | undefined): SurveyMeasurement[] {
  const no = new Set(declined.load(id));
  return measureStore
    .getState()
    .file.measurements.filter(
      (m) => m.scope.kind === 'site' && !r?.filed.has(m.id) && !no.has(m.id),
    );
}

async function run(
  id: string,
  manifest: ProjectManifest,
  r: Run,
  was: Run['phase'] | null,
  retry: () => void,
): Promise<void> {
  const before = candidates(id, r);
  const surfaces = compareStore.getState().surfaces;
  const prepared = anyPrepared(manifest, surfaces);
  const filed = await planBackfill(before, {
    manifest,
    index: workspace.getState().dates ?? captureIndex(manifest),
    surfaces,
    ground: (capture, drawn) => groundAt(capture, drawn, manifest),
  });
  const current = new Map(measureStore.getState().file.measurements.map((m) => [m.id, m]));
  // another project, a read-only file, or the measurements changed while the heights were read:
  // nothing is written, and it tries again now
  if (ready()?.id !== id || before.some((m) => current.get(m.id) !== m)) {
    if (was) r.phase = was;
    else runs.delete(id);
    retry();
    return;
  }
  // with no prepared date nothing could be height matched: those wait for a prepared surface
  r.phase = prepared || filed.length === before.length ? 'done' : 'waiting';
  if (filed.length === 0) return;
  const seq = replaceMeasurements(filed, { undoable: true });
  if (seq === null) return;
  for (const m of filed) r.filed.add(m.id);
  r.undo = { seq, ids: filed.map((m) => m.id) };
  setMeasureNote({
    text: t('tree.measure.backfill.done', { count: filed.length }),
    danger: false,
    undo: true,
  });
  // measured against their date's data: the engine results are worked out again there, as derived
  // numbers (only the filing is an unsaved change)
  await computeAll(
    filed.map((m) => m.id),
    { auto: true },
  ).catch((e: unknown) => {
    console.warn('Recomputing the filed measurements failed', e);
  });
}

/**
 * File older measurements under their survey dates once per project and session: when the
 * measurements and the prepared surfaces are both loaded for the open project, it has survey
 * dates and at least one site-wide measurement, and nothing is read-only (a package or a
 * look-only reviewer). One undoable edit and one note; nothing filed, no note. While no date has a
 * prepared surface, the measurements it cannot match wait: it runs once more when one is
 * prepared. Undo (or Revert) puts them back and they are not filed again, in this session or a
 * later one. The recomputed results are derived numbers: only the filing is an unsaved change.
 * Returns unsubscribe.
 */
export function followBackfill(): () => void {
  const check = () => {
    const p = ready();
    if (!p) return;
    const r = runs.get(p.id);
    if (r && r.phase !== 'waiting') return;
    if (r && !anyPrepared(p.manifest, compareStore.getState().surfaces)) return;
    if (candidates(p.id, r).length === 0) return;
    const was = r?.phase ?? null;
    const next: Run = r ?? { phase: 'running', filed: new Set() };
    next.phase = 'running';
    runs.set(p.id, next);
    void run(p.id, p.manifest, next, was, check).catch((e: unknown) => {
      console.warn('Filing older measurements under their survey dates failed', e);
      if (was) next.phase = was;
      else runs.delete(p.id);
    });
  };
  // the backfill's Undo let go: the ones it put back under Needs a date are remembered as declined
  const watchUndo = (s: MeasureState, prev: MeasureState) => {
    for (const [id, r] of runs) {
      const u = r.undo;
      if (!u || prev.undoChange?.seq !== u.seq || s.undoChange?.seq === u.seq) continue;
      delete r.undo;
      if (s.projectId !== id) continue;
      const now = new Map(s.file.measurements.map((m) => [m.id, m]));
      const back = u.ids.filter((x) => now.get(x)?.scope.kind === 'site');
      if (back.length > 0) declined.save(id, [...new Set([...declined.load(id), ...back])]);
    }
  };
  const off = [
    measureStore.subscribe((s, prev) => {
      watchUndo(s, prev);
      check();
    }),
    compareStore.subscribe(check),
    workspace.subscribe(check),
  ];
  check();
  return () => {
    for (const o of off) o();
  };
}
