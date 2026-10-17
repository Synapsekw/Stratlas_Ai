import {
  bearingDeg,
  bearingDiffDeg,
  DEFAULT_EYE_M,
  headingFromPair,
  headingFromPairs,
  wrap360,
  type LandmarkPair,
} from '@aio/geo';
import type { LayerPatchInput, MediaPinInput, ProjectManifest, Vec3 } from '@aio/schema';
import type { MessageKey } from '@aio/ui';
import { createStore, type StoreApi } from 'zustand/vanilla';
import { toDraw, toStore } from './pinFrame';
import { mediaItem, type MediaKey } from './pinModel';

/*
 * The placing session of one photo or 360 (pinned media design): pick the ground, then line a 360
 * up by landmark pairs (a click in the 360, then the same landmark on the site) or aim a photo.
 * Every step saves at once (the pin appears on the surface click, the heading after each pair or
 * aim), so Cancel only ends the session. Points come in drawn (as picked) and are stored through
 * `toStore`; bearings use drawn points on both sides.
 *
 * Saves run one at a time. Each action updates the intended pin at once and queues a write that
 * sends the latest intended pin when its turn comes, so the last thing the person did is what
 * lands on disk, whatever order the saves resolve in. The writer owns `gps`: it is never sent.
 */

export type PinStep = 'pick' | 'pano' | 'scene' | 'more' | 'aim';
export type PinMode = 'place' | 'move' | 'direction';

export interface PinState {
  target: MediaKey | null;
  mode: PinMode;
  step: PinStep;
  /** The pin's ground, stored frame; null until it is picked. */
  ground: Vec3 | null;
  eyeM: number;
  /** The landmark pairs of this line-up (at most two). */
  pairs: LandmarkPair[];
  /** The landmark's bearing in the 360 waiting for its click on the site. */
  pendingOffsetDeg: number | null;
  /** The ground came from a pick with no height (the map with no model): it sits at 0 m. */
  heightUnknown: boolean;
  note: MessageKey | null;
  saving: boolean;
  error: string | null;
}

export interface PinActions {
  begin(k: MediaKey, mode: PinMode): void;
  /** A click on the model, the cloud or the map; `heightKnown` false: `y` is a stand-in 0. */
  pickSurface(drawn: Vec3, heightKnown: boolean): Promise<void>;
  /** A landmark clicked in the 360: its bearing in the 360's own frame. */
  pickPano(offsetDeg: number): void;
  /** The same landmark clicked on the site. */
  pickLandmark(drawn: Vec3): Promise<void>;
  /** A click towards where the photo looks. */
  aim(drawn: Vec3): Promise<void>;
  /** A heading set directly (the 3D arrow drag). */
  setHeading(deg: number): Promise<void>;
  setEyeM(m: number): Promise<void>;
  done(): void;
  cancel(): void;
}

export interface PinDeps {
  manifest(): ProjectManifest | null;
  /** Saves a layer patch; resolves to an error message, or null when saved. */
  save(layerId: string, patch: LayerPatchInput): Promise<string | null>;
  openPanoBeside(layerId: string, panoId: string): void;
}

/** A second pair further than this from the first means the landmarks disagree. */
export const MAX_PAIR_SPREAD_DEG = 45;

const MAX_EYE_M = 10;

const idle = {
  target: null,
  mode: 'place' as PinMode,
  step: 'pick' as PinStep,
  ground: null,
  eyeM: DEFAULT_EYE_M,
  pairs: [] as LandmarkPair[],
  pendingOffsetDeg: null,
  heightUnknown: false,
  note: null,
  saving: false,
  error: null,
};

/** One session: its item, the pin as last saved and the pin the person means now. */
interface Session {
  k: MediaKey;
  /** The pin on disk (or the item's place it starts from); null: none yet. */
  disk: MediaPinInput | null;
  /** The pin the latest action asked for; every queued write sends this. */
  intent: MediaPinInput | null;
  /** Writes queued or running. */
  inFlight: number;
  /** A surface pick waits for its save (a second click is ignored). */
  picking: boolean;
}

