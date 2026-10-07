import { clipCamera, clipPoseAt, directionFromQuat, type CameraDirection } from '@aio/geo';
import type { DirectionFill, DirectionKey, Layer, PoseSample, Vec3 } from '@aio/schema';
import { t } from '@aio/ui';
import type { Workspace } from '@aio/workspace';
import { createStore, type StoreApi } from 'zustand/vanilla';
import {
  clipTimeMs,
  formatClipMs,
  keyAt,
  keyFrom,
  moveKey,
  ON_KEY_MS,
  previewKeys,
  projectTimeMs,
  segmentKey,
  setFill,
  withKey,
} from './directionModel';

type VideoLayer = Extract<Layer, { kind: 'video' }>;

/** One "Align camera to map" session on a clip: the keyframes being edited, not saved yet. */
export interface AlignSession {
  layerId: string;
  /** The clip's keyframes when the session started (Cancel goes back to them). */
  original: DirectionKey[];
  keys: DirectionKey[];
  /** A turn at the playhead that is not a keyframe yet. */
  trial: { t: number; dir: CameraDirection } | null;
  /** Earlier keyframe lists, for Undo. */
  history: DirectionKey[][];
  /** The next click on the map or in 3D picks a look-at target. */
  picking: boolean;
  /** "Exact values" is open on the bar. */
  exact: boolean;
}

/** A saved change that can be taken back (or put back after an undo). */
export interface AlignNotice {
  text: string;
  action: { kind: 'undo' | 'redo'; layerId: string; keys: DirectionKey[] | null } | null;
}

export interface AlignState {
  session: AlignSession | null;
  /** Frame opacity on the map and in 3D. */
  opacity: number;
  /** The view footprint (map) and frustum (3D) of the drone are drawn. */
  footprint: boolean;
  say: { text: string; tone?: 'armed' | 'bad' } | null;
  notice: AlignNotice | null;
}

export interface AlignActions {
  /** Start aligning a clip's camera at the playhead (the clip becomes the active one). */
  start(layerId: string): void;
  /** The direction shown at the playhead now. */
  current(): CameraDirection | null;
  /** A drag starts (one undo step for the whole drag) or ends. */
  gesture(active: boolean): void;
  /** Turn the camera at the playhead: edits the keyframe there, else a turn to set. */
  turn(patch: Partial<CameraDirection>): void;
  /** Make the direction at the playhead a keyframe. */
  setKey(): void;
  deleteKey(): void;
  /** Jump the playhead to the previous (-1) or next (1) keyframe. */
  jump(step: -1 | 1): void;
  /** Keyframes on the first and last frame with the direction shown there now. */
  firstLast(): void;
  /** The fill of the segment at the playhead (a look-at asks for its point first). */
  fill(fill: DirectionFill): void;
  pick(target: Vec3 | null): void;
  /** Move keyframe `index` of the clip to clip time `clipMs` (starts a session if needed). */
  moveKey(layerId: string, index: number, clipMs: number): void;
  setExact(open: boolean): void;
  setOpacity(v: number): void;
  setFootprint(on: boolean): void;
  undo(): void;
  /** Save the keyframes (with a pending turn) and stop. */
  done(): Promise<void>;
  /** Stop without saving. */
  cancel(): void;
  /** Remove a clip's keyframes (saved), with Undo. */
  clear(layerId: string): Promise<void>;
  /** Take back (or put back) the last saved change. */
  applyNotice(): Promise<void>;
  dismissNotice(): void;
}

export type AlignStore = AlignState & AlignActions;

export interface AlignDeps {
  workspace: StoreApi<Workspace>;
  /** Save a clip's keyframes (`null` clears); an error text or null. */
  save(layerId: string, keys: DirectionKey[] | null): Promise<string | null>;
  /** The clip's (normalised) flight samples, once loaded. */
  flight(layerId: string): readonly PoseSample[] | null;
  /** Ask for the clip's flight to load. */
  loadFlight(layerId: string): void;
  /** The clip's length in ms, if known. */
  duration(layerId: string): number | null;
  /** Show the 3D view and the map side by side. */
  showBoth(): void;
}

