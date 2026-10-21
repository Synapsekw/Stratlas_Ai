/**
 * Plan a move of measurements to another survey date (pure: the re-picks come from `env.repick`).
 * A measurement moves by being measured again on the target date: each vertex is picked again
 * where it is drawn, on the target's counterpart of its source layer (`model` vertices) or on the
 * target's prepared ground (`ground` vertices). The plan is all or nothing: the first refusal
 * leaves every measurement as it was.
 */
import type {
  HeightTiles,
  PickedOn,
  ProjectManifest,
  SitePoint,
  SurfaceRef,
  SurveyMeasurement,
} from '@aio/schema';
import { isTelecomTool, surfaceOfCapture } from '@aio/survey';
import { counterpart, type CaptureIndex } from '@aio/workspace';
import { drawnPoints, storedPoints } from './measureDates';
import { baseLayer } from './measureSource';

export type MoveRefusal =
  | { kind: 'telecom' }
  | { kind: 'no-match'; id: string; layer: string }
  | { kind: 'unprepared'; capture: string }
  /** The target has no height map (DSM) to prepare, and a vertex or a comparison needs one. */
  | { kind: 'no-height-map'; capture: string }
  | { kind: 'not-loaded'; layer: string }
  | { kind: 'need-3d' }
  | { kind: 'hidden-layer'; layer: string }
  | { kind: 'no-data'; id: string }
  /** A comparison of two surveys would compare the target's surface with itself. */
  | { kind: 'same-surface'; id: string };

export type ModelPick =
  | { ok: true; z: Float64Array } // NaN: a miss
  | { ok: false; why: 'need-3d' | 'hidden-layer' | 'not-loaded' };

export interface Repicker {
  /** Ground heights on the date's prepared surface under drawn points (NaN: none). */
  ground(capture: string, drawn: readonly SitePoint[]): Promise<Float64Array>;
  /** Heights on a model layer under drawn points. */
  model(layer: string, drawn: readonly SitePoint[]): Promise<ModelPick>;
}

export interface MoveEnv {
  manifest: Pick<ProjectManifest, 'captures' | 'layers' | 'origin'>;
  index: CaptureIndex;
  surfaces: readonly HeightTiles[];
  repick: Repicker;
  /** Folder names in use under the target date. */
  folders: ReadonlySet<string>;
}

export type MovePlan =
  { ok: true; next: SurveyMeasurement[] } | { ok: false; refusal: MoveRefusal };

const MODEL_KINDS: ReadonlySet<string> = new Set(['mesh', 'pointcloud']);

/** The kind a vertex was picked on when the file does not say: a model layer's, else ground. */
function defaultKind(manifest: MoveEnv['manifest'], layer: string | undefined): PickedOn {
  const kind = manifest.layers.find((l) => l.id === layer)?.kind;
  return kind && MODEL_KINDS.has(kind) ? 'model' : 'ground';
}

/**
 * The capture a measurement belongs to, or null for a site-wide (Needs a date) one; a date no
 * longer in the project counts as none (it shows under Needs a date too).
 */
function captureOf(m: SurveyMeasurement, manifest: MoveEnv['manifest']): string | null {
  if (m.scope.kind !== 'survey') return null;
  const { capture } = m.scope;
  return manifest.captures.some((c) => c.id === capture) ? capture : null;
}

/** The folder kept when the target date has one of that name, else none. */
function withFolder(m: SurveyMeasurement, folders: ReadonlySet<string>): SurveyMeasurement {
  const f = m.folder?.trim();
  if (f && folders.has(f)) return m;
  const out = { ...m };
  delete out.folder;
  return out;
}

/** A surface ref of the old date pointed at the target's prepared surface; others stay. */
function rewriteRef(
  ref: SurfaceRef,
  surfaces: readonly HeightTiles[],
  from: string,
  to: string | undefined,
): SurfaceRef {
  if (ref.kind !== 'survey' || !to) return ref;
  const of = surfaces.find((s) => s.id === ref.surface)?.capture;
  return of === from ? { ...ref, surface: to } : ref;
}

/** Whether a comparison already compared one surface with itself before the move. */
const sameBefore = (it: SurveyMeasurement['items'][number] | undefined): boolean =>
  it?.from.kind === 'survey' && it.to.kind === 'survey' && it.from.surface === it.to.surface;

interface Remeasure {
  m: SurveyMeasurement;
  from: string;
  layer: string;
  kinds: PickedOn[];
  drawn: SitePoint[];
}

/**
 * Plan a move of `ms` to `capture`. Rules, in order: any antenna measurement refuses; every
 * source layer needs a counterpart on the target; the target needs a prepared surface when a
 * vertex is picked on the ground or a comparison reads the old date (none to prepare: its own
 * refusal); every
 * vertex is picked again by its kind and needs an answer. A measurement already on the target is
 * left out; a site-wide one is filed on the target without a re-pick.
 */
