import {
  ghostLengthM,
  ghostPath,
  MIN_PIN_SPAN_M,
  pinTarget,
  previewPath,
  walkHeadingAt,
  walkOutline,
  walkQuality,
  type fitWalk,
  type WalkFit,
  type WalkOutline,
  type WalkSurfaces,
  type XZ,
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
  surfaceFramesOf,
  surfaceKey,
  type DrawingLookup,
  type PlaceStep,
  type PlaceSurface,
} from './placeModel';

/*
 * The Place walk session (design "Walk placing by start and end"): the phases `check` (the walk
 * has no usable path yet), `start`, `end`, `placed` and `fine-tune`, the pins, the live fit, the
 * hover preview and the handle drags of the one walk being placed. Nothing is written here: Save
 * sends `calibration()`, Cancel drops the session and the walk stays as it was.
 */

export type PlaceArmed = 'pin' | 'move' | 'align-360' | 'align-surface' | null;

/** The two handles of a placed walk: Start is the first pin by time, End the last. */
export type PlaceHandle = 'start' | 'end';

export interface PlacePreview {
  /** Model x/z of the shape: the ghost before the start, laid between start and cursor after it. */
  xz: XZ[];
  /**
   * The same shape on the surface in hand, for drawing it: image px on a drawing (the model x/z
   * taken back through the drawing's frame), model x/z on the map and the 3D view.
   */
  at: [number, number][];
  ghost: boolean;
  /** The cursor is closer than 5 m to the start: an end click there is ignored. */
  tooClose: boolean;
  /** Ground heights at the shape's first and last point (map and 3D), when known. */
  y: [number, number] | null;
}

/** What the session needs beyond the walk and the manifest, both known before it opens. */
export interface PlaceStartOptions {
  /** The walk's `raw-path.json`; null or absent: placed pins-only. */
  raw?: WalkRawPath | null;
  /** The drawings' picture size and provisional flag; absent: no drawing has a frame. */
  drawings?: DrawingLookup;
  /** The walk's orientation rows (`readWalkOrientationData`), so Align view heads like the pose. */
  orientation?: readonly Float64Array[] | null;
  /** The path is ready (`walkPathState` 'ready'); default: the raw path is usable. */
  ready?: boolean;
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
  /** The shape under the cursor while Start or End waits for its click; null otherwise. */
  preview: PlacePreview | null;
  /** The handle being dragged; `refused` while the last spot was within 5 m of the other end. */
  dragging: { handle: PlaceHandle; refused: boolean } | null;
  start(walk: WalkLayer, m: ProjectManifest, opts?: PlaceStartOptions): void;
  /**
   * The walk's path was read again (or processed, or went): the session refits. A path that
   * appears moves the check on to Start; one that goes drops the draft pins and shows the check.
   */
  setInputs(
    raw: WalkRawPath | null,
    orientation: readonly Float64Array[] | null,
    ready: boolean,
  ): void;
  /** The check's Place between two points anyway: on to Start without a path. */
  placeAnyway(): void;
  /** The survey date chosen: the session's walk takes the capture. */
  setDate(captureId: string): void;
  chooseSurface(s: PlaceSurface): void;
  setTime(t: number): void;
  /**
   * The pointer over the surface (drawing: image px; map and 3D: model x/z, `y` the ground
   * height), or off it (null). Ignored while a handle is dragged.
   */
  hover(at: [number, number] | null, y?: number): void;
  /** A click on the surface: the start, the end, or in fine-tune the armed pin, move or align. */
  click(at: [number, number], y?: number): void;
  /** A Start or End handle dragged to a spot: the pin moves there (keeping its time), live refit. */
  dragHandle(h: PlaceHandle, at: [number, number], y?: number): void;
  endDrag(): void;
  /** Fine-tune on (from placed) or off (back to placed). */
  setFineTune(on: boolean): void;
  pinHere(): void;
  movePin(i: number, at: [number, number], y?: number): void;
  /**
   * Arm a click that moves pin `i` to the clicked spot (the other pins stay), and show its moment
   * in the 360; armed for that pin already, it lets go. Fine-tune only.
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

/** The ghost's length on a drawing whose scale is provisional: this share of its width. */
const PROVISIONAL_GHOST = 0.3;

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
  step: 'start' as PlaceStep,
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
  preview: null as PlacePreview | null,
  dragging: null as PlaceState['dragging'],
};

