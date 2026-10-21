import { correctedPhoto, photoCorrection } from '@aio/geo';
import {
  shiftedLayer,
  shiftLocal,
  type DateShift,
  type Layer,
  type OrientationFile,
} from '@aio/schema';
import { calibratedVideoPose, type Flight, type FramesMode, type ViewPose } from '@aio/video';
import { workspace, type CaptureIndex, type Selection } from '@aio/workspace';
import { createStore } from 'zustand/vanilla';
import type { SplitPref } from './splitModel';

/**
 * The Frames pane (M8 C4): a video frame or photo of one survey date beside the same view on
 * another date. Pure choices here; the pane is `FramesPane.tsx`.
 */

/** The view of the first date: a clip at the project clock, or one photo. */
export type FramesSource =
  { kind: 'video'; layer: string } | { kind: 'photo'; layer: string; photo: string };

export interface FramesState {
  /** Chosen with "Same view on the other date"; else the selection or the playing clip. */
  source: FramesSource | null;
  mode: FramesMode;
  /** Swipe position or blend amount, 0 to 1. */
  amount: number;
  /** Draw the other date through the ground homography. */
  warp: boolean;
  /** The other date when the project has more than two. */
  other: string | null;
}

export interface FramesActions {
  setSource(source: FramesSource | null): void;
  setMode(mode: FramesMode): void;
  setAmount(amount: number): void;
  setWarp(warp: boolean): void;
  setOther(capture: string | null): void;
}

export function createFramesStore() {
  return createStore<FramesState & FramesActions>()((set) => ({
    source: null,
    mode: 'side',
    amount: 0.5,
    warp: false,
    other: null,
    setSource: (source) => {
      set({ source });
    },
    setMode: (mode) => {
      set({ mode });
    },
    setAmount: (amount) => {
      set({ amount: Math.min(1, Math.max(0, amount)) });
    },
    setWarp: (warp) => {
      set({ warp });
    },
    setOther: (other) => {
      set({ other });
    },
  }));
}

export const framesState = createFramesStore();

type PhotoLayer = Extract<Layer, { kind: 'photos' }>;

const posed = (l: PhotoLayer) => l.items.find((p) => p.pos && p.q);

/**
 * The view to compare: the chosen one while its layer is there; else the selected photo; else the
 * active clip; else the first clip; else the first photo with a camera position.
 */
export function pickSource(
  layers: readonly Layer[],
  chosen: FramesSource | null,
  selection: Selection | null,
  activeClip: string | null,
): FramesSource | null {
  const find = (id: string) => layers.find((l) => l.id === id);
  if (chosen) {
    const l = find(chosen.layer);
    if (chosen.kind === 'video' && l?.kind === 'video') return chosen;
    if (
      chosen.kind === 'photo' &&
      l?.kind === 'photos' &&
      l.items.some((p) => p.id === chosen.photo)
    )
      return chosen;
  }
  if (selection?.kind === 'photo' && selection.layer) {
    const l = find(selection.layer);
    if (l?.kind === 'photos' && l.items.some((p) => p.id === selection.id))
      return { kind: 'photo', layer: l.id, photo: selection.id };
  }
  if (activeClip && find(activeClip)?.kind === 'video') return { kind: 'video', layer: activeClip };
  const clip = layers.find((l) => l.kind === 'video');
  if (clip) return { kind: 'video', layer: clip.id };
  for (const l of layers) {
    if (l.kind !== 'photos') continue;
    const p = posed(l);
    if (p) return { kind: 'photo', layer: l.id, photo: p.id };
  }
  return null;
}

/** The survey date of a layer: its explicit `capture` first, then the date index. */
export function layerCapture(layer: Layer, index: CaptureIndex): string | undefined {
  const explicit = layer.capture;
  if (explicit && index.captures.some((c) => c.id === explicit)) return explicit;
  return index.of[layer.id];
}

/**
 * The date to compare with: the chosen one when the project has it and it is not the first date;
 * else the next later date; else the latest earlier one.
 */
export function otherCapture(
  index: CaptureIndex,
  a: string,
  chosen: string | null,
): string | undefined {
  const ids = index.captures.map((c) => c.id);
  if (chosen && chosen !== a && ids.includes(chosen)) return chosen;
  const i = ids.indexOf(a);
  if (i < 0) return undefined;
  return ids[i + 1] ?? (i > 0 ? ids[i - 1] : undefined);
}

/** The split with the Frames pane on one side (the right, unless the left already shows it). */
export function splitWithFrames(sides: SplitPref): SplitPref {
  if (sides.left === 'frames' || sides.right === 'frames') return sides;
  const left = sides.left === sides.right && sides.left !== '3d' ? '3d' : sides.left;
  return { ...sides, left, right: 'frames' };
}

/** The next or previous photo of a set (wrapping), for stepping through date A. */
export function stepPhoto(layer: PhotoLayer, photo: string, dir: 1 | -1): string | undefined {
  const n = layer.items.length;
  if (n === 0) return undefined;
  const i = layer.items.findIndex((p) => p.id === photo);
  return layer.items[(((i < 0 ? 0 : i + dir) % n) + n) % n]?.id;
}

/** Video seconds of the project clock, on the frame grid (30 per second). */
export function frameTime(v: number, fps = 30): number {
  return Math.max(0, Math.round(v * fps) / fps);
}

type VideoLayer = Extract<Layer, { kind: 'video' }>;

/** A camera moved by its date's line-up (the same pose for no shift). */
export function shiftPose(pose: ViewPose, shift: DateShift | null): ViewPose {
  return shift ? { ...pose, pos: shiftLocal(pose.pos, shift) } : pose;
}

/**
 * A clip's calibrated camera as drawn on its lined-up date: the pairing's pose (from the layer and
 * keys as stored: the aim comes from the stored place) with the shift added to its position.
 */
export function placedVideoPose(
  layer: VideoLayer,
  flight: Flight,
  v: number,
  keys: Parameters<typeof calibratedVideoPose>[3],
  shift: DateShift | null,
): ViewPose {
  return shiftPose(calibratedVideoPose(layer, flight, v, keys), shift);
}

/**
 * The layers as the other date's views are searched: clips with their offset moved, photos at
 * their corrected place and direction (`correctedPhoto`, orientation.json; the workspace's file
 * when none is given) and then moved by their date's line-up.
 */
export function placedLayers(
  layers: readonly Layer[],
  shiftOf: (layerId: string) => DateShift | null,
  orientation: OrientationFile | null = workspace.getState().orientation,
): Layer[] {
  return layers.map((l) => {
    const s = shiftOf(l.id);
    if (l.kind !== 'photos') return s ? shiftedLayer(l, s) : l;
    if (!s && !orientation?.photos[l.id]) return l;
    return {
      ...l,
      items: l.items.map((item) => {
        const p = correctedPhoto(item, photoCorrection(orientation, l.id, item.id));
        return s && p.pos ? { ...p, pos: shiftLocal(p.pos, s) } : p;
      }),
    };
  });
}
