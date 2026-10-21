/**
 * Runs date moves of measurements: feeds the planner (`measureMove.ts`) the open project, the
 * prepared surfaces and the 3D stage, applies the result as one undoable edit, recomputes the
 * moved measurements and posts one note in the sidebar. Also copies a measurement to another date
 * (measured again the same way) and follows a layer that is put on another date.
 */
import { isAnnotateReadOnly } from '@aio/annotate';
import { getActiveScene, type SceneHandle } from '@aio/engine';
import { localToProject, projectToLocal } from '@aio/geo';
import type { ProjectManifest, SitePoint, SurveyMeasurement } from '@aio/schema';
import { formatDate, t } from '@aio/ui';
import { captureIndex, workspace, type CaptureIndex } from '@aio/workspace';
import { Vector3, type Object3D } from 'three';
import { authorName } from '../author';
import { compareStore, computeAll } from './compareStore';
import { groundAt } from './dateSurfaces';
import {
  addMeasurement,
  measureStore,
  newMeasurementId,
  replaceMeasurements,
  setMeasureNote,
} from './measureStore';
import { planMoveToDate, type ModelPick, type MoveRefusal, type Repicker } from './measureMove';

export type MoveOutcome =
  { ok: true; moved: number; seq: number | null } | { ok: false; refusal: MoveRefusal };

type Dated = Pick<ProjectManifest, 'captures' | 'layers' | 'origin'>;

const NOTHING: MoveOutcome = { ok: true, moved: 0, seq: null };

/** Whether nothing may be written: a package, a look-only reviewer, or a file not read in full. */
function refused(): boolean {
  const s = measureStore.getState();
  return s.readOnly || s.status !== 'ready' || isAnnotateReadOnly();
}

const openProject = () => workspace.getState().project;
const indexOf = (manifest: ProjectManifest): CaptureIndex =>
  workspace.getState().dates ?? captureIndex(manifest);

// ---------------------------------------------------------------- the stage re-picker

const visibleChain = (o: Object3D | null): boolean => {
  for (let p = o; p; p = p.parent) if (!p.visible) return false;
  return true;
};

/** Cast straight down at each drawn point on one layer: site Z per point, NaN for a miss. */
function castDown(
  scene: SceneHandle,
  layer: string,
  drawn: readonly SitePoint[],
  origin: ProjectManifest['origin'],
): Float64Array {
  const top = scene.camera.position.y + 10_000;
  const down = new Vector3(0, -1, 0);
  return Float64Array.from(drawn, (p) => {
    const l = projectToLocal([p[0], p[1], 0], origin);
    const hit = scene.raycastRay(new Vector3(l[0], top, l[2]), down, { layer });
    return hit ? localToProject([hit.point.x, hit.point.y, hit.point.z], origin)[2] : Number.NaN;
  });
}

/**
 * A model layer's heights under drawn points, synchronously from start to end: a hidden mesh is
 * shown, cast at and hidden again with no await and no frame in between.
 */
function pickModel(layer: string, drawn: readonly SitePoint[]): ModelPick {
  const scene = getActiveScene();
  if (!scene) return { ok: false, why: 'need-3d' };
  const manifest = openProject()?.manifest;
  if (!manifest) return { ok: false, why: 'not-loaded' };
  const { origin } = manifest;
  const roots = scene.scene.children.filter((o) => o.userData.layerId === layer);
  const shown = scene.rayLayers ? scene.rayLayers().has(layer) : roots.some(visibleChain);
  if (shown) {
    let z: Float64Array;
    try {
      z = castDown(scene, layer, drawn, origin);
    } catch {
      return { ok: false, why: 'not-loaded' };
    }
    // no hit on every point: the layer has nothing there to measure on yet
    return z.every((v) => Number.isNaN(v)) ? { ok: false, why: 'not-loaded' } : { ok: true, z };
  }
  const kind = manifest.layers.find((l) => l.id === layer)?.kind;
  // a hidden cloud is not in the ray providers; a layer never loaded has no root
  if (kind === 'pointcloud' || roots.length === 0) return { ok: false, why: 'hidden-layer' };
  const flipped: Object3D[] = [];
  let z: Float64Array | null;
  try {
    for (const r of roots)
      for (let p: Object3D | null = r; p; p = p.parent)
        if (!p.visible) {
          p.visible = true;
          flipped.push(p);
        }
    z = castDown(scene, layer, drawn, origin);
  } catch {
    z = null;
  } finally {
    for (const p of flipped) p.visible = false;
  }
  if (!z || z.every((v) => Number.isNaN(v))) return { ok: false, why: 'not-loaded' };
  return { ok: true, z };
}

