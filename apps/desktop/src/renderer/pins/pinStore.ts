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

export function createPinStore(deps: PinDeps): StoreApi<PinState & PinActions> {
  /** The pin as last saved (or as the item had it): the base every save builds on. */
  let pin: MediaPinInput | null = null;
  /** Bumped by every begin, done and cancel: a save that resolves later is dropped. */
  let session = 0;

  return createStore<PinState & PinActions>()((set, get) => {
    const end = (): void => {
      session++;
      pin = null;
      set({ ...idle });
    };

    /** The session's manifest, or null after ending the session (its item went). */
    const live = (): { m: ProjectManifest; k: MediaKey } | null => {
      const k = get().target;
      if (!k) return null;
      const m = deps.manifest();
      if (!m || !mediaItem(m, k)) {
        end();
        return null;
      }
      return { m, k };
    };

    /** Saves `next`; true when it was saved and the session is still the same. */
    const write = async (k: MediaKey, next: MediaPinInput): Promise<boolean> => {
      const at = session;
      set({ saving: true, error: null });
      const err = await deps.save(k.layerId, { mediaPin: { itemId: k.itemId, pin: next } });
      if (at !== session) return false;
      if (err !== null) {
        set({ saving: false, error: err });
        return false;
      }
      pin = next;
      set({ saving: false });
      return true;
    };

    const withHeading = (deg: number): MediaPinInput | null =>
      pin ? { ...pin, headingDeg: wrap360(deg) } : null;

    /** The pin's ground where it draws, for bearings against drawn clicks. */
    const drawnGround = (m: ProjectManifest, k: MediaKey): Vec3 | null =>
      pin ? toDraw(pin.ground, m, k.layerId) : null;

    return {
      ...idle,

      begin: (k, mode) => {
        session++;
        pin = null;
        const m = deps.manifest();
        const item = m ? mediaItem(m, k) : null;
        if (!item) {
          set({ ...idle });
          return;
        }
        const eyeM = item.pin?.eyeM ?? DEFAULT_EYE_M;
        if (item.pin) pin = { ...item.pin };
        // a GPS item without a pin: its ground is under the camera
        else if (item.pos && mode === 'direction')
          pin = { ground: [item.pos[0], item.pos[1] - eyeM, item.pos[2]], eyeM };
        const aimable = mode === 'direction' && pin !== null;
        const step: PinStep = !aimable ? 'pick' : k.kind === 'pano' ? 'pano' : 'aim';
        set({ ...idle, target: k, mode, step, ground: aimable && pin ? pin.ground : null, eyeM });
        if (aimable && k.kind === 'pano') deps.openPanoBeside(k.layerId, k.itemId);
      },

      pickSurface: async (drawn, heightKnown) => {
        const s = live();
        if (!s || get().step !== 'pick') return;
        const { m, k } = s;
        const ground = toStore(drawn, m, k.layerId);
        const eyeM = get().eyeM;
        // a move keeps the heading; a new place starts without one (both keep the GPS place)
        const base: Partial<MediaPinInput> =
          get().mode === 'move' ? { ...pin } : pin?.gps ? { gps: pin.gps } : {};
        if (!(await write(k, { ...base, ground, eyeM }))) return;
        set({
          ground,
          pairs: [],
          pendingOffsetDeg: null,
          heightUnknown: !heightKnown,
          note: heightKnown ? null : 'pin.strip.heightUnknown',
          step: k.kind === 'pano' ? 'pano' : 'aim',
        });
        if (k.kind === 'pano') deps.openPanoBeside(k.layerId, k.itemId);
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
        if (!s || st.step !== 'scene' || st.pendingOffsetDeg === null) return;
        const from = drawnGround(s.m, s.k);
        if (!from) return;
        const worldDeg = bearingDeg(from, drawn);
        if (worldDeg === null) {
          set({ note: 'pin.strip.tooClose' });
          return;
        }
        const pair: LandmarkPair = { offsetDeg: st.pendingOffsetDeg, worldDeg };
        const first = st.pairs[0];
        if (!first) {
          const next = withHeading(headingFromPair(pair));
          if (!next || !(await write(s.k, next))) return;
          set({ pairs: [pair], pendingOffsetDeg: null, step: 'more', note: null });
          return;
        }
        // a second pair: averaged when it agrees with the first, else the first one stays
        const spread = Math.abs(bearingDiffDeg(headingFromPair(pair), headingFromPair(first)));
        const mean = headingFromPairs([first, pair]);
        if (mean === null || spread > MAX_PAIR_SPREAD_DEG) {
          set({ pendingOffsetDeg: null, step: 'more', note: 'pin.strip.disagree' });
          return;
        }
        const next = withHeading(mean);
        if (!next || !(await write(s.k, next))) return;
        end();
      },

      aim: async (drawn) => {
        const s = live();
        if (!s || get().step !== 'aim') return;
        const from = drawnGround(s.m, s.k);
        if (!from) return;
        const deg = bearingDeg(from, drawn);
        if (deg === null) {
          set({ note: 'pin.strip.tooClose' });
          return;
        }
        const next = withHeading(deg);
        if (next && (await write(s.k, next))) set({ note: null });
      },

      setHeading: async (deg) => {
        const s = live();
        if (!s || !Number.isFinite(deg)) return;
        const next = withHeading(deg);
        if (next && (await write(s.k, next))) set({ pairs: [], pendingOffsetDeg: null });
      },

      setEyeM: async (value) => {
        const s = live();
        if (!s || !Number.isFinite(value)) return;
        const eyeM = Math.min(MAX_EYE_M, Math.max(0, value));
        set({ eyeM });
        if (pin && get().ground) await write(s.k, { ...pin, eyeM });
      },

      done: end,
      cancel: end,
    };
  });
}