export function createPlaceStore(deps: {
  fit: typeof fitWalk;
  seek: (t: number) => void;
}): StoreApi<PlaceState> {
  let walk: WalkLayer | null = null;
  let raw: WalkRawPath | null = null;
  let outline: WalkOutline | null = null;
  let frames: WalkSurfaces = { drawing: () => null };
  let lookup: DrawingLookup = () => undefined;
  let orientation: readonly Float64Array[] | null = null;
  /** The time a Pin here pin waiting for its click belongs to. */
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

    /** The step the pins call for: Start with none, End with one, else placed (or fine-tune). */
    const stepForPins = (count: number): void => {
      if (count === 0) {
        set({ step: 'start', armed: null, moving: null, preview: null });
        jump(startT());
      } else if (count === 1) {
        set({ step: 'end', armed: null, moving: null, preview: null });
        jump(endT());
      } else {
        const step = get().step === 'fine-tune' ? 'fine-tune' : 'placed';
        set({ step, armed: null, moving: null, preview: null });
      }
    };

    const pinAt = (t: number, at: [number, number], y: number | undefined): WalkPin | null => {
      const s = get().surface;
      if (!s) return null;
      const pin: WalkPin = { t, surface: surfaceKey(s), at: [at[0], at[1]] };
      if (s.kind !== 'drawing' && y !== undefined && Number.isFinite(y)) pin.y = y;
      return pin;
    };

    /** A spot on the surface in hand, in the model frame (null: a drawing not ready). */
    const modelOf = (at: [number, number]): XZ | null => {
      const s = get().surface;
      if (!s) return null;
      return pinTarget({ t: 0, surface: surfaceKey(s), at }, frames)?.xz ?? null;
    };

    /** Model x/z back onto the surface in hand: image px on a drawing (its frame inverted). */
    const surfaceOf = (xz: readonly XZ[]): [number, number][] | null => {
      const s = get().surface;
      if (s?.kind !== 'drawing') return xz.map((p) => [p[0], p[1]]);
      const f = frames.drawing(s.id);
      if (!f) return null;
      const det = f.a * f.d - f.b * f.c;
      if (!(Math.abs(det) > 1e-12)) return null;
      return xz.map(([x, z]) => {
        const dx = x - f.tx;
        const dz = z - f.tz;
        return [(f.d * dx - f.b * dz) / det, (f.a * dz - f.c * dx) / det];
      });
    };

    /** The ghost's length: 0.7 m a step, or a share of a provisional drawing's width. */
    const ghostLength = (o: WalkOutline): number => {
      const s = get().surface;
      if (s?.kind === 'drawing') {
        const f = frames.drawing(s.id);
        const w = lookup(s.id)?.size.width ?? 0;
        if (f?.provisional && w > 0) return PROVISIONAL_GHOST * w * Math.hypot(f.a, f.c);
      }
      return ghostLengthM(o);
    };

    const previewOf = (
      xz: XZ[] | null,
      ghost: boolean,
      tooClose: boolean,
      y: [number, number] | null,
    ): PlacePreview | null => {
      const at = xz ? surfaceOf(xz) : null;
      return xz && at ? { xz, at, ghost, tooClose, y } : null;
    };

    /** Off the check: the step the pins call for. */
    const enter = (count: number): void => {
      if (get().step !== 'check') stepForPins(count);
    };

    /** The draft is dropped and the check shows why (the path went). */
    const toCheck = (): void => {
      set({
        step: 'check',
        pins: [],
        fit: fitOf([], get().yawOffsetDeg),
        dirty: false,
        error: null,
        preview: null,
        armed: null,
        moving: null,
        align: null,
        dragging: null,
      });
    };

    return {
      ...idle,

      start: (w, m, opts = {}) => {
        walk = w;
        raw = opts.raw ?? null;
        outline = walkOutline(raw);
        orientation = opts.orientation ?? null;
        lookup = opts.drawings ?? (() => undefined);
        frames = surfaceFramesOf(m, lookup);
        armedT = 0;
        const pins = byT(w.place?.pins ?? []);
        const yawOffsetDeg = w.place?.yawOffsetDeg ?? 0;
        const ready = opts.ready ?? outline !== null;
        set({
          ...idle,
          layerId: w.id,
          // a walk placed before (two saved pins) was placed knowingly: no check
          step: !ready && pins.length < 2 ? 'check' : 'start',
          pins,
          yawOffsetDeg,
          fit: fitOf(pins, yawOffsetDeg),
        });
      },

      setInputs: (r, o, ready) => {
        if (get().layerId === null) return;
        raw = r;
        outline = walkOutline(raw);
        orientation = o;
        const st = get();
        const saved = (walk?.place?.pins.length ?? 0) >= 2;
        if (!ready && st.step !== 'check' && !saved) {
          toCheck();
          return;
        }
        set({ fit: fitOf(st.pins, st.yawOffsetDeg) });
        if (ready && st.step === 'check') {
          set({ step: 'start' });
          if (st.surface) stepForPins(st.pins.length);
        }
      },

      placeAnyway: () => {
        const st = get();
        if (st.layerId === null || st.step !== 'check') return;
        set({ step: 'start' });
        if (st.surface) stepForPins(st.pins.length);
      },

      setDate: (captureId) => {
        if (!walk || get().layerId === null) return;
        walk = { ...walk, capture: captureId };
      },

      chooseSurface: (s) => {
        if (get().layerId === null) return;
        set({ surface: s, error: null, align: null, preview: null, dragging: null });
        enter(get().pins.length);
      },

      setTime: (t) => {
        if (Number.isFinite(t)) set({ timeS: t });
      },

      hover: (at, y) => {
        const st = get();
        // a handle drag owns the pointer: no surface can make the preview flicker
        if (st.dragging) return;
        if (st.layerId === null || (st.step !== 'start' && st.step !== 'end') || !at) {
          if (st.preview) set({ preview: null });
          return;
        }
        const cursor = modelOf(at);
        if (!cursor) {
          set({ preview: null });
          return;
        }
        const yy = y !== undefined && Number.isFinite(y) ? y : null;
        if (st.step === 'start') {
          const xz = outline ? ghostPath(outline, cursor, ghostLength(outline)) : null;
          set({ preview: previewOf(xz, true, false, yy === null ? null : [yy, yy]) });
          return;
        }
        const first = st.pins[0];
        const from = first ? pinTarget(first, frames) : null;
        if (!from) {
          set({ preview: null });
          return;
        }
        const tooClose =
          Math.hypot(cursor[0] - from.xz[0], cursor[1] - from.xz[1]) < MIN_PIN_SPAN_M;
        const xz = outline
          ? previewPath(outline, startT(), endT(), from.xz, cursor)
          : [from.xz, cursor];
        const y0 = from.y;
        set({
          preview: previewOf(xz, false, tooClose, y0 !== null && yy !== null ? [y0, yy] : null),
        });
      },

      click: (at, y) => {
        const st = get();
        if (st.layerId === null || !st.surface) return;
        if (st.step === 'fine-tune') {
          if (st.armed === 'align-surface') finishAlign(at, y);
          else if (st.armed === 'move') moveArmed(at, y);
          else if (st.armed === 'pin') {
            if (st.surface.kind === 'drawing' && !frames.drawing(st.surface.id)) {
              set({ error: DRAWING_NOT_READY });
              return;
            }
            const pin = pinAt(armedT, at, y);
            if (pin) setPins([...st.pins, pin], { armed: null });
          }
          return;
        }
        if (st.step !== 'start' && st.step !== 'end') return;
        if (st.surface.kind === 'drawing' && !frames.drawing(st.surface.id)) {
          set({ error: DRAWING_NOT_READY });
          return;
        }
        if (st.step === 'start') {
          const pin = pinAt(startT(), at, y);
          if (!pin) return;
          setPins([pin], { step: 'end' });
          jump(endT());
          get().hover(at, y);
          return;
        }
        const pin = pinAt(endT(), at, y);
        if (!pin) return;
        const next = byT([...st.pins, pin]);
        const fit = fitOf(next, st.yawOffsetDeg);
        if (fit?.error) {
          // too close to the start: ignored, the hint already says why
          get().hover(at, y);
          return;
        }
        set({ pins: next, fit, dirty: true, error: null, step: 'placed', preview: null });
      },

      dragHandle: (h, at, y) => {
        const st = get();
        if (st.layerId === null || (st.step !== 'placed' && st.step !== 'fine-tune')) return;
        if (st.pins.length < 2) return;
        const i = h === 'start' ? 0 : st.pins.length - 1;
        const old = st.pins[i];
        const pin = old ? pinAt(old.t, at, y) : null;
        if (!pin) return;
        const next = st.pins.map((p, k) => (k === i ? pin : p));
        const fit = fitOf(next, st.yawOffsetDeg);
        if (fit?.error) {
          // within 5 m of the other end: the handle stays at its last allowed spot
          set({ dragging: { handle: h, refused: true } });
          return;
        }
        set({ pins: next, fit, dirty: true, error: null, dragging: { handle: h, refused: false } });
      },

      endDrag: () => {
        if (get().dragging) set({ dragging: null });
      },

      setFineTune: (on) => {
        const st = get();
        if (st.layerId === null) return;
        if (on && st.step === 'placed')
          set({ step: 'fine-tune', armed: null, moving: null, align: null });
        else if (!on && st.step === 'fine-tune')
          set({ step: 'placed', armed: null, moving: null, align: null });
      },

      pinHere: () => {
        const st = get();
        if (st.layerId === null || st.step !== 'fine-tune' || !st.surface) return;
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
        if (st.layerId === null || st.step !== 'fine-tune' || !st.surface || !pin) return;
        if (st.armed === 'move' && st.moving === i) {
          set({ armed: null, moving: null });
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
        setPins(pins, aligning || moving ? { armed: null, align: null, moving: null } : {});
        if (st.surface && pins.length < 2) stepForPins(pins.length);
      },

      armAlign: () => {
        const st = get();
        if (st.layerId === null || st.step !== 'fine-tune') return;
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
        outline = null;
        orientation = null;
        frames = { drawing: () => null };
        lookup = () => undefined;
        armedT = 0;
        set({ ...idle });
      },
    };

    /** The click of a Move: pin `moving` to the spot on the surface in hand, the others stay. */
    function moveArmed(at: [number, number], y: number | undefined): void {
      const st = get();
      const old = st.moving === null ? undefined : st.pins[st.moving];
      if (!old || !st.surface) return;
      if (st.surface.kind === 'drawing' && !frames.drawing(st.surface.id)) {
        set({ error: DRAWING_NOT_READY });
        return;
      }
      const pin = pinAt(old.t, at, y);
      if (!pin) return;
      const next = st.pins.map((p, k) => (k === st.moving ? pin : p));
      const refused = next.length >= 2 ? (fitOf(next, st.yawOffsetDeg)?.error ?? null) : null;
      if (refused) {
        // refused (the start and end closer than 5 m): the pin stays, the spot is asked again
        set({ error: refused });
        return;
      }
      setPins(next, { armed: null, moving: null });
    }

    /**
     * Align view, second click: the yaw offset that turns the 360's direction to the landmark onto
     * the direction from the camera (the fit at the landmark's time) to the clicked spot.
     */
    function finishAlign(at: [number, number], y: number | undefined): void {
      const st = get();
      const s = st.surface;
      if (!st.align || !st.fit || !s) return;
      const target = pinTarget(
        { t: st.align.t, surface: surfaceKey(s), at, ...(y === undefined ? {} : { y }) },
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