/**
 * The re-picker on the 3D stage. Ground heights come from the date's prepared surface. A model is
 * picked without changing what the person sees: a layer the stage casts at now is cast at; a mesh
 * that is loaded but hidden is shown, cast at and hidden again inside one synchronous block (the
 * stage draws only on animation frames, so no frame shows it); a hidden point cloud, or a layer
 * that was never loaded, is refused. With no 3D stage (the map view) a model cannot be picked.
 */
export function stageRepicker(): Repicker {
  return {
    ground(capture, drawn) {
      const manifest = openProject()?.manifest;
      if (!manifest) return Promise.resolve(new Float64Array(drawn.length).fill(Number.NaN));
      return groundAt(capture, drawn, manifest);
    },
    model: (layer, drawn) => Promise.resolve(pickModel(layer, drawn)),
  };
}

let repicker: Repicker | null = null;
/** Tests: re-pick with this instead of the stage (null: the stage again). */
export function setMoveRepicker(r: Repicker | null): void {
  repicker = r;
}

// ---------------------------------------------------------------- notes

const layerName = (manifest: Dated, id: string) =>
  manifest.layers.find((l) => l.id === id)?.name ?? id;
const dateName = (manifest: Dated, capture: string | undefined) => {
  const c = manifest.captures.find((x) => x.id === capture);
  return c ? formatDate(c.date) : (capture ?? '');
};

/**
 * What a refusal says in the sidebar. `target` is the date the measurements were dropped on (the
 * refusals that name the date they lack data on say it).
 */
export function moveRefusalText(r: MoveRefusal, manifest: Dated, target?: string): string {
  switch (r.kind) {
    case 'telecom':
      return t('tree.measure.move.telecom');
    case 'no-match': {
      const layer = r.layer ? layerName(manifest, r.layer) : '';
      return layer
        ? t('tree.measure.move.noMatch', { date: dateName(manifest, target), layer })
        : t('tree.measure.move.noMatchAny', { date: dateName(manifest, target) });
    }
    case 'unprepared':
      return t('tree.measure.move.unprepared', { date: dateName(manifest, r.capture) });
    case 'no-height-map':
      return t('tree.measure.move.noHeightMap', { date: dateName(manifest, r.capture) });
    case 'not-loaded':
      return t('tree.measure.move.notLoaded', { layer: layerName(manifest, r.layer) });
    case 'need-3d':
      return t('tree.measure.move.need3d');
    case 'hidden-layer':
      return t('tree.measure.move.hiddenLayer', { layer: layerName(manifest, r.layer) });
    case 'no-data':
    case 'same-surface': {
      const m = measureStore.getState().file.measurements.find((x) => x.id === r.id);
      const key =
        r.kind === 'no-data' ? 'tree.measure.move.noData' : 'tree.measure.move.sameSurface';
      return t(key, { date: dateName(manifest, target), name: m?.label ?? r.id });
    }
  }
}

function refuse(r: MoveRefusal, manifest: Dated, target: string): MoveOutcome {
  setMeasureNote({
    text: moveRefusalText(r, manifest, target),
    danger: true,
    ...(r.kind === 'unprepared' ? { prepare: true } : {}),
  });
  return { ok: false, refusal: r };
}

// ---------------------------------------------------------------- move and copy

/** The folder names in use under a date. */
function foldersOn(capture: string): Set<string> {
  const out = new Set<string>();
  for (const m of measureStore.getState().file.measurements) {
    const f = m.folder?.trim();
    if (f && m.scope.kind === 'survey' && m.scope.capture === capture) out.add(f);
  }
  return out;
}

/** A measurement as a move or copy reads it: everything but its computed results. */
const asPlanned = (m: SurveyMeasurement | undefined) =>
  m ? JSON.stringify({ ...m, results: undefined, updatedAt: undefined }) : '';

/**
 * Whether the measurements a plan was made from are still as they were (an edit, a delete or a
 * follow while the re-picks were out makes the plan stale: it is dropped, never written).
 */
function unchanged(ms: readonly SurveyMeasurement[]): boolean {
  const now = new Map(measureStore.getState().file.measurements.map((m) => [m.id, m]));
  return ms.every((m) => asPlanned(now.get(m.id)) === asPlanned(m));
}

