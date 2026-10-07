import {
  correctionTo,
  correctPos,
  correctQuat,
  directionFromQuat,
  isNoCorrection,
  sameFlightPhotos,
  type CameraDirection,
} from '@aio/geo';
import type { Layer, PhotoCorrection, PhotoRef, Quat, Vec3 } from '@aio/schema';
import { t } from '@aio/ui';
import type { Workspace } from '@aio/workspace';
import { createStore, type StoreApi } from 'zustand/vanilla';

type PhotosLayer = Extract<Layer, { kind: 'photos' }>;
type Fixes = Record<string, PhotoCorrection | null>;

/** One "Align photo to map" session: the correction being edited, not saved yet. */
export interface PhotoSession {
  layerId: string;
  photoId: string;
  /** The saved correction when the session started (Cancel and Undo go back to it). */
  original: PhotoCorrection | null;
  corr: PhotoCorrection;
  history: PhotoCorrection[];
  exact: boolean;
}

/** A saved change with Undo (or Redo), and the offer to correct the rest of the flight. */
export interface PhotoNotice {
  text: string;
  action: { kind: 'undo' | 'redo'; layerId: string; fixes: Fixes } | null;
  /** The other photos of the flight the same correction could go to. */
  flight: { layerId: string; ids: string[]; corr: PhotoCorrection } | null;
}

export interface PhotoAlignState {
  session: PhotoSession | null;
  opacity: number;
  footprint: boolean;
  say: { text: string; tone?: 'armed' | 'bad' } | null;
  notice: PhotoNotice | null;
}

export interface PhotoAlignActions {
  start(layerId: string, photoId: string): void;
  /** The photo's camera as it is shown now (with the correction being edited). */
  pose(): { pos: Vec3; q: Quat } | null;
  current(): CameraDirection | null;
  gesture(active: boolean): void;
  turn(patch: Partial<CameraDirection>): void;
  /** Move the camera: metres east, up and south (local frame) from where it was imported. */
  setOffset(offset: Vec3): void;
  reset(): void;
  undo(): void;
  setExact(open: boolean): void;
  setOpacity(v: number): void;
  setFootprint(on: boolean): void;
  done(): Promise<void>;
  cancel(): void;
  /** Remove a photo's correction (saved), with Undo. */
  resetSaved(layerId: string, photoId: string): Promise<void>;
  applyNotice(): Promise<void>;
  /** Give the other photos of the flight the same correction. */
  applyToFlight(): Promise<void>;
  dismissNotice(): void;
}

export type PhotoAlignStore = PhotoAlignState & PhotoAlignActions;

export interface PhotoAlignDeps {
  workspace: StoreApi<Workspace>;
  /** Save photo corrections of a set (`null` clears one); an error text or null. */
  save(layerId: string, fixes: Fixes): Promise<string | null>;
  showBoth(): void;
}

const ZERO: PhotoCorrection = { yawDeg: 0, pitchDeg: 0, rollDeg: 0 };
const MERGE_MS = 800;

