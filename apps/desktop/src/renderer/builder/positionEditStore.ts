import {
  correctedPhoto,
  isPositionEdited,
  offsetForPosition,
  photoCorrection,
  shiftToOffset,
  siteXYZ,
  withPositionOffset,
  type SiteXYZ,
} from '@aio/geo';
import type { OrientationFile, PhotoRef, ProjectManifest, Vec3 } from '@aio/schema';
import type { PhotoPick } from '@aio/ui';
import { t } from '@aio/ui';
import type { Workspace } from '@aio/workspace';
import { createStore, type StoreApi } from 'zustand/vanilla';
import type { Fixes } from './alignTo';

/*
 * "Edit position" of photos: one photo takes an absolute X, Y, Z (site metres, project height),
 * several take one shift. The move is the photo's `offsetM` in `orientation.json`; `pos` stays the
 * imported original. Pinned photos (Move pin) and photos with no position (Place on site) are left
 * out. One write per Save, with a one-step Undo/Redo notice (as Align to).
 */

/** The picks Edit position can move, and the ones it leaves out and why. */
export interface PickSplit {
  editable: PhotoPick[];
  /** Pinned by hand: the pin is their place (Move pin). */
  pinned: PhotoPick[];
  /** No position yet, or no longer in the project. */
  unplaced: PhotoPick[];
}

const photoOf = (m: ProjectManifest | null | undefined, p: PhotoPick): PhotoRef | undefined => {
  const l = m?.layers.find((x) => x.id === p.layerId);
  return l?.kind === 'photos' ? l.items.find((i) => i.id === p.photoId) : undefined;
};

/** Splits picks into the ones Edit position can move, pinned ones and ones not placed. */
export function editablePicks(
  picks: readonly PhotoPick[],
  manifest: ProjectManifest | null | undefined,
): PickSplit {
  const out: PickSplit = { editable: [], pinned: [], unplaced: [] };
  for (const p of picks) {
    const ref = photoOf(manifest, p);
    if (ref?.pin !== undefined) out.pinned.push(p);
    else if (ref?.pos) out.editable.push(p);
    else out.unplaced.push(p);
  }
  return out;
}

/** Why Edit position is greyed for these picks (nothing editable), or false. */
export function editReason(split: PickSplit): string | false {
  if (split.editable.length > 0) return false;
  return t(split.pinned.length > 0 ? 'position.why.pinned' : 'position.why.unplaced');
}

/** Where the panel opens (the menu point), or null for its default place. */
export type PanelAt = { x: number; y: number } | null;

export type PositionPanel =
  | {
      mode: 'one';
      projectId: string;
      pick: PhotoPick;
      /** Where the photo is drawn now (its correction applied). */
      current: SiteXYZ;
      /** Where it was imported. */
      original: SiteXYZ;
      edited: boolean;
      skipped: number;
      at: PanelAt;
    }
  | {
      mode: 'many';
      projectId: string;
      picks: PhotoPick[];
      count: number;
      skipped: number;
      at: PanelAt;
    };

/** The offset Undo or Redo sets for each photo, by set and photo (null: no offset). */
export type OffsetSteps = Record<string, Record<string, Vec3 | null>>;

export interface PositionNotice {
  /** The project it was raised for: another project takes it away, and its Undo writes nothing. */
  projectId: string | null;
  text: string;
  action: { kind: 'undo' | 'redo'; steps: OffsetSteps } | null;
}

export interface PositionEditStore {
  panel: PositionPanel | null;
  notice: PositionNotice | null;
  /** Opens the panel for the picks it can move; the reason (also shown) when it cannot, else null. */
  open(picks: readonly PhotoPick[], at?: PanelAt): string | null;
  /** Save: one photo goes to `values` (X, Y, Z); several move by `values` (a shift). */
  save(values: SiteXYZ): Promise<void>;
  cancel(): void;
  /** Reset to original: the picks' position offsets removed (their rotations stay). */
  reset(picks: readonly PhotoPick[]): Promise<void>;
  /** The notice's Undo or Redo. */
  apply(): Promise<void>;
  dismiss(): void;
}