async function plan(ms: readonly SurveyMeasurement[], capture: string, manifest: ProjectManifest) {
  return planMoveToDate(ms, capture, {
    manifest,
    index: indexOf(manifest),
    surfaces: compareStore.getState().surfaces,
    repick: repicker ?? stageRepicker(),
    folders: foldersOn(capture),
  });
}

/**
 * Move measurements to a survey date, measured again on that date's matching data: all or none,
 * one undoable edit, the moved ones recomputed and one note (with Undo) posted. A refusal posts
 * its reason and changes nothing. Nothing happens while the measurements cannot be written.
 */
export async function moveMeasurementsToDate(
  ids: readonly string[],
  capture: string,
): Promise<MoveOutcome> {
  const project = openProject();
  if (refused() || !project) return NOTHING;
  const which = new Set(ids);
  const ms = measureStore.getState().file.measurements.filter((m) => which.has(m.id));
  if (ms.length === 0) return NOTHING;
  const projectId = measureStore.getState().projectId;
  const p = await plan(ms, capture, project.manifest);
  // another project opened, the file became read-only, or the measurements were edited while the
  // re-picks were out: nothing is written
  if (refused() || measureStore.getState().projectId !== projectId || !unchanged(ms))
    return NOTHING;
  if (!p.ok) return refuse(p.refusal, project.manifest, capture);
  if (p.next.length === 0) return NOTHING;
  const seq = replaceMeasurements(p.next, { undoable: true });
  const moved = p.next.map((m) => m.id);
  setMeasureNote({
    text: t('tree.measure.move.done', {
      count: moved.length,
      date: dateName(project.manifest, capture),
    }),
    danger: false,
    undo: seq !== null,
  });
  await computeAll(moved).catch(() => undefined);
  return { ok: true, moved: moved.length, seq };
}

/**
 * Copy a measurement to a survey date: a new measurement (new id, now, this author) measured again
 * on that date as a move would be; the original stays. A copy on its own date is a plain copy.
 */
export async function copyMeasurementToDate(id: string, capture: string): Promise<MoveOutcome> {
  const project = openProject();
  if (refused() || !project) return NOTHING;
  const m = measureStore.getState().file.measurements.find((x) => x.id === id);
  if (!m) return NOTHING;
  const projectId = measureStore.getState().projectId;
  const p = await plan([m], capture, project.manifest);
  if (refused() || measureStore.getState().projectId !== projectId || !unchanged([m]))
    return NOTHING;
  if (!p.ok) return refuse(p.refusal, project.manifest, capture);
  const base = p.next[0] ?? m;
  const copy: SurveyMeasurement = {
    ...base,
    id: newMeasurementId(),
    results: [],
    createdAt: new Date().toISOString(),
  };
  delete copy.updatedAt;
  const by = authorName();
  if (by) copy.createdBy = by;
  else delete copy.createdBy;
  addMeasurement(copy);
  await computeAll([copy.id]).catch(() => undefined);
  return { ok: true, moved: 1, seq: null };
}

// ---------------------------------------------------------------- a layer put on another date

/**
 * Follow layers put on another date (by any path): a measurement measured on a layer that went
 * from date A to date B, while it is on A, goes to B with its stored points as they are (it stays
 * on the layer) and its results stale. Not undoable on its own: the layer's own Undo puts the
 * layer back and this follows it back. A layer taken off every date leaves its measurements where
 * they are. Nothing while the measurements cannot be written. Returns unsubscribe.
 */
export function followLayerDates(): () => void {
  return workspace.subscribe((s, prev) => {
    const a = prev.project;
    const b = s.project;
    if (!a || !b) return;
    if (a.id !== b.id || a.manifest === b.manifest) return;
    if (refused() || measureStore.getState().projectId !== b.id) return;
    const was = captureIndex(a.manifest).of;
    const now = captureIndex(b.manifest).of;
    const captures = new Set(b.manifest.captures.map((c) => c.id));
    const next: SurveyMeasurement[] = [];
    for (const m of measureStore.getState().file.measurements) {
      const layer = m.source?.layer;
      if (!layer || m.scope.kind !== 'survey') continue;
      const from = was[layer];
      const to = now[layer];
      if (!from || !to || from === to || !captures.has(to) || m.scope.capture !== from) continue;
      next.push({
        ...m,
        scope: { kind: 'survey', capture: to },
        results: m.results.map((r) => ({ ...r, status: 'stale' as const })),
      });
    }
    if (next.length === 0) return;
    replaceMeasurements(next);
    void computeAll(next.map((m) => m.id)).catch(() => undefined);
  });
}
