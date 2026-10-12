import {
  pinTarget,
  walkHeadingAt,
  walkQuality,
  type fitWalk,
  type WalkFit,
  type WalkSurfaces,
} from '@aio/geo';
import { MAX_WALK_PINS, MODEL_SURFACE, WALK_HEIGHT_M } from '@aio/schema';
import type {
  ProjectManifest,
  WalkCalibration,
  WalkLayer,
  WalkPin,
  WalkRawPath,
} from '@aio/schema';
import { createStore, type StoreApi } from 'zustand/vanilla';
import {
  firstStep,
  surfaceFramesOf,
  surfaceKey,
  type DrawingLookup,
  type PlaceStep,
  type PlaceSurface,
} from './placeModel';

/*
 * The Place walk session (design "Placing a walk: the flow"): the steps, the pins and the live fit
 * of the one walk being placed. Nothing is written here: Save sends `calibration()`, Cancel drops
 * the session and the walk stays as it was.
 */

export type PlaceArmed = 'start' | 'end' | 'pin' | 'move' | 'align-360' | 'align-surface' | null;

/** What the session needs beyond the walk and the manifest, both known before it opens. */
export interface PlaceStartOptions {
  /** The walk's `raw-path.json`; null or absent: placed pins-only. */
  raw?: WalkRawPath | null;
  /** The drawings' picture size and provisional flag; absent: no drawing has a frame. */
  drawings?: DrawingLookup;
  /** The walk's orientation rows (`readWalkOrientationData`), so Align view heads like the pose. */
  orientation?: readonly Float64Array[] | null;
}

export interface PlaceState {
  layerId: string | null;
  step: PlaceStep;
  surface: PlaceSurface | null;
  /** Sorted by `t`. */
  pins: WalkPin[];
  yawOffsetDeg: number;
  armed: PlaceArmed;
  /** The pin the next click moves (`armed` 'move'), by index in `pins`; null otherwise. */
  moving: number | null;
  /** The 360 pane's current time, seconds. */
  timeS: number;
  dirty: boolean;
  error: string | null;
  /** Align view: the landmark's direction in the 360 (a `Ry` angle in the camera frame) and when. */
  align: { yawRad: number; t: number } | null;
  /** The live fit of the pins (null outside a session). */
  fit: WalkFit | null;
  start(walk: WalkLayer, m: ProjectManifest, opts?: PlaceStartOptions): void;
  /**
   * The date step answered (the layer's `capture` was saved): on to the surface. The session's
   * walk takes the capture; the caller lists the surfaces again (`placeSurfaces`) from the
   * patched walk, since the drawings of its date come first.
   */
  setDate(captureId: string): void;
  chooseSurface(s: PlaceSurface): void;
  setTime(t: number): void;
  /** A click on the surface (drawing: image px; map: model x/z): drops the armed pin, or aligns. */
  click(surfaceAt: [number, number], y?: number): void;
  pinHere(): void;
  movePin(i: number, at: [number, number], y?: number): void;
  /**
   * Arm a click that moves pin `i` to the clicked spot (the other pins stay), and show its moment
   * in the 360; armed for that pin already, it lets go.
   */
  armMove(i: number): void;
  removePin(i: number): void;
  armAlign(): void;
  align360(yawRad: number): void;
  setYaw(deg: number): void;
  /** What Save writes, with the quality of the live fit. */
  calibration(): WalkCalibration;
  cancel(): void;
}

/** A click on a drawing whose picture size or corners are not known yet. */
export const DRAWING_NOT_READY = 'That drawing is not ready';

export const MAX_PINS_ERROR = `A walk takes at most ${MAX_WALK_PINS} pins`;

/** Degrees wrapped to -180..180 (180 stays 180, -180 reads 180). */
export function wrapDeg(deg: number): number {
  if (!Number.isFinite(deg)) return 0;
  const r = (((deg + 180) % 360) + 360) % 360;
  return r === 0 ? 180 : r - 180;
}

const byT = (pins: readonly WalkPin[]): WalkPin[] =>
  pins
    .map((p, i) => ({ p, i }))
    .sort((a, b) => a.p.t - b.p.t || a.i - b.i)
    .map(({ p }) => p);

const idle = {
  layerId: null,
  step: 'surface' as PlaceStep,
  surface: null,
  pins: [] as WalkPin[],
  yawOffsetDeg: 0,
  armed: null as PlaceArmed,
  moving: null as number | null,
  timeS: 0,
  dirty: false,
  error: null,
  align: null,
  fit: null,
};