/** Undo steps closer together than this (typing in a field) count as one. */
const MERGE_MS = 800;

export function createAlignStore(deps: AlignDeps): StoreApi<AlignStore> {
  const ws = deps.workspace;
  let inGesture = false;
  /** The last edit was a turn of the keyframe at this time, then (typing merges into it). */
  let lastTurn: { t: number; at: number } | null = null;
  let unwatch: (() => void) | null = null;

  const store = createStore<AlignStore>()((set, get) => {
    const clipOf = (id: string): VideoLayer | null => {
      const l = ws.getState().project?.manifest.layers.find((x) => x.id === id);
      return l?.kind === 'video' ? l : null;
    };
    const nowClipMs = (clip: VideoLayer) => clipTimeMs(clip, ws.getState().nowMs);
    const durationOf = (clip: VideoLayer): number => {
      const d = deps.duration(clip.id);
      if (d !== null && d > 0) return d;
      const s = deps.flight(clip.id);
      const last = s?.[s.length - 1];
      return last ? Math.max(0, last.t - clip.offsetMs) : 0;
    };
    /** Direction the views show at clip time `ms` with these keyframes (null: no flight yet). */
    const dirAt = (clip: VideoLayer, keys: readonly DirectionKey[], ms: number) => {
      const samples = deps.flight(clip.id);
      if (!samples?.length) return null;
      const p = clipPoseAt(
        samples,
        clip.offsetMs + ms,
        clipCamera(clip, undefined, keys.length ? keys : null),
      );
      return directionFromQuat(p.q);
    };
    const patch = (p: Partial<AlignSession>) => {
      const s = get().session;
      if (s) set({ session: { ...s, ...p } });
    };
    const push = (s: AlignSession): DirectionKey[][] => {
      lastTurn = null;
      return [...s.history, s.keys].slice(-100);
    };
    const end = () => {
      unwatch?.();
      unwatch = null;
      inGesture = false;
      set({ session: null, say: null });
      ws.getState().setDirectionDraft(null);
    };

    return {
      session: null,
      opacity: 0.6,
      footprint: true,
      say: null,
      notice: null,

      start: (layerId) => {
        const s = get().session;
        if (s?.layerId === layerId) return;
        if (s) end();
        const clip = clipOf(layerId);
        if (!clip) return;
        deps.loadFlight(layerId);
        const w = ws.getState();
        w.pause();
        if (w.activeClip !== layerId) {
          w.setActiveClip(layerId);
          const ms = clipTimeMs(clip, w.nowMs);
          if (ms < 0 || ms > durationOf(clip)) w.setTime(projectTimeMs(clip, 0));
        }
        deps.showBoth();
        const keys = [...(clip.directionKeys ?? [])];
        set({
          session: {
            layerId,
            original: keys,
            keys,
            trial: null,
            history: [],
            picking: false,
            exact: false,
          },
          say: { text: t('direction.help') },
        });
        // a turn not set as a keyframe goes when the playhead leaves it
        unwatch = ws.subscribe((now, prev) => {
          if (now.nowMs === prev.nowMs) return;
          const cur = get().session;
          const c = cur ? clipOf(cur.layerId) : null;
          if (!cur?.trial || !c) return;
          if (Math.abs(clipTimeMs(c, now.nowMs) - cur.trial.t) > ON_KEY_MS) {
            const at = formatClipMs(cur.trial.t);
            patch({ trial: null });
            set({ say: { text: t('direction.say.dropped', { time: at }), tone: 'bad' } });
          }
        });
      },

      current: () => {
        const s = get().session;
        const clip = s ? clipOf(s.layerId) : null;
        if (!s || !clip) return null;
        const ms = nowClipMs(clip);
        if (s.trial && Math.abs(s.trial.t - ms) <= ON_KEY_MS) return s.trial.dir;
        return dirAt(clip, previewKeys(s.keys, s.trial), ms);
      },

      gesture: (active) => {
        const s = get().session;
        if (active && !inGesture && s) patch({ history: push(s) });
        inGesture = active;
      },

      turn: (p) => {
        const s = get().session;
        const clip = s ? clipOf(s.layerId) : null;
        const cur = get().current();
        if (!s || !clip || !cur) return;
        const dir = { ...cur, ...p };
        const ms = nowClipMs(clip);
        const i = keyAt(s.keys, ms);
        const k = s.keys[i];
        if (k) {
          const now = Date.now();
          const merge = inGesture || (lastTurn?.t === k.t && now - lastTurn.at < MERGE_MS);
          const history = merge ? s.history : push(s);
          lastTurn = { t: k.t, at: now };
          patch({ keys: s.keys.map((x, j) => (j === i ? keyFrom(x.t, dir, x) : x)), history });
          return;
        }
        patch({ trial: { t: Math.round(Math.max(0, ms)), dir } });
      },

      setKey: () => {
        const s = get().session;
        const clip = s ? clipOf(s.layerId) : null;
        const dir = get().current();
        if (!s || !clip || !dir) return;
        const ms = Math.max(0, nowClipMs(clip));
        const seg = s.keys[segmentKey(s.keys, ms)];
        const keys = withKey(s.keys, keyFrom(ms, dir, seg));
        patch({ keys, trial: null, history: push(s) });
        set({ say: { text: t('direction.say.set', { time: formatClipMs(ms) }) } });
      },

      deleteKey: () => {
        const s = get().session;
        const clip = s ? clipOf(s.layerId) : null;
        if (!s || !clip) return;
        const i = keyAt(s.keys, nowClipMs(clip));
        if (i < 0) return;
        patch({ keys: s.keys.filter((_, j) => j !== i), history: push(s), trial: null });
        set({ say: { text: t('direction.say.deleted') } });
      },

      jump: (step) => {
        const s = get().session;
        const clip = s ? clipOf(s.layerId) : null;
        if (!s || !clip) return;
        const ms = nowClipMs(clip);
        const k =
          step > 0
            ? s.keys.find((x) => x.t > ms + ON_KEY_MS)
            : [...s.keys].reverse().find((x) => x.t < ms - ON_KEY_MS);
        if (k) ws.getState().setTime(projectTimeMs(clip, k.t));
      },

      firstLast: () => {
        const s = get().session;
        const clip = s ? clipOf(s.layerId) : null;
        if (!s || !clip) return;
        const end = Math.max(0, durationOf(clip) - 40);
        const preview = previewKeys(s.keys, s.trial);
        const a = dirAt(clip, preview, 0);
        const b = dirAt(clip, preview, end);
        if (!a || !b) return;
        const keys = end > 0 ? [keyFrom(0, a), keyFrom(end, b)] : [keyFrom(0, a)];
        patch({ keys, trial: null, history: push(s) });
        ws.getState().setTime(projectTimeMs(clip, 0));
        set({ say: { text: t('direction.say.firstLast') } });
      },

      fill: (f) => {
        const s = get().session;
        const clip = s ? clipOf(s.layerId) : null;
        if (!s || !clip) return;
        const i = segmentKey(s.keys, nowClipMs(clip));
        if (i < 0) return;
        if (f === 'lookAt') {
          patch({ picking: true });
          set({ say: { text: t('direction.say.pick'), tone: 'armed' } });
          return;
        }
        patch({ keys: setFill(s.keys, i, f), history: push(s), picking: false });
      },

      pick: (target) => {
        const s = get().session;
        const clip = s ? clipOf(s.layerId) : null;
        if (!s || !clip) return;
        if (!target) {
          patch({ picking: false });
          set({ say: { text: t('direction.say.noPick'), tone: 'bad' } });
          return;
        }
        const i = segmentKey(s.keys, nowClipMs(clip));
        if (i < 0) return;
        patch({ keys: setFill(s.keys, i, 'lookAt', target), history: push(s), picking: false });
        const pos = clipPoseAt(
          deps.flight(clip.id) ?? [],
          ws.getState().nowMs - clip.flight.startUtcMs,
          clipCamera(clip),
        ).pos;
        const d = Math.hypot(target[0] - pos[0], target[1] - pos[1], target[2] - pos[2]);
        set({ say: { text: t('direction.targetSet', { distance: `${d.toFixed(0)} m` }) } });
      },

      moveKey: (layerId, index, clipMs) => {
        if (get().session?.layerId !== layerId) get().start(layerId);
        const s = get().session;
        const clip = clipOf(layerId);
        if (!s || !clip) return;
        const history = inGesture ? s.history : push(s);
        patch({ keys: moveKey(s.keys, index, clipMs, durationOf(clip)), history });
      },

      setExact: (exact) => {
        patch({ exact });
      },
      setOpacity: (v) => {
        set({ opacity: Math.min(1, Math.max(0, v)) });
      },
      setFootprint: (footprint) => {
        set({ footprint });
      },

      undo: () => {
        const s = get().session;
        if (!s) {
          if (get().notice?.action) void get().applyNotice();
          return;
        }
        const prev = s.history[s.history.length - 1];
        if (prev) {
          patch({ keys: prev, history: s.history.slice(0, -1), trial: null });
          set({ say: { text: t('direction.say.undone') } });
        } else if (s.trial) patch({ trial: null });
        else set({ say: { text: t('direction.say.nothingToUndo') } });
      },

      done: async () => {
        const s = get().session;
        if (!s) return;
        const keys = previewKeys(s.keys, s.trial);
        if (JSON.stringify(keys) === JSON.stringify(s.original)) {
          end();
          return;
        }
        const err = await deps.save(s.layerId, keys.length ? keys : null);
        if (err) {
          set({ say: { text: err, tone: 'bad' } });
          return;
        }
        set({
          notice: {
            text: keys.length
              ? t('direction.say.saved', { count: keys.length })
              : t('direction.say.cleared'),
            action: {
              kind: 'undo',
              layerId: s.layerId,
              keys: s.original.length ? s.original : null,
            },
          },
        });
        end();
      },

      cancel: () => {
        end();
      },

      clear: async (layerId) => {
        const clip = clipOf(layerId);
        const before = clip?.directionKeys ?? [];
        if (!clip || !before.length) return;
        if (get().session?.layerId === layerId) end();
        const err = await deps.save(layerId, null);
        set({
          notice: err
            ? { text: err, action: null }
            : {
                text: t('direction.say.cleared'),
                action: { kind: 'undo', layerId, keys: before },
              },
        });
      },

      applyNotice: async () => {
        const a = get().notice?.action;
        if (!a) return;
        const clip = clipOf(a.layerId);
        const now = clip?.directionKeys?.length ? clip.directionKeys : null;
        if (get().session?.layerId === a.layerId) end();
        const err = await deps.save(a.layerId, a.keys);
        set({
          notice: err
            ? { text: err, action: null }
            : {
                text: a.kind === 'undo' ? t('direction.say.undone') : t('direction.say.redone'),
                action: {
                  kind: a.kind === 'undo' ? 'redo' : 'undo',
                  layerId: a.layerId,
                  keys: now,
                },
              },
        });
      },

      dismissNotice: () => {
        set({ notice: null });
      },
    };
  });

  // the views draw the clip from what is being edited
  store.subscribe((s, p) => {
    if (s.session === p.session) return;
    const cur = s.session;
    ws.getState().setDirectionDraft(
      cur ? { layerId: cur.layerId, keys: previewKeys(cur.keys, cur.trial) } : null,
    );
  });
  return store;
}