export async function planMoveToDate(
  ms: readonly SurveyMeasurement[],
  capture: string,
  env: MoveEnv,
): Promise<MovePlan> {
  const { manifest, index, surfaces, repick, folders } = env;
  if (ms.some((m) => isTelecomTool(m.tool))) return { ok: false, refusal: { kind: 'telecom' } };
  const target = { kind: 'survey' as const, capture };
  const filed: SurveyMeasurement[] = [];
  const todo: Remeasure[] = [];
  for (const m of ms) {
    const from = captureOf(m, manifest);
    if (from === capture) continue;
    if (from === null) {
      filed.push(m);
      continue;
    }
    const source = m.source?.layer ?? baseLayer(index, manifest, from);
    const layer = source ? counterpart(index, source, capture) : undefined;
    if (!layer) return { ok: false, refusal: { kind: 'no-match', id: m.id, layer: source ?? '' } };
    const fallback = defaultKind(manifest, source);
    const kinds =
      m.pickedOn?.length === m.points.length ? [...m.pickedOn] : m.points.map(() => fallback);
    todo.push({ m, from, layer, kinds, drawn: drawnPoints(m, manifest) });
  }
  // `hasPrepared` (dateSurfaces) without its store: the planner stays pure
  const surfaceTo = surfaceOfCapture(surfaces, capture)?.id;
  // the target's ground is needed by a ground vertex, or by a comparison of the old date
  const onDate = (ref: SurfaceRef, from: string) =>
    ref.kind === 'survey' && surfaces.find((s) => s.id === ref.surface)?.capture === from;
  const needsGround = todo.some(
    (r) =>
      r.kinds.includes('ground') ||
      r.m.items.some((it) => onDate(it.from, r.from) || onDate(it.to, r.from)),
  );
  if (needsGround && surfaceTo === undefined) {
    const dsm = manifest.layers.some(
      (l) =>
        l.kind === 'raster' &&
        l.role === 'dsm' &&
        (l.capture === capture || index.of[l.id] === capture),
    );
    return { ok: false, refusal: { kind: dsm ? 'unprepared' : 'no-height-map', capture } };
  }

  const next: SurveyMeasurement[] = [];
  for (const r of todo) {
    const z = new Float64Array(r.drawn.length).fill(Number.NaN);
    // the vertices of one kind: their indices and drawn points
    const at = (kind: PickedOn) => {
      const idx: number[] = [];
      const ps: SitePoint[] = [];
      r.drawn.forEach((p, i) => {
        if (r.kinds[i] !== kind) return;
        idx.push(i);
        ps.push(p);
      });
      return { idx, ps };
    };
    const models = at('model');
    if (models.idx.length > 0) {
      const pick = await repick.model(r.layer, models.ps);
      if (!pick.ok) {
        const refusal: MoveRefusal =
          pick.why === 'need-3d' ? { kind: 'need-3d' } : { kind: pick.why, layer: r.layer };
        return { ok: false, refusal };
      }
      models.idx.forEach((i, k) => (z[i] = pick.z[k] ?? Number.NaN));
    }
    const grounds = at('ground');
    if (grounds.idx.length > 0) {
      const h = await repick.ground(capture, grounds.ps);
      grounds.idx.forEach((i, k) => (z[i] = h[k] ?? Number.NaN));
    }
    if (z.some((v) => !Number.isFinite(v)))
      return { ok: false, refusal: { kind: 'no-data', id: r.m.id } };
    const drawn = r.drawn.map((p, i): SitePoint => [p[0], p[1], z[i] ?? p[2]]);
    const items = r.m.items.map((it) => ({
      ...it,
      from: rewriteRef(it.from, surfaces, r.from, surfaceTo),
      to: rewriteRef(it.to, surfaces, r.from, surfaceTo),
    }));
    // a comparison of the old date with the target would read 0 cut and fill: refused instead
    const self = (a: SurfaceRef, b: SurfaceRef) =>
      a.kind === 'survey' && b.kind === 'survey' && a.surface === b.surface;
    if (items.some((it, i) => self(it.from, it.to) && !sameBefore(r.m.items[i])))
      return { ok: false, refusal: { kind: 'same-surface', id: r.m.id } };
    const moved: SurveyMeasurement = {
      ...r.m,
      scope: target,
      source: { layer: r.layer },
      points: storedPoints(drawn, target, manifest),
      items,
      results: r.m.results.map((x) => ({ ...x, status: 'stale' as const })),
    };
    next.push(withFolder(moved, folders));
  }

  for (const m of filed) {
    // its own source stays when it is a layer of the target date (or common to every date)
    const own = m.source?.layer;
    const keep =
      own !== undefined &&
      manifest.layers.some((l) => l.id === own) &&
      (index.of[own] ?? capture) === capture;
    const layer = keep ? own : baseLayer(index, manifest, capture);
    const out: SurveyMeasurement = {
      ...m,
      scope: target,
      // a site-wide measurement is drawn where it is stored: re-stored, it stays there
      points: storedPoints(m.points, target, manifest),
      results: m.results.map((x) => ({ ...x, status: 'stale' as const })),
    };
    if (layer) out.source = { layer };
    else delete out.source;
    // its picks stay when they fit its points and its source (model picks need their own layer)
    const aligned = m.pickedOn?.length === m.points.length;
    if (!aligned || (!keep && m.pickedOn?.some((k) => k !== 'ground'))) delete out.pickedOn;
    next.push(withFolder(out, folders));
  }
  // in the order they were given
  const order = new Map(ms.map((m, i) => [m.id, i]));
  next.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  return { ok: true, next };
}