export function createPlaceStore(deps: {
  fit: typeof fitWalk;
  seek: (t: number) => void;
}): StoreApi<PlaceState> {
  let walk: WalkLayer | null = null;
  let raw: WalkRawPath | null = null;
  let frames: WalkSurfaces = { drawing: () => null };
  let orientation: readonly Float64Array[] | null = null;
  /** The time a Pin here pin waiting for its click belongs to (start and end take the time shown). */
  let armedT = 0;

  return createStore<PlaceState>()((set, get) => {
    const fitOf = (pins: readonly WalkPin[], yawOffsetDeg: number): WalkFit | null =>
      walk ? deps.fit(raw, { pins: [...pins], yawOffsetDeg }, frames, walk.durationS) : null;

    /** New pins: sorted, refitted, the session marked changed. */
    const setPins = (pins: readonly WalkPin[], extra: Partial<PlaceState> = {}): void => {
      const sorted = byT(pins);
      const fit = fitOf(sorted, get().yawOffsetDeg);
      set({ pins: sorted, fit, dirty: true, error: fit?.error ?? null, ...extra });
    };

    const startT = (): number => raw?.walking?.startT ?? 0;
    const endT = (): number => raw?.walking?.endT ?? walk?.durationS ?? 0;

    const jump = (t: number): void => {
      set({ timeS: t });
      deps.seek(t);
    };

    /** The step that the pins call for: start with none, end with one, else correct. */
    const stepForPins = (count: number): void => {
      if (count === 0) {
        set({ step: 'start', armed: 'start' });
        jump(startT());
      } else if (count === 1) {
        set({ step: 'end', armed: 'end' });
        jump(endT());
      } else set({ step: 'correct', armed: null });
    };

    const pinAt = (t: number, at: [number, number], y: number | undefined): WalkPin | null => {
      const s = get().surface;
      if (!s) return null;
      const pin: WalkPin = { t, surface: surfaceKey(s), at: [at[0], at[1]] };
      if (s.kind === 'map' && y !== undefined && Number.isFinite(y)) pin.y = y;
      return pin;
    };

    return {
      ...idle,

      start: (w, m, opts = {}) => {
        walk = w;
        raw = opts.raw ?? null;
        orientation = opts.orientation ?? null;
        frames = surfaceFramesOf(m, opts.drawings ?? (() => undefined));
        armedT = 0;
        const pins = byT(w.place?.pins ?? []);
        const yawOffsetDeg = w.place?.yawOffsetDeg ?? 0;
        const fit = fitOf(pins, yawOffsetDeg);
        set({
          ...idle,
          layerId: w.id,
          step: firstStep(w),
          pins,
          yawOffsetDeg,
          fit,
        });
      },

      setDate: (captureId) => {
        if (!walk || get().layerId === null || get().step !== 'date') return;
        walk = { ...walk, capture: captureId };
        set({ step: 'surface' });
      },

      chooseSurface: (s) => {
        if (get().layerId === null || get().step === 'date') return;
        set({ surface: s, error: null, align: null });
        stepForPins(get().pins.length);
      },

      setTime: (t) => {
        if (Number.isFinite(t)) set({ timeS: t });
      },

      click: (surfaceAt, y) => {
        const st = get();
        if (st.layerId === null || !st.surface) return;
        if (st.armed === 'align-surface') {
          finishAlign(surfaceAt, y);
          return;
        }
        if (st.armed === 'move') {
          moveArmed(surfaceAt, y);
          return;
        }
        if (st.armed !== 'start' && st.armed !== 'end' && st.armed !== 'pin') return;
        if (st.surface.kind === 'drawing' && !frames.drawing(st.surface.id)) {
          set({ error: DRAWING_NOT_READY });
          return;
        }
        const pin = pinAt(st.armed === 'pin' ? armedT : st.timeS, surfaceAt, y);
        if (!pin) return;
        if (st.armed === 'start') {
          setPins([pin], { step: 'end', armed: 'end' });
          jump(endT());
          return;
        }
        if (st.armed === 'end') {
          const next = byT([...st.pins, pin]);
          const fit = fitOf(next, st.yawOffsetDeg);
          if (fit?.error) {
            // refused (closer than 5 m): the start pin stays, the end is asked again
            set({ error: fit.error });
            return;
          }
          setPins(next, { step: 'correct', armed: null });
          return;
        }
        setPins([...st.pins, pin], { armed: null });
      },

      pinHere: () => {
        const st = get();
        if (st.layerId === null || st.step !== 'correct' || !st.surface) return;
        if (st.pins.length >= MAX_WALK_PINS) {
          set({ error: MAX_PINS_ERROR });
          return;
        }
        armedT = st.timeS;
        set({ armed: 'pin', moving: null, align: null });
      },

      movePin: (i, at, y) => {
        const st = get();
        const old = st.pins[i];
        if (st.layerId === null || !old) return;
        const moved: WalkPin = { ...old, at: [at[0], at[1]] };
        if (old.surface === MODEL_SURFACE && y !== undefined && Number.isFinite(y)) moved.y = y;
        setPins(st.pins.map((p, k) => (k === i ? moved : p)));
      },

      armMove: (i) => {
        const st = get();
        const pin = st.pins[i];
        if (st.layerId === null || !st.surface || !pin) return;
        if (st.armed === 'move' && st.moving === i) {
          set({ armed: stepArmed(), moving: null });
          return;
        }
        set({ armed: 'move', moving: i, align: null, error: null });
        jump(pin.t);
      },

      removePin: (i) => {
        const st = get();
        if (st.layerId === null || !st.pins[i]) return;
        const pins = st.pins.filter((_, k) => k !== i);
        const aligning = st.armed === 'align-360' || st.armed === 'align-surface';
        const moving = st.armed === 'move';
        setPins(
          pins,
          aligning || moving
            ? { armed: moving ? stepArmed() : null, align: null, moving: null }
            : {},
        );
        if (st.surface && pins.length < 2) stepForPins(pins.length);
      },

      armAlign: () => {
        const st = get();
        if (st.layerId === null || st.step !== 'correct') return;
        set({ armed: 'align-360', moving: null, align: null });
      },

      align360: (yawRad) => {
        const st = get();
        if (st.armed !== 'align-360' || !Number.isFinite(yawRad)) return;
        set({ armed: 'align-surface', align: { yawRad, t: st.timeS } });
      },

      setYaw: (deg) => {
        const st = get();
        if (st.layerId === null) return;
        const yawOffsetDeg = wrapDeg(deg);
        set({ yawOffsetDeg, fit: fitOf(st.pins, yawOffsetDeg), dirty: true });
      },

      calibration: () => {
        const st = get();
        const fit = st.fit ?? fitOf(st.pins, st.yawOffsetDeg);
        const cal: WalkCalibration = {
          pins: st.pins.map((p) => ({ ...p, at: [p.at[0], p.at[1]] })),
          yawOffsetDeg: st.yawOffsetDeg,
          heightM: walk?.place?.heightM ?? WALK_HEIGHT_M,
          quality: fit ? walkQuality(fit) : 'unplaced',
        };
        const placedOn = st.surface ? surfaceKey(st.surface) : walk?.place?.placedOn;
        if (placedOn !== undefined) cal.placedOn = placedOn;
        return cal;
      },

      cancel: () => {
        walk = null;
        raw = null;
        orientation = null;
        frames = { drawing: () => null };
        armedT = 0;
        set({ ...idle });
      },
    };

    /** What waits for a click in the step in hand (start and end ask for theirs). */
    function stepArmed(): PlaceArmed {
      const step = get().step;
      return step === 'start' || step === 'end' ? step : null;
    }

    /** The click of a Move: pin `moving` to the spot on the surface in hand, the others stay. */
    function moveArmed(surfaceAt: [number, number], y: number | undefined): void {
      const st = get();
      const old = st.moving === null ? undefined : st.pins[st.moving];
      if (!old || !st.surface) return;
      if (st.surface.kind === 'drawing' && !frames.drawing(st.surface.id)) {
        set({ error: DRAWING_NOT_READY });
        return;
      }
      const pin = pinAt(old.t, surfaceAt, y);
      if (!pin) return;
      const next = st.pins.map((p, k) => (k === st.moving ? pin : p));
      const refused = next.length >= 2 ? (fitOf(next, st.yawOffsetDeg)?.error ?? null) : null;
      if (refused) {
        // refused (the start and end closer than 5 m): the pin stays, the spot is asked again
        set({ error: refused });
        return;
      }
      const back = stepArmed();
      setPins(next, { armed: back, moving: null });
      if (back === 'end') jump(endT());
    }

    /**
     * Align view, second click: the yaw offset that turns the 360's direction to the landmark onto
     * the direction from the camera (the fit at the landmark's time) to the clicked spot.
     */
    function finishAlign(surfaceAt: [number, number], y: number | undefined): void {
      const st = get();
      const s = st.surface;
      if (!st.align || !st.fit || !s) return;
      const target = pinTarget(
        { t: st.align.t, surface: surfaceKey(s), at: surfaceAt, ...(y === undefined ? {} : { y }) },
        frames,
      );
      const cam = st.fit.at(st.align.t);
      if (!target || !cam) {
        set({ armed: null, align: null, ...(target ? {} : { error: DRAWING_NOT_READY }) });
        return;
      }
      const dx = target.xz[0] - cam.xz[0];
      const dz = target.xz[1] - cam.xz[1];
      if (Math.hypot(dx, dz) < 1e-9) {
        set({ armed: null, align: null });
        return;
      }
      // a Ry angle: 0 looks down -Z, positive turns towards -X
      const bearing = Math.atan2(-dx, -dz);
      // the heading the pose file will have (orientation rows included), so the save matches
      const heading = walkHeadingAt(st.fit, orientation, st.align.t) ?? cam.headingRad;
      const deg = ((bearing - heading - st.align.yawRad) * 180) / Math.PI;
      const yawOffsetDeg = wrapDeg(deg);
      set({
        yawOffsetDeg,
        fit: fitOf(st.pins, yawOffsetDeg),
        armed: null,
        align: null,
        dirty: true,
      });
    }
  });
}
