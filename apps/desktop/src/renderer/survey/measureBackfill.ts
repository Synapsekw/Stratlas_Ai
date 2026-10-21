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
import { compareStore } from './compareStore';
import { groundAt } from './dateSurfaces';
import { storedPoints } from './measureDates';
import type { Repicker } from './measureMove';
import { baseLayer } from './measureSource';
import { measureStore, replaceMeasurements, setMeasureNote } from './measureStore';

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

/** Projects whose backfill ran this session (or is running). */
const done = new Set<string>();

/** Tests: forget which projects were backfilled. */
export function forgetBackfills(): void {
  done.clear();
}

/** The open project when a backfill may run on it now, else null. */
function ready(): { id: string; manifest: ProjectManifest } | null {
  const ms = measureStore.getState();
  const cs = compareStore.getState();
  const project = workspace.getState().project;
  if (!project || ms.status !== 'ready' || ms.projectId !== project.id) return null;
  if (cs.status !== 'ready' || cs.projectId !== project.id) return null;
  if (ms.readOnly || isAnnotateReadOnly()) return null;
  if (project.manifest.captures.length === 0) return null;
  if (!ms.file.measurements.some((m) => m.scope.kind === 'site')) return null;
  return { id: project.id, manifest: project.manifest };
}

async function run(id: string, manifest: ProjectManifest): Promise<void> {
  const before = measureStore.getState().file.measurements.filter((m) => m.scope.kind === 'site');
  const filed = await planBackfill(before, {
    manifest,
    index: workspace.getState().dates ?? captureIndex(manifest),
    surfaces: compareStore.getState().surfaces,
    ground: (capture, drawn) => groundAt(capture, drawn, manifest),
  });
  const now = ready();
  const current = new Map(measureStore.getState().file.measurements.map((m) => [m.id, m]));
  // another project, a read-only file, or the measurements changed while the heights were read:
  // nothing is written, and the next change tries again
  if (now?.id !== id || before.some((m) => current.get(m.id) !== m)) {
    done.delete(id);
    return;
  }
  if (filed.length === 0) return;
  const seq = replaceMeasurements(filed, { undoable: true });
  if (seq === null) return;
  setMeasureNote({
    text: t('tree.measure.backfill.done', { count: filed.length }),
    danger: false,
    undo: true,
  });
}

/**
 * File older measurements under their survey dates once per project and session: when the
 * measurements and the prepared surfaces are both loaded for the open project, it has survey
 * dates and at least one site-wide measurement, and nothing is read-only (a package or a
 * look-only reviewer). One undoable edit and one note; nothing filed, no note. Undo puts them back
 * and it does not run again. Returns unsubscribe.
 */
export function followBackfill(): () => void {
  const check = () => {
    const p = ready();
    if (!p || done.has(p.id)) return;
    done.add(p.id);
    void run(p.id, p.manifest).catch(() => {
      done.delete(p.id);
    });
  };
  const off = [
    measureStore.subscribe(check),
    compareStore.subscribe(check),
    workspace.subscribe(check),
  ];
  check();
  return () => {
    for (const o of off) o();
  };
}
