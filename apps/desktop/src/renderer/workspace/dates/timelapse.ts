import type { MapController, RasterBlend } from '@aio/maps';
import type { Layer } from '@aio/schema';
import { counterpart, type CaptureIndex } from '@aio/workspace';
import { useStore } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import { createStore, type StoreApi } from 'zustand/vanilla';
import {
  datesPlayer,
  type BetweenMode,
  type DatesPlayerState,
  type PlayerFrame,
} from './datesPlayer';

/**
 * The timelapse (volumetrics redesign, spec "Timelapse", board 6): while the dates player plays,
 * the views step through the survey dates. The date in focus (and every figure) is the last
 * survey the playhead passed; only the pictures move between surveys: the Map crossfades the two
 * dated orthos, the 3D view swaps to the next survey at the middle of the gap (Crossfade), at the
 * next survey (Hold), or the kit's swipe moves across (Swipe). Nothing between surveys is
 * estimated. A manual date change, a pile click or Esc stops playback, and the views go back to
 * their normal display.
 */

/** What the views show at one playhead position. */
export interface TimelapseView {
  /** The Map's blend fraction: the passed date's orthos at 1 − f, the next one's at f; null: none. */
  blend: number | null;
  /** The date the 3D view shows. */
  scene: 'passed' | 'next';
  /** The kit swipe's divider (0 left to 1 right); null: the swipe is not driven. */
  swipeX: number | null;
}

const NONE: TimelapseView = { blend: null, scene: 'passed', swipeX: null };

/**
 * The views at `frame` for the between-surveys choice. Swipe needs the kit's swipe (`kitSwipe`)
 * and crossfades without it. The kit's swipe draws the earlier survey on the left, so the next
 * survey grows from the right: the divider sits at 1 − f.
 */
export function timelapseView(
  frame: PlayerFrame,
  between: BetweenMode,
  kitSwipe: boolean,
): TimelapseView {
  if (frame.next === null) return NONE;
  const f = Math.min(1, Math.max(0, Number.isFinite(frame.f) ? frame.f : 0));
  if (between === 'hold') return NONE;
  if (between === 'swipe' && kitSwipe) return { blend: null, scene: 'passed', swipeX: 1 - f };
  return { blend: f > 0 ? f : null, scene: f >= 0.5 ? 'next' : 'passed', swipeX: null };
}

/**
 * The Map's crossfade from `passed` to `next`: each raster of `passed` the workspace shows, at
 * 1 − f, and its counterpart on `next` (the same slot), at f. Common rasters (basemaps) and the
 * rasters hidden on `passed` keep their normal display.
 */
export function rasterBlend(
  index: CaptureIndex,
  layers: readonly Pick<Layer, 'id' | 'kind'>[],
  hidden: Readonly<Record<string, true>>,
  passed: string,
  next: string,
  f: number,
): RasterBlend {
  const out: { layerId: string; opacity: number }[] = [];
  for (const l of layers) {
    if (l.kind !== 'raster' || index.of[l.id] !== passed || hidden[l.id]) continue;
    out.push({ layerId: l.id, opacity: 1 - f });
    const twin = counterpart(index, l.id, next);
    if (twin && twin !== l.id) out.push({ layerId: twin, opacity: f });
  }
  return out;
}

/**
 * True when the date in focus moved to something other than the last survey passed: someone
 * changed the date by hand (the notch, the calendar, the sidebar), so playback stops.
 */
export function isManualDateChange(focus: string | null, passed: string | null): boolean {
  return focus !== null && focus !== passed;
}

/** The playhead's calendar day as `YYYY-MM-DD` (the dates are UTC days); null when not a time. */
export function playheadDay(t: number): string | null {
  if (!Number.isFinite(t)) return null;
  return new Date(t).toISOString().slice(0, 10);
}

/** A survey date as the timelapse's floats and the Volumes tab name it during playback. */
export interface TimelapseDay {
  capture: string;
  /** Epoch ms of the day (the player's time). */
  t: number;
  /** "31 Dec 2020" */
  label: string;
  /** "31 Dec" */
  short: string;
  colour: string;
  /** The site total on that survey; null when nothing is counted. */
  volumeM3: number | null;
}

export interface TimelapseState {
  /** The capture the main 3D view shows instead of the date in focus; null: the focus. */
  scene: string | null;
  /** The open project's survey dates, oldest first (the dates strip publishes them). */
  days: readonly TimelapseDay[];
}

/**
 * The timelapse's hold on the main 3D view (the stage scopes the view to `scene`) and the survey
 * dates the floats read.
 */
export const timelapseStore: StoreApi<TimelapseState> = createStore<TimelapseState>(() => ({
  scene: null,
  days: [],
}));

/** The day at a survey time, when it is one. */
export function dayAt(days: readonly TimelapseDay[], t: number | null): TimelapseDay | null {
  return t === null ? null : (days.find((d) => d.t === t) ?? null);
}

/** The kit's swipe as the timelapse found it at play start: given back on stop. */
export interface KitSwipeState {
  on: boolean;
  /** The divider, 0 left to 1 right. */
  x: number;
}

type BlendTarget = Pick<MapController, 'setRasterBlend'>;

