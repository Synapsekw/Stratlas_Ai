import type { Layer, LayerPatch, ProjectManifest } from '@aio/schema';
import { t } from '@aio/ui';
import type { Workspace } from '@aio/workspace';
import { createStore, type StoreApi } from 'zustand/vanilla';
import type { Box } from '../shell/layerBounds';
import {
  droppable,
  formatShift,
  groundUnder,
  planDrop,
  type DropItem,
  type DropStep,
} from './dropToGround';

/** One write of the notice's Undo or Redo, and the write that takes that back again. */
export interface DropWrite {
  layerId: string;
  patch: LayerPatch;
  back: LayerPatch;
}

export interface DropNotice {
  /** The project it was raised for: another project takes it away, and its Undo writes nothing. */
  projectId: string | null;
  text: string;
  action: { kind: 'undo' | 'redo'; steps: DropWrite[] } | null;
}

export interface DropStore {
  notice: DropNotice | null;
  /** Put each dataset's low point on the ground under it, one write per dataset. */
  drop(layerIds: readonly string[]): Promise<void>;
  /** Set a cloud's height offset (Properties); null or 0 clears it. With Undo, as a drop. */
  setOffset(layerId: string, heightOffsetM: number | null): Promise<void>;
  /** The notice's Undo or Redo. */
  apply(): Promise<void>;
  dismiss(): void;
}

export interface DropDeps {
  workspace: StoreApi<Workspace>;
  /** One `builder:updateLayers` write for one layer: an error or null. */
  save(layerId: string, patch: LayerPatch): Promise<string | null>;
  /** The item's low point, local y, as drawn now; null when it has not loaded. */
  low(layerId: string): Promise<number | null>;
  /** The item's box in the local frame (its plan box is the footprint), or null. */
  footprint(layerId: string): Promise<Box | null>;
  /** The DSM's height straight down at (x, z), or null where there is none. */
  ground(x: number, z: number): number | null;
  /** How far the floor drawn in 3D lies over a placed walk's ground (`walkFloorShift`). */
  walkFloor(layerId: string): Promise<WalkFloor>;
}

/**
 * A walk's floor: the median shift onto it; `notLoaded` while the walk has no fit drawn yet;
 * `noFloor` when nothing drawn in 3D answers under its path.
 */
export type WalkFloor = { shift: number } | 'notLoaded' | 'noFloor';

type GroundSource = 'dsm' | 'project' | 'floor';

const r3 = (v: number) => Math.round(v * 1000) / 1000;

// no dedicated string for a failed lookup: the error's own text, else the generic "It did not work."
const errorText = (e: unknown) =>
  e instanceof Error && e.message ? e.message : t('library.failed');

const layerOf = (m: ProjectManifest | undefined, id: string): Layer | undefined =>
  m?.layers.find((l) => l.id === id);

/** What the planner needs of a layer as it stands, with its measured low point. */
function itemOf(l: Layer, low: number): DropItem | null {
  if (l.kind === 'pointcloud' || l.kind === 'walk')
    return {
      kind: l.kind,
      layerId: l.id,
      name: l.name,
      low,
      heightOffsetM: l.heightOffsetM ?? 0,
    };
  if (l.kind === 'mesh')
    return {
      kind: 'mesh',
      layerId: l.id,
      name: l.name,
      low,
      transform: l.transform,
      georef: l.georef,
      placement: l.placement,
    };
  return null;
}

/** "-30.81 m": an offset as set, signed, to the millimetre. */
const offsetText = (v: number) => `${String(r3(v))} m`;

