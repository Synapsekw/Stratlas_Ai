import type { Layer, PhotoCorrection, WalkLayer } from '@aio/schema';
import {
  calibratedVideoPose,
  photoPose,
  videoTimeS,
  type Flight,
  type VideoLayer,
} from '@aio/video';
import type { CaptureIndex } from '@aio/workspace';
import { layerCapture } from '../framesModel';
import { SPOT_RULES } from './spotRules';
import type { FrameSample, SpotEntry, TrackSample } from './spotTypes';

/** What the spot search reads from the open project (spec "Scale": one linear pass). */
export interface EntryInputs {
  layers: readonly Layer[];
  index: CaptureIndex;
  correction?: (layer: string, photo: string) => PhotoCorrection | null;
  /** undefined: still reading (left out); null: unreadable (skipped). Absent: clips left out. */
  videoSamples?: (layer: VideoLayer) => readonly FrameSample[] | null | undefined;
  /** The same for walks (Task 12). Absent: walks left out. */
  walkSamples?: (layer: WalkLayer) => readonly TrackSample[] | null | undefined;
}

export function spotEntries(input: EntryInputs): SpotEntry[] {
  const out: SpotEntry[] = [];
  for (const l of input.layers) {
    const capture = layerCapture(l, input.index);
    if (l.kind === 'photos') {
      for (const p of l.items) {
        const pose = photoPose(p, input.correction?.(l.id, p.id) ?? null);
        const pos = pose?.pos ?? p.pos;
        out.push({
          kind: 'photo',
          layer: l.id,
          capture,
          id: p.id,
          ...(pos ? { pos } : {}),
          pose,
          hasLens: p.lens !== undefined,
        });
      }
    } else if (l.kind === 'panoramas') {
      for (const p of l.items)
        out.push({
          kind: 'pano',
          layer: l.id,
          capture,
          id: p.id,
          pos: p.pos,
          headingDeg: p.headingDeg,
        });
    } else if (l.kind === 'video' && input.videoSamples) {
      const samples = input.videoSamples(l);
      if (samples !== undefined) out.push({ kind: 'video', layer: l.id, capture, samples });
    } else if (l.kind === 'walk' && input.walkSamples) {
      const samples = input.walkSamples(l);
      if (samples !== undefined) out.push({ kind: 'walk', layer: l.id, capture, samples });
    }
  }
  return out;
}

export type DirectionKeys = Parameters<typeof calibratedVideoPose>[3];

/** The clip's calibrated camera every `stepS` video seconds over its flight log. */
export function sampleVideo(
  layer: VideoLayer,
  flight: Flight,
  keys: DirectionKeys,
  stepS: number = SPOT_RULES.videoStepS,
): FrameSample[] {
  const first = flight.samples[0];
  const last = flight.samples.at(-1);
  if (!first || !last) return [];
  const from = Math.max(0, videoTimeS(layer, flight, first.t));
  const to = videoTimeS(layer, flight, last.t);
  const out: FrameSample[] = [];
  // Math.max(0, ...) also turns a -0 start into +0.
  for (let i = Math.max(0, Math.ceil(from / stepS - 1e-9)); i * stepS <= to + 1e-9; i++) {
    const t = i * stepS;
    out.push({ t, pose: calibratedVideoPose(layer, flight, t, keys) });
  }
  return out;
}