export interface TimelapseDeps {
  player: StoreApi<DatesPlayerState>;
  /** The date in focus (the timeline's). */
  focus: { get(): string | null; subscribe(cb: () => void): () => void };
  /** The capture of a survey time. */
  captureAt(t: number): string | null;
  /** The Map on screen, when there is one. */
  map(): BlendTarget | null;
  /** Calls `cb` when the Map on screen changes (shown, hidden, another); returns the unsubscribe. */
  onMap?(cb: () => void): () => void;
  /** The Map's crossfade between two captures (`rasterBlend` over the open project). */
  blendFor(passed: string, next: string, f: number): RasterBlend;
  /**
   * The kit's swipe: whether this project has it, its state now, drive its divider (turning it
   * on), and give back a state read with `get`.
   */
  kitSwipe: {
    available(): boolean;
    get(): KitSwipeState;
    set(x: number): void;
    restore(state: KitSwipeState): void;
  };
  /** Calls `cb` when a pile is clicked (opened); returns the unsubscribe. */
  onPileClick(cb: () => void): () => void;
  /** Where Esc is heard. */
  keys: Pick<EventTarget, 'addEventListener' | 'removeEventListener'> | null;
}

/**
 * Drives the views from the player while it plays, and stops it on a manual date change, a pile
 * click or Esc; on pause (or the end) the Map's blend, the 3D view's date and the kit's swipe go
 * back to normal. Returns the disconnect, which also restores them.
 *
 * The blend is cleared on the controller it was drawn on: a hidden MapView keeps its controller
 * but stops publishing it, so asking for the Map on screen at stop would miss it and the Map
 * would still show the blend when it comes back. The kit's swipe is read at play start (a survey
 * passed turns it off, and the Swipe choice drives it) and given back as it was on stop.
 */
export function connectTimelapse(deps: TimelapseDeps): () => void {
  const { player } = deps;
  let blendedOn: BlendTarget | null = null;
  let swiping = false;
  let savedSwipe: KitSwipeState | null = null;

  const clearBlend = () => {
    const m = blendedOn;
    blendedOn = null;
    m?.setRasterBlend(null);
  };

  const restore = () => {
    clearBlend();
    const saved = savedSwipe;
    savedSwipe = null;
    swiping = false;
    if (saved) deps.kitSwipe.restore(saved);
    if (timelapseStore.getState().scene !== null) timelapseStore.setState({ scene: null });
  };

  const apply = (s: DatesPlayerState) => {
    const frame = s.frame;
    if (!s.playing || !frame) {
      restore();
      return;
    }
    if (!savedSwipe && deps.kitSwipe.available()) savedSwipe = deps.kitSwipe.get();
    const passed = deps.captureAt(frame.passed);
    const next = frame.next === null ? null : deps.captureAt(frame.next);
    const view = passed && next ? timelapseView(frame, s.between, deps.kitSwipe.available()) : NONE;
    if (view.blend !== null && passed && next) {
      const m = deps.map();
      if (m !== blendedOn) clearBlend();
      if (m) {
        m.setRasterBlend(deps.blendFor(passed, next, view.blend));
        blendedOn = m;
      }
    } else {
      clearBlend();
    }
    if (view.swipeX !== null) {
      deps.kitSwipe.set(view.swipeX);
      swiping = true;
    } else if (swiping) {
      swiping = false;
      if (savedSwipe) deps.kitSwipe.restore(savedSwipe);
    }
    const scene = view.scene === 'next' ? next : null;
    if (timelapseStore.getState().scene !== scene) timelapseStore.setState({ scene });
  };

  const stop = () => {
    if (player.getState().playing) player.getState().pause();
  };

  const offPlayer = player.subscribe(apply);
  // another Map on screen (or none): the blend leaves the old one now, the next frame draws it on
  // the new one
  const offMap =
    deps.onMap?.(() => {
      if (blendedOn && deps.map() !== blendedOn) clearBlend();
    }) ?? (() => undefined);
  // only a change of the date itself counts: the timeline also updates while it saves its prefs
  let lastFocus = deps.focus.get();
  const offFocus = deps.focus.subscribe(() => {
    const focus = deps.focus.get();
    if (focus === lastFocus) return;
    lastFocus = focus;
    const s = player.getState();
    if (!s.playing) return;
    const passed = s.frame ? deps.captureAt(s.frame.passed) : null;
    if (isManualDateChange(focus, passed)) stop();
  });
  const offPile = deps.onPileClick(() => {
    stop();
  });
  const onKey = (e: Event) => {
    if ((e as KeyboardEvent).key === 'Escape') stop();
  };
  deps.keys?.addEventListener('keydown', onKey, true);

  return () => {
    offPlayer();
    offMap();
    offFocus();
    offPile();
    deps.keys?.removeEventListener('keydown', onKey, true);
    restore();
  };
}

/** Playing, with the playhead between (or on) two surveys. */
export function useTimelapsePlaying(): boolean {
  return useStore(datesPlayer, (s) => s.playing && s.frame !== null);
}

/** While playing: the last survey passed and the next one (null at the end); else null. */
export function useTimelapseSurveys(): { passed: TimelapseDay; next: TimelapseDay | null } | null {
  const at = useStore(
    datesPlayer,
    useShallow((s) => ({
      playing: s.playing,
      passed: s.frame?.passed ?? null,
      next: s.frame?.next ?? null,
    })),
  );
  const days = useStore(timelapseStore, (s) => s.days);
  if (!at.playing) return null;
  const passed = dayAt(days, at.passed);
  if (!passed) return null;
  return { passed, next: dayAt(days, at.next) };
}