/** The fields the store writes (`gps` belongs to the writer). */
const clean = (p: MediaPinInput): MediaPinInput => ({
  ground: [p.ground[0], p.ground[1], p.ground[2]],
  ...(p.eyeM === undefined ? {} : { eyeM: p.eyeM }),
  ...(p.headingDeg === undefined ? {} : { headingDeg: p.headingDeg }),
});

const same = (a: MediaPinInput | null, b: MediaPinInput | null): boolean =>
  JSON.stringify(a) === JSON.stringify(b);

export function createPinStore(deps: PinDeps): StoreApi<PinState & PinActions> {
  let cur: Session | null = null;
  /** The tail of the write queue (shared, so a new session's writes wait for the old ones). */
  let chain: Promise<unknown> = Promise.resolve();

  return createStore<PinState & PinActions>()((set, get) => {
    const end = (): void => {
      cur = null;
      set({ ...idle });
    };

    /** The session, or null after ending it (its item went from the manifest). */
    const live = (): { m: ProjectManifest; c: Session } | null => {
      const c = cur;
      if (!c) return null;
      const m = deps.manifest();
      if (!m || !mediaItem(m, c.k)) {
        end();
        return null;
      }
      return { m, c };
    };

    /**
     * Makes `next` the intended pin and queues a write of the latest intent. True when it saved
     * and the session is still open; on a failure the session shows what is on disk again.
     */
    const write = async (c: Session, next: MediaPinInput): Promise<boolean> => {
      c.intent = next;
      c.inFlight++;
      if (cur === c) set({ saving: true, error: null });
      const run = chain.then(async (): Promise<string | null> => {
        const pin = c.intent;
        if (!pin || same(pin, c.disk)) return null;
        const err = await deps.save(c.k.layerId, { mediaPin: { itemId: c.k.itemId, pin } });
        if (err === null) c.disk = pin;
        return err;
      });
      chain = run.catch(() => undefined);
      let err: string | null;
      try {
        err = await run;
      } catch (e) {
        err = e instanceof Error ? e.message : String(e);
      }
      c.inFlight--;
      if (cur !== c) return false;
      if (err !== null) {
        c.intent = c.disk;
        set({
          saving: c.inFlight > 0,
          error: err,
          eyeM: c.disk?.eyeM ?? DEFAULT_EYE_M,
          ground: get().step === 'pick' ? null : (c.disk?.ground ?? null),
        });
        return false;
      }
      if (c.inFlight === 0) set({ saving: false });
      return true;
    };

    const withHeading = (c: Session, deg: number): MediaPinInput | null =>
      c.intent ? { ...c.intent, headingDeg: wrap360(deg) } : null;

    /** The pin's ground where it draws, for bearings against drawn clicks. */
    const drawnGround = (m: ProjectManifest, c: Session): Vec3 | null =>
      c.intent ? toDraw(c.intent.ground, m, c.k.layerId) : null;

    return {
      ...idle,

      begin: (k, mode) => {
        cur = null;
        const m = deps.manifest();
        const item = m ? mediaItem(m, k) : null;
        if (!item) {
          set({ ...idle });
          return;
        }
        const eyeM = item.pin?.eyeM ?? DEFAULT_EYE_M;
        let start: MediaPinInput | null = item.pin ? clean(item.pin) : null;
        // a GPS item without a pin: its ground is under the camera
        if (!start && item.pos && mode === 'direction')
          start = { ground: [item.pos[0], item.pos[1] - eyeM, item.pos[2]], eyeM };
        cur = { k, disk: start, intent: start, inFlight: 0, picking: false };
        const aimable = mode === 'direction' && start !== null;
        const step: PinStep = !aimable ? 'pick' : k.kind === 'pano' ? 'pano' : 'aim';
        const ground = aimable && start ? start.ground : null;
        set({ ...idle, target: k, mode, step, ground, eyeM });
        if (aimable && k.kind === 'pano') deps.openPanoBeside(k.layerId, k.itemId);
      },

      pickSurface: async (drawn, heightKnown) => {
        const s = live();
        if (!s || get().step !== 'pick' || s.c.picking) return;
        const { m, c } = s;
        const ground = toStore(drawn, m, c.k.layerId);
        // the heading stays (a 360 keeps the heading it has; a photo keeps its aim)
        const heading = c.intent?.headingDeg;
        const next: MediaPinInput = {
          ground,
          eyeM: get().eyeM,
          ...(heading === undefined ? {} : { headingDeg: heading }),
        };
        c.picking = true;
        set({ ground });
        const ok = await write(c, next);
        c.picking = false;
        if (!ok) return;
        set({
          pairs: [],
          pendingOffsetDeg: null,
          heightUnknown: !heightKnown,
          note: heightKnown ? null : 'pin.strip.heightUnknown',
          step: c.k.kind === 'pano' ? 'pano' : 'aim',
        });
        if (c.k.kind === 'pano') deps.openPanoBeside(c.k.layerId, c.k.itemId);
      },

      pickPano: (offsetDeg) => {
        const st = get();
        if (!live() || st.target?.kind !== 'pano') return;
        if (st.step !== 'pano' && st.step !== 'more' && st.step !== 'scene') return;
        if (!Number.isFinite(offsetDeg)) return;
        set({ pendingOffsetDeg: wrap360(offsetDeg), step: 'scene', note: null });
      },

      pickLandmark: async (drawn) => {
        const s = live();
        const st = get();
        // a pending offset is used once: a second click while its save runs is ignored
        if (!s || st.step !== 'scene' || st.pendingOffsetDeg === null) return;
        const { m, c } = s;
        const from = drawnGround(m, c);
        if (!from) return;
        const worldDeg = bearingDeg(from, drawn);
        if (worldDeg === null) {
          set({ note: 'pin.strip.tooClose' });
          return;
        }
        const pair: LandmarkPair = { offsetDeg: st.pendingOffsetDeg, worldDeg };
        const undo = { pairs: st.pairs, pendingOffsetDeg: st.pendingOffsetDeg };
        const first = st.pairs[0];
        if (!first) {
          const next = withHeading(c, headingFromPair(pair));
          if (!next) return;
          set({ pairs: [pair], pendingOffsetDeg: null });
          if (await write(c, next)) set({ step: 'more', note: null });
          else if (cur === c) set(undo);
          return;
        }
        // a second pair: averaged when it agrees with the first, else the first one stays
        const spread = Math.abs(bearingDiffDeg(headingFromPair(pair), headingFromPair(first)));
        const mean = headingFromPairs([first, pair]);
        if (mean === null || spread > MAX_PAIR_SPREAD_DEG) {
          set({ pendingOffsetDeg: null, step: 'more', note: 'pin.strip.disagree' });
          return;
        }
        const next = withHeading(c, mean);
        if (!next) return;
        set({ pendingOffsetDeg: null });
        if (await write(c, next)) end();
        else if (cur === c) set(undo);
      },

      aim: async (drawn) => {
        const s = live();
        if (!s || get().step !== 'aim') return;
        const from = drawnGround(s.m, s.c);
        if (!from) return;
        const deg = bearingDeg(from, drawn);
        if (deg === null) {
          set({ note: 'pin.strip.tooClose' });
          return;
        }
        const next = withHeading(s.c, deg);
        if (next && (await write(s.c, next))) set({ note: null });
      },

      setHeading: async (deg) => {
        const s = live();
        if (!s || !Number.isFinite(deg)) return;
        const next = withHeading(s.c, deg);
        if (!next) return;
        set({ pairs: [], pendingOffsetDeg: null });
        await write(s.c, next);
      },

      setEyeM: async (value) => {
        const s = live();
        if (!s || !Number.isFinite(value)) return;
        const eyeM = Math.min(MAX_EYE_M, Math.max(0, value));
        set({ eyeM });
        if (s.c.intent && get().ground) await write(s.c, { ...s.c.intent, eyeM });
      },

      done: end,
      cancel: end,
    };
  });
}
