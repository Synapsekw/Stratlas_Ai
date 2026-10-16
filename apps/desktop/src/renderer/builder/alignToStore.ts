import { photoCorrection } from '@aio/geo';
import type { OrientationFile, PhotoCorrection, Vec3 } from '@aio/schema';
import type { PhotoPick } from '@aio/ui';
import { t } from '@aio/ui';
import type { Workspace } from '@aio/workspace';
import { createStore, type StoreApi } from 'zustand/vanilla';
import { alignSources, formatDistance, planAlign, type AlignBox, type Fixes } from './alignTo';

/** What Undo or Redo writes for one photo: its offset only, never its rotations. */
export interface OffsetStep {
  offsetM: Vec3;
  /** Align to made the correction (the photo had none): Undo removes it if nothing else was set. */
  created: boolean;
}
export type OffsetSteps = Record<string, Record<string, OffsetStep>>;

export interface AlignToNoticeState {
  text: string;
  action: { kind: 'undo' | 'redo'; steps: OffsetSteps } | null;
}

export interface AlignToStore {
  notice: AlignToNoticeState | null;
  alignTo(
    source: { layerIds: string[] } | { picks: PhotoPick[] },
    targetLayerId: string,
  ): Promise<void>;
  /** The notice's Undo or Redo. */
  apply(): Promise<void>;
  dismiss(): void;
}

export interface AlignToDeps {
  workspace: StoreApi<Workspace>;
  /**
   * One `orientation:write`: `change` is given the file as it stands at write time and returns the
   * corrections to set by set and photo (null removes one). An error or null.
   */
  save(change: (file: OrientationFile | null) => Fixes): Promise<string | null>;
  bounds(layerId: string): Promise<AlignBox | null>;
  ground(x: number, z: number): Promise<number | null>;
  reload(): void;
}

const ZERO: Vec3 = [0, 0, 0];

// no dedicated string for a failed lookup: the error's own text, else the generic "It did not work."
const errorText = (e: unknown) =>
  e instanceof Error && e.message ? e.message : t('library.failed');

/** The correction to write for one photo (null removes it, undefined leaves it), offset only. */
function stepFix(
  kind: 'undo' | 'redo',
  step: OffsetStep,
  cur: PhotoCorrection | undefined,
): PhotoCorrection | null | undefined {
  if (kind === 'undo' && step.created) {
    if (cur === undefined) return undefined;
    // Align to made it: take it away again unless a rotation was set since
    const untouched = cur.yawDeg === 0 && cur.pitchDeg === 0 && cur.rollDeg === 0;
    return untouched ? null : { ...cur, offsetM: ZERO };
  }
  return { yawDeg: 0, pitchDeg: 0, rollDeg: 0, ...cur, offsetM: step.offsetM };
}

export function createAlignToStore(deps: AlignToDeps): StoreApi<AlignToStore> {
  // one write at a time: a key held down or a double click must not start a second
  let busy = false;
  return createStore<AlignToStore>()((set, get) => {
    const unread = () => {
      if (deps.workspace.getState().orientationLoaded) return false;
      deps.reload();
      set({ notice: { text: t('align.direction.say.notLoaded'), action: null } });
      return true;
    };
    return {
      notice: null,
      alignTo: async (source, targetId) => {
        if (busy) return;
        busy = true;
        try {
          const first = deps.workspace.getState().project?.manifest;
          if (!first || unread()) return;
          const target = first.layers.find((l) => l.id === targetId);
          const box = await deps.bounds(targetId);
          if (!target || !box) {
            set({
              notice: {
                text: t('actions.reason.noBounds', { name: target?.name ?? targetId }),
                action: null,
              },
            });
            return;
          }
          const g = await deps.ground((box.min[0] + box.max[0]) / 2, (box.min[2] + box.max[2]) / 2);
          // read again: the project or the corrections may have changed while we waited
          const ws = deps.workspace.getState();
          const m = ws.project?.manifest;
          if (!m || unread()) return;
          const sources = alignSources(m, ws.orientation, source);
          if (!sources.some((s) => s.pos)) {
            set({ notice: { text: t('actions.reason.noPositions'), action: null } });
            return;
          }
          const plan = planAlign(sources, box, g);
          if (plan.inPlace) {
            set({ notice: { text: t('align.to.inPlace'), action: null } });
            return;
          }
          const err = await deps.save(() => plan.fixes);
          if (err) {
            set({ notice: { text: err, action: null } });
            return;
          }
          const steps: OffsetSteps = {};
          for (const [layerId, photos] of Object.entries(plan.before))
            for (const [id, c] of Object.entries(photos))
              (steps[layerId] ??= {})[id] = { offsetM: c?.offsetM ?? ZERO, created: c === null };
          const done = t('align.to.done', {
            count: plan.moved,
            target: target.name,
            distance: formatDistance(plan.distance),
          });
          const skipped =
            plan.skipped > 0 ? ` ${t('align.to.skipped', { count: plan.skipped })}` : '';
          set({ notice: { text: `${done}.${skipped}`, action: { kind: 'undo', steps } } });
        } catch (e) {
          set({ notice: { text: errorText(e), action: null } });
        } finally {
          busy = false;
        }
      },
      apply: async () => {
        const a = get().notice?.action;
        if (!a || busy) return;
        busy = true;
        try {
          if (unread()) return;
          const inverse: OffsetSteps = {};
          const err = await deps.save((file) => {
            const fixes: Fixes = {};
            for (const [layerId, photos] of Object.entries(a.steps)) {
              for (const [id, step] of Object.entries(photos)) {
                const cur = photoCorrection(file, layerId, id);
                (inverse[layerId] ??= {})[id] = {
                  offsetM: cur?.offsetM ?? ZERO,
                  created: step.created,
                };
                const fix = stepFix(a.kind, step, cur);
                if (fix !== undefined) (fixes[layerId] ??= {})[id] = fix;
              }
            }
            return fixes;
          });
          // a failed write keeps the action, so the notice can try again
          set({
            notice: err
              ? { text: err, action: a }
              : {
                  text: t(a.kind === 'undo' ? 'align.to.undone' : 'align.to.redone'),
                  action: { kind: a.kind === 'undo' ? 'redo' : 'undo', steps: inverse },
                },
          });
        } catch (e) {
          set({ notice: { text: errorText(e), action: a } });
        } finally {
          busy = false;
        }
      },
      dismiss: () => {
        set({ notice: null });
      },
    };
  });
}
