// The 360 walk track (plan 2026-11-11-walk-detections) is additive, pinned against the 0.21 schema
// (tools/compat/schema-0.21):
// - `track` sits on a detection, which is not strict: 0.21 reads a tracked walk pass and drops the
//   track when it saves (the lead draft then shows on its own frame, without "Seen in N frames");
// - a walk pass written before the track reads unchanged in this build.
import { describe, expect, it } from 'vitest';
import * as current from '../../packages/schema/src/index.ts';
import * as v021 from './schema-0.21/index.mjs';

const draft = {
  id: 'm-1',
  frame: { layer: 'walk-1', t: 4.5 },
  class: 'crack',
  severity: 'uncertain',
  status: 'draft',
  confidence: 0.7,
  bbox: [5600, 1400, 6200, 1600],
  space: 'source',
  width: 5760,
  height: 2880,
};
const track = {
  frames: 3,
  firstT: 4,
  lastT: 5,
  score: 0.7,
  point: [3.5, -1, 0.25],
  placedOn: 'ground',
  bearingDeg: 271.5,
  rangeM: 6.4,
  sightings: [
    { t: 4, bbox: [5700, 1400, 5900, 1600], confidence: 0.6, id: 'm-2' },
    { t: 5, bbox: [100, 1400, 300, 1600] },
  ],
  sightingsOmitted: 1,
};
const passOf = (detections) => ({
  schema: 'aio.detections/1',
  source: 'model',
  layer: 'walk-1',
  detections,
});

describe('the 360 walk track is additive', () => {
  it('0.21 reads a tracked walk pass and drops only the track', () => {
    const r = v021.DetectionsFile.safeParse(passOf([{ ...draft, track }]));
    expect(r.success).toBe(true);
    expect(r.data.detections[0]).toEqual(draft);
  });

  it('this build keeps the track', () => {
    expect(current.DetectionsFile.parse(passOf([{ ...draft, track }])).detections[0].track).toEqual(
      track,
    );
  });

  it('a walk pass written before the track reads unchanged', () => {
    const pass = passOf([draft]);
    expect(current.DetectionsFile.parse(pass)).toEqual(pass);
  });
});
