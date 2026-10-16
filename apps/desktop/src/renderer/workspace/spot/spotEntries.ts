import { panoOpenable } from '@aio/engine';
import { correctedPhoto } from '@aio/geo';
import {
  shiftLocal,
  type DateShift,
  type Layer,
  type PhotoCorrection,
  type WalkLayer,
} from '@aio/schema';
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
  /** The date shift of a layer (line up dates), added after the correction. Absent: none. */
  shiftOf?: (layer: string) => DateShift | null;
}

export function spotEntries(input: EntryInputs): SpotEntry[] {
  const out: SpotEntry[] = [];
  for (const l of input.layers) {
    const capture = layerCapture(l, input.index);
    const shift = input.shiftOf?.(l.id) ?? null;
    if (l.kind === 'photos') {
      for (const p of l.items) {
        const correction = input.correction?.(l.id, p.id) ?? null;
        const basePose = photoPose(p, correction);
        const pose =
          basePose && shift ? { ...basePose, pos: shiftLocal(basePose.pos, shift) } : basePose;
        const base = basePose?.pos ?? correctedPhoto(p, correction).pos;
        const pos = base && shift ? shiftLocal(base, shift) : base;
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
      // a sphere not stitched yet has no image to show in the history
      for (const p of l.items.filter(panoOpenable))
        out.push({
          kind: 'pano',
          layer: l.id,
          capture,
          id: p.id,
          pos: shiftLocal(p.pos, shift),
          headingDeg: p.headingDeg,
        });
    } else if (l.kind === 'video' && input.videoSamples) {
      const samples = input.videoSamples(l);
      if (samples !== undefined)
        out.push({
          kind: 'video',
          layer: l.id,
          capture,
          samples:
            samples && shift
              ? samples.map((f) => ({
                  ...f,
                  pose: { ...f.pose, pos: shiftLocal(f.pose.pos, shift) },
                }))
              : samples,
        });
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