export function createDropStore(deps: DropDeps): StoreApi<DropStore> {
  // one run at a time: a key held down or a double click must not start a second
  let busy = false;
  const store = createStore<DropStore>()((set, get) => {
    const openId = () => deps.workspace.getState().project?.id ?? null;
    const say = (text: string, action: DropNotice['action'] = null) => {
      set({ notice: { projectId: openId(), text, action } });
    };
    /** Write the steps one at a time; the ones done, and the error that stopped it. */
    const writeAll = async (
      projectId: string,
      steps: readonly { layerId: string; patch: LayerPatch }[],
    ): Promise<{ done: number; err: string | null }> => {
      let done = 0;
      for (const s of steps) {
        // another project opened meanwhile: nothing more goes into it
        if (openId() !== projectId) return { done, err: null };
        const err = await deps.save(s.layerId, s.patch);
        if (err) return { done, err };
        done++;
      }
      return { done, err: null };
    };
    return {
      notice: null,
      drop: async (layerIds) => {
        if (busy) return;
        busy = true;
        try {
          const first = deps.workspace.getState().project;
          if (!first) return;
          const measured: {
            id: string;
            low: number;
            ground: { y: number; source: GroundSource };
          }[] = [];
          // a hidden dataset draws nothing to measure: say so, and write nothing
          const hiddenNow = deps.workspace.getState().hidden;
          const hiddenNames: string[] = [];
          for (const id of layerIds) {
            const l = layerOf(first.manifest, id);
            // a walk is measured on the floor drawn under it, not on itself: hidden is fine
            if (l && l.kind !== 'walk' && hiddenNow[id] && droppable(l) === 'ok')
              hiddenNames.push(l.name);
          }
          if (hiddenNames.length > 0) {
            say(t('drop.hidden', { count: hiddenNames.length, names: hiddenNames.join(', ') }));
            return;
          }
          for (const id of layerIds) {
            const l = layerOf(first.manifest, id);
            if (!l) continue;
            const can = droppable(l);
            if (can === 'kit') {
              say(t('actions.reason.kitCloud'));
              return;
            }
            if (can !== 'ok') continue;
            if (l.kind === 'walk') {
              // a walk moves by the floor's median height over its ground along its path
              const floor = await deps.walkFloor(id);
              if (floor === 'notLoaded') {
                say(t('drop.notLoaded', { name: l.name }));
                return;
              }
              if (floor === 'noFloor') {
                say(t('drop.noFloor', { name: l.name }));
                return;
              }
              measured.push({ id, low: 0, ground: { y: floor.shift, source: 'floor' } });
              continue;
            }
            const low = await deps.low(id);
            if (low === null) {
              say(t('drop.notLoaded', { name: l.name }));
              return;
            }
            const box = await deps.footprint(id);
            if (!box) {
              say(t('actions.reason.noBounds', { name: l.name }));
              return;
            }
            measured.push({ id, low, ground: groundUnder(box, (x, z) => deps.ground(x, z)) });
          }
          // read again: the project or the layers may have changed while we measured
          const ws = deps.workspace.getState();
          if (ws.project?.id !== first.id) return;
          const project = { crs: ws.project.manifest.crs, origin: ws.project.manifest.origin };
          const plans: { step: DropStep; source: GroundSource }[] = [];
          for (const m of measured) {
            const l = layerOf(ws.project.manifest, m.id);
            const item = l ? itemOf(l, m.low) : null;
            const step = item ? planDrop(item, m.ground.y, project) : null;
            if (step) plans.push({ step, source: m.ground.source });
          }
          if (plans.length === 0) {
            if (measured.length > 0) say(t('drop.inPlace'));
            return;
          }
          const { done, err } = await writeAll(
            first.id,
            plans.map((p) => p.step),
          );
          const steps: DropWrite[] = plans
            .slice(0, done)
            .map(({ step }) => ({ layerId: step.layerId, patch: step.undo, back: step.patch }));
          const action: DropNotice['action'] = steps.length ? { kind: 'undo', steps } : null;
          if (openId() !== first.id) return;
          if (err) {
            set({ notice: { projectId: first.id, text: err, action } });
            return;
          }
          const one = plans[0];
          const text =
            plans.length === 1 && one
              ? t(one.step.shift < 0 ? 'drop.lowered' : 'drop.raised', {
                  name: one.step.name,
                  distance: formatShift(one.step.shift),
                  ground: t(
                    one.source === 'dsm'
                      ? 'drop.onDsm'
                      : one.source === 'floor'
                        ? 'drop.onFloor'
                        : 'drop.onProject',
                  ),
                })
              : t('drop.many', {
                  count: plans.length,
                  distance: formatShift(Math.max(...plans.map((p) => Math.abs(p.step.shift)))),
                });
          set({ notice: { projectId: first.id, text, action } });
        } catch (e) {
          say(errorText(e));
        } finally {
          busy = false;
        }
      },
      setOffset: async (layerId, heightOffsetM) => {
        if (busy) return;
        busy = true;
        try {
          const project = deps.workspace.getState().project;
          const l = layerOf(project?.manifest, layerId);
          if (!project || !l || (l.kind !== 'pointcloud' && l.kind !== 'walk')) return;
          if (l.kind === 'walk' && droppable(l) !== 'ok') return;
          if (droppable(l) === 'kit') {
            say(t('actions.reason.kitCloud'));
            return;
          }
          const cur = l.heightOffsetM ?? 0;
          const next = heightOffsetM === null ? 0 : r3(heightOffsetM);
          if (!Number.isFinite(next) || next === cur) return;
          const patch: LayerPatch = { heightOffsetM: next || null };
          const back: LayerPatch = { heightOffsetM: cur || null };
          const err = await deps.save(layerId, patch);
          if (openId() !== project.id) return;
          set({
            notice: {
              projectId: project.id,
              text: err ?? t('drop.set', { name: l.name, distance: offsetText(next) }),
              action: err ? null : { kind: 'undo', steps: [{ layerId, patch: back, back: patch }] },
            },
          });
        } catch (e) {
          say(errorText(e));
        } finally {
          busy = false;
        }
      },
      apply: async () => {
        const n = get().notice;
        const a = n?.action;
        if (!n || !a || busy) return;
        // the steps name another project's layers: never write them into this one
        if (n.projectId === null || n.projectId !== openId()) {
          set({ notice: null });
          return;
        }
        busy = true;
        try {
          const { done, err } = await writeAll(n.projectId, a.steps);
          if (openId() !== n.projectId) return;
          // the writes are whole values: a failed one keeps the action, so the notice can try again
          set({
            notice:
              err || done < a.steps.length
                ? { projectId: n.projectId, text: err ?? t('library.failed'), action: a }
                : {
                    projectId: n.projectId,
                    text: t(a.kind === 'undo' ? 'drop.undone' : 'drop.redone'),
                    action: {
                      kind: a.kind === 'undo' ? 'redo' : 'undo',
                      steps: a.steps.map((s) => ({
                        layerId: s.layerId,
                        patch: s.back,
                        back: s.patch,
                      })),
                    },
                  },
          });
        } catch (e) {
          set({ notice: { projectId: n.projectId, text: errorText(e), action: a } });
        } finally {
          busy = false;
        }
      },
      dismiss: () => {
        set({ notice: null });
      },
    };
  });
  // a notice belongs to the project it was raised for (as Align to's)
  deps.workspace.subscribe((s, prev) => {
    if (s.project?.id === prev.project?.id) return;
    const n = store.getState().notice;
    if (n && n.projectId !== (s.project?.id ?? null)) store.getState().dismiss();
  });
  return store;
}