export function createPhotoAlignStore(deps: PhotoAlignDeps): StoreApi<PhotoAlignStore> {
  const ws = deps.workspace;
  let inGesture = false;
  let lastTurn = 0;

  return createStore<PhotoAlignStore>()((set, get) => {
    const setOf = (id: string): PhotosLayer | null => {
      const l = ws.getState().project?.manifest.layers.find((x) => x.id === id);
      return l?.kind === 'photos' ? l : null;
    };
    const photoOf = (layerId: string, photoId: string): PhotoRef | null =>
      setOf(layerId)?.items.find((p) => p.id === photoId) ?? null;
    const patch = (p: Partial<PhotoSession>) => {
      const s = get().session;
      if (s) set({ session: { ...s, ...p } });
    };
    const push = (s: PhotoSession) => [...s.history, s.corr].slice(-100);
    const end = () => {
      inGesture = false;
      set({ session: null, say: null });
    };
    /** The other photos of the flight with a pose (what "the same correction" can go to). */
    const flightOthers = (layerId: string, photo: PhotoRef): string[] => {
      const items = setOf(layerId)?.items ?? [];
      return sameFlightPhotos(items, photo)
        .filter((p) => p.id !== photo.id && p.q && p.pos)
        .map((p) => p.id);
    };

    return {
      session: null,
      opacity: 0.6,
      footprint: true,
      say: null,
      notice: null,

      start: (layerId, photoId) => {
        const p = photoOf(layerId, photoId);
        if (!p?.pos || !p.q) return;
        const s = get().session;
        if (s?.layerId === layerId && s.photoId === photoId) return;
        const w = ws.getState();
        w.select({ kind: 'photo', id: photoId, layer: layerId });
        deps.showBoth();
        set({
          session: {
            layerId,
            photoId,
            original: p.correction ?? null,
            corr: p.correction ?? ZERO,
            history: [],
            exact: false,
          },
          say: { text: t('photoAlign.help') },
        });
      },

      pose: () => {
        const s = get().session;
        const p = s ? photoOf(s.layerId, s.photoId) : null;
        if (!s || !p?.pos || !p.q) return null;
        return { pos: correctPos(p.pos, s.corr), q: correctQuat(p.q, s.corr) };
      },

      current: () => {
        const p = get().pose();
        return p ? directionFromQuat(p.q) : null;
      },

      gesture: (active) => {
        const s = get().session;
        if (active && !inGesture && s) patch({ history: push(s) });
        inGesture = active;
      },

      turn: (d) => {
        const s = get().session;
        const p = s ? photoOf(s.layerId, s.photoId) : null;
        const cur = get().current();
        if (!s || !p?.q || !cur) return;
        const now = Date.now();
        const history = inGesture || now - lastTurn < MERGE_MS ? s.history : push(s);
        lastTurn = now;
        const corr = correctionTo(p.q, { ...cur, ...d }, s.corr.offsetM);
        patch({ corr, history });
      },

      setOffset: (offset) => {
        const s = get().session;
        if (!s) return;
        const r = (v: number) => Math.round(v * 1000) / 1000;
        const o = offset.map(r) as Vec3;
        const corr: PhotoCorrection = { ...s.corr };
        if (o.some((v) => v !== 0)) corr.offsetM = o;
        else delete corr.offsetM;
        patch({ corr, history: push(s) });
      },

      reset: () => {
        const s = get().session;
        if (s) patch({ corr: ZERO, history: push(s) });
      },

      undo: () => {
        const s = get().session;
        if (!s) {
          if (get().notice?.action) void get().applyNotice();
          return;
        }
        const prev = s.history[s.history.length - 1];
        if (!prev) {
          set({ say: { text: t('direction.say.nothingToUndo') } });
          return;
        }
        patch({ corr: prev, history: s.history.slice(0, -1) });
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

      done: async () => {
        const s = get().session;
        const p = s ? photoOf(s.layerId, s.photoId) : null;
        if (!s || !p) return;
        const next = isNoCorrection(s.corr) ? null : s.corr;
        if (JSON.stringify(next) === JSON.stringify(s.original)) {
          end();
          return;
        }
        const err = await deps.save(s.layerId, { [s.photoId]: next });
        if (err) {
          set({ say: { text: err, tone: 'bad' } });
          return;
        }
        const others = next ? flightOthers(s.layerId, p) : [];
        set({
          notice: {
            text: next ? t('photoAlign.saved') : t('photoAlign.cleared'),
            action: { kind: 'undo', layerId: s.layerId, fixes: { [s.photoId]: s.original } },
            flight: next && others.length ? { layerId: s.layerId, ids: others, corr: next } : null,
          },
        });
        end();
      },

      cancel: () => {
        end();
      },

      resetSaved: async (layerId, photoId) => {
        const p = photoOf(layerId, photoId);
        if (!p?.correction) return;
        const before = p.correction;
        if (get().session?.photoId === photoId) end();
        const err = await deps.save(layerId, { [photoId]: null });
        set({
          notice: err
            ? { text: err, action: null, flight: null }
            : {
                text: t('photoAlign.cleared'),
                action: { kind: 'undo', layerId, fixes: { [photoId]: before } },
                flight: null,
              },
        });
      },

      applyNotice: async () => {
        const a = get().notice?.action;
        if (!a) return;
        const now: Fixes = {};
        for (const id of Object.keys(a.fixes)) now[id] = photoOf(a.layerId, id)?.correction ?? null;
        const s = get().session;
        if (s?.layerId === a.layerId && s.photoId in a.fixes) end();
        const err = await deps.save(a.layerId, a.fixes);
        set({
          notice: err
            ? { text: err, action: null, flight: null }
            : {
                text: a.kind === 'undo' ? t('direction.say.undone') : t('direction.say.redone'),
                action: {
                  kind: a.kind === 'undo' ? 'redo' : 'undo',
                  layerId: a.layerId,
                  fixes: now,
                },
                flight: null,
              },
        });
      },

      applyToFlight: async () => {
        const f = get().notice?.flight;
        if (!f) return;
        const before: Fixes = {};
        const fixes: Fixes = {};
        for (const id of f.ids) {
          before[id] = photoOf(f.layerId, id)?.correction ?? null;
          fixes[id] = f.corr;
        }
        const err = await deps.save(f.layerId, fixes);
        set({
          notice: err
            ? { text: err, action: null, flight: null }
            : {
                text: t('photoAlign.appliedFlight', { count: f.ids.length }),
                action: { kind: 'undo', layerId: f.layerId, fixes: before },
                flight: null,
              },
        });
      },

      dismissNotice: () => {
        set({ notice: null });
      },
    };
  });
}