export interface PositionEditDeps {
  workspace: StoreApi<Workspace>;
  /**
   * One `orientation:write`: `change` is given the file as it stands at write time and returns the
   * corrections to set by set and photo (null removes one). An error or null.
   */
  save(change: (file: OrientationFile | null) => Fixes): Promise<string | null>;
  /** A package is open (read-only: its files stay inside it). */
  pkg(): boolean;
  reload(): void;
}

const ZERO: Vec3 = [0, 0, 0];
const EPS = 5e-4;
const round01mm = (v: number) => Math.round(v * 1e4) / 1e4 + 0;
const add = (a: Vec3, b: Vec3): Vec3 => [
  round01mm(a[0] + b[0]),
  round01mm(a[1] + b[1]),
  round01mm(a[2] + b[2]),
];

const errorText = (e: unknown) =>
  e instanceof Error && e.message ? e.message : t('library.failed');

export function createPositionEditStore(deps: PositionEditDeps): StoreApi<PositionEditStore> {
  // one write at a time: a key held down or a double click must not start a second
  let busy = false;
  const store = createStore<PositionEditStore>()((set, get) => {
    const openId = () => deps.workspace.getState().project?.id ?? null;
    const say = (text: string, action: PositionNotice['action'] = null) => {
      set({ notice: { projectId: openId(), text, action } });
    };
    /** Why nothing may be written now (a package, corrections not read yet), or null. */
    const blocked = (): string | null => {
      if (deps.pkg()) return t('actions.reason.package');
      if (deps.workspace.getState().orientationLoaded) return null;
      deps.reload();
      return t('align.direction.say.notLoaded');
    };

    /**
     * One write: `offsetFor` gives each photo's new offset from its correction at write time
     * (undefined leaves it). The previous offsets come back for Undo, or null after an error.
     */
    const write = async (
      picks: readonly PhotoPick[],
      offsetFor: (p: PhotoPick, cur: Vec3 | null) => Vec3 | null | undefined,
    ): Promise<{ err: string | null; before: OffsetSteps; count: number }> => {
      const before: OffsetSteps = {};
      let count = 0;
      const err = await deps.save((file) => {
        const fixes: Fixes = {};
        count = 0;
        for (const p of picks) {
          const cur = photoCorrection(file, p.layerId, p.photoId);
          const prev = cur?.offsetM ?? null;
          const next = offsetFor(p, prev);
          if (next === undefined) continue;
          (before[p.layerId] ??= {})[p.photoId] = prev;
          (fixes[p.layerId] ??= {})[p.photoId] = withPositionOffset(cur, next);
          count++;
        }
        return fixes;
      });
      return { err, before, count };
    };

    const done = (projectId: string, text: string, steps: OffsetSteps) => {
      set({ notice: { projectId, text, action: { kind: 'undo', steps } } });
    };

    return {
      panel: null,
      notice: null,
      open: (picks, at = null) => {
        const ws = deps.workspace.getState();
        const project = ws.project;
        const why = blocked();
        if (why || !project) {
          const text = why ?? t('position.why.unplaced');
          say(text);
          return text;
        }
        const m = project.manifest;
        const split = editablePicks(picks, m);
        const reason = editReason(split);
        if (reason) {
          say(reason);
          return reason;
        }
        const skipped = split.pinned.length + split.unplaced.length;
        const [only] = split.editable;
        const ref = only && split.editable.length === 1 ? photoOf(m, only) : undefined;
        if (only && ref?.pos) {
          const c = photoCorrection(ws.orientation, only.layerId, only.photoId);
          const drawn = correctedPhoto(ref, c).pos ?? ref.pos;
          set({
            panel: {
              mode: 'one',
              projectId: project.id,
              pick: only,
              current: siteXYZ(drawn, m.origin),
              original: siteXYZ(ref.pos, m.origin),
              edited: isPositionEdited(c),
              skipped,
              at,
            },
          });
        } else {
          set({
            panel: {
              mode: 'many',
              projectId: project.id,
              picks: split.editable,
              count: split.editable.length,
              skipped,
              at,
            },
          });
        }
        return null;
      },
      save: async (values) => {
        const panel = get().panel;
        if (!panel || busy) return;
        // the panel was opened for another project: drop it, write nothing
        const project = deps.workspace.getState().project;
        const same = project?.id === panel.projectId ? project : null;
        if (!same) {
          set({ panel: null });
          return;
        }
        const why = blocked();
        if (why) {
          say(why);
          return;
        }
        const picks = panel.mode === 'one' ? [panel.pick] : panel.picks;
        const shift = shiftToOffset(values);
        if (panel.mode === 'many' && shift.every((v) => Math.abs(v) < EPS)) {
          set({ panel: null });
          return;
        }
        if (panel.mode === 'one') {
          // typed where the photo already is (0.5 mm rule): nothing to write, nothing to undo
          const imported = photoOf(same.manifest, panel.pick)?.pos;
          const cur =
            photoCorrection(
              deps.workspace.getState().orientation,
              panel.pick.layerId,
              panel.pick.photoId,
            )?.offsetM ?? ZERO;
          const next = imported && offsetForPosition(imported, same.manifest.origin, values);
          if (next?.every((v, i) => Math.abs(v - (cur[i] ?? 0)) < EPS)) {
            set({ panel: null });
            return;
          }
        }
        busy = true;
        try {
          // the manifest as it stands now: a photo removed or pinned meanwhile is left alone
          const m = same.manifest;
          const live = editablePicks(picks, m).editable;
          const { err, before, count } = await write(live, (p, cur) => {
            if (panel.mode === 'many') return add(cur ?? ZERO, shift);
            const imported = photoOf(m, p)?.pos;
            return imported ? offsetForPosition(imported, m.origin, values) : undefined;
          });
          set({ panel: null });
          if (err) say(err);
          else done(same.id, t('position.say.saved', { count }), before);
        } catch (e) {
          say(errorText(e));
        } finally {
          busy = false;
        }
      },
      cancel: () => {
        set({ panel: null });
      },
      reset: async (picks) => {
        if (busy) return;
        const project = deps.workspace.getState().project;
        if (!project) return;
        const why = blocked();
        if (why) {
          say(why);
          return;
        }
        busy = true;
        try {
          const live = editablePicks(picks, project.manifest).editable;
          const { err, before, count } = await write(live, (_p, cur) =>
            cur?.some((v) => Math.abs(v) >= EPS) ? null : undefined,
          );
          set({ panel: null });
          if (err) say(err);
          else if (count > 0) done(project.id, t('position.say.reset', { count }), before);
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
        // the steps name another project's photos: never write them into this one
        if (n.projectId !== openId()) {
          set({ notice: null });
          return;
        }
        const why = blocked();
        if (why) {
          say(why, a);
          return;
        }
        busy = true;
        try {
          const picks: PhotoPick[] = Object.entries(a.steps).flatMap(([layerId, photos]) =>
            Object.keys(photos).map((photoId) => ({ layerId, photoId })),
          );
          const { err, before } = await write(
            picks,
            (p) => a.steps[p.layerId]?.[p.photoId] ?? null,
          );
          // a failed write keeps the action, so the notice can try again
          set({
            notice: err
              ? { projectId: n.projectId, text: err, action: a }
              : {
                  projectId: n.projectId,
                  text: t(a.kind === 'undo' ? 'position.say.undone' : 'position.say.redone'),
                  action: { kind: a.kind === 'undo' ? 'redo' : 'undo', steps: before },
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
  // the panel and the notice belong to the project they were raised for
  deps.workspace.subscribe((s, prev) => {
    // the corrections are read again (a re-read, a pose swap, an import): the offsets the notice
    // and the panel hold no longer say where the photos are
    if (prev.orientationLoaded && !s.orientationLoaded) {
      const st = store.getState();
      if (st.panel) store.setState({ panel: null });
      if (st.notice) st.dismiss();
      return;
    }
    if (s.project?.id === prev.project?.id) return;
    const id = s.project?.id ?? null;
    const st = store.getState();
    if (st.panel && st.panel.projectId !== id) store.setState({ panel: null });
    if (st.notice && st.notice.projectId !== id) st.dismiss();
  });
  return store;
}
