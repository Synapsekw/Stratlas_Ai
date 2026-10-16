import type { PhotoPick } from '@aio/ui';
import { t } from '@aio/ui';
import type { Workspace } from '@aio/workspace';
import { createStore, type StoreApi } from 'zustand/vanilla';
import { alignSources, formatDistance, planAlign, type AlignBox, type Fixes } from './alignTo';

export interface AlignToNoticeState {
  text: string;
  action: { kind: 'undo' | 'redo'; fixes: Fixes } | null;
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
  /** One `orientation:write` of every set's corrections (null removes one); an error or null. */
  save(fixes: Fixes): Promise<string | null>;
  bounds(layerId: string): Promise<AlignBox | null>;
  ground(x: number, z: number): Promise<number | null>;
  reload(): void;
}

export function createAlignToStore(deps: AlignToDeps): StoreApi<AlignToStore> {
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
        const ws = deps.workspace.getState();
        const m = ws.project?.manifest;
        if (!m || unread()) return;
        const target = m.layers.find((l) => l.id === targetId);
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
        const sources = alignSources(m, ws.orientation, source);
        if (!sources.some((s) => s.pos)) {
          set({ notice: { text: t('actions.reason.noPositions'), action: null } });
          return;
        }
        const g = await deps.ground((box.min[0] + box.max[0]) / 2, (box.min[2] + box.max[2]) / 2);
        const plan = planAlign(sources, box, g);
        if (plan.inPlace) {
          set({ notice: { text: t('align.to.inPlace'), action: null } });
          return;
        }
        const err = await deps.save(plan.fixes);
        if (err) {
          set({ notice: { text: err, action: null } });
          return;
        }
        const done = t('align.to.done', {
          count: plan.moved,
          target: target.name,
          distance: formatDistance(plan.distance),
        });
        const skipped =
          plan.skipped > 0 ? ` ${t('align.to.skipped', { count: plan.skipped })}` : '';
        set({
          notice: { text: `${done}.${skipped}`, action: { kind: 'undo', fixes: plan.before } },
        });
      },
      apply: async () => {
        const a = get().notice?.action;
        if (!a || unread()) return;
        const o = deps.workspace.getState().orientation;
        const now: Fixes = {};
        for (const [layerId, photos] of Object.entries(a.fixes))
          for (const id of Object.keys(photos))
            (now[layerId] ??= {})[id] = o?.photos[layerId]?.[id] ?? null;
        const err = await deps.save(a.fixes);
        set({
          notice: err
            ? { text: err, action: null }
            : {
                text: t(a.kind === 'undo' ? 'align.to.undone' : 'align.to.redone'),
                action: { kind: a.kind === 'undo' ? 'redo' : 'undo', fixes: now },
              },
        });
      },
      dismiss: () => {
        set({ notice: null });
      },
    };
  });
}
