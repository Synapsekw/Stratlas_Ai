// The multi-view vote and the thermal hot-spot pass (plan 2026-10-31-multiview-thermal) are
// additive, pinned against the 0.21 schema (tools/compat/schema-0.21):
// - `vote` sits on a detection, which is not strict: 0.21 reads a voted pass and drops the vote
//   when it saves (the drafts then show as before, without the "Seen in N photos" chip);
// - the hot-spot pass `detections/thermal-<layerId>.json` is an ordinary `aio.detections/1` file,
//   which 0.21 reads like any other pass;
// - a pass written before the vote reads unchanged in this build.
import { describe, expect, it } from 'vitest';
import * as current from '../../packages/schema/src/index.ts';
import * as v021 from './schema-0.21/index.mjs';

const draft = {
  id: 'd1',
  photo: 'p001',
  class: 'corrosion',
  severity: 'uncertain',
  status: 'draft',
  confidence: 0.7,
  bbox: [10, 20, 60, 80],
  space: 'source',
  width: 4000,
  height: 3000,
};
const vote = {
  views: 3,
  seenBy: 4,
  score: 0.8,
  point: [1, 2, 3],
  placedOn: 'mesh',
  sightings: [
    { photo: 'p002', bbox: [12, 22, 62, 82], confidence: 0.75, id: 'd2' },
    {
      photo: 'p003',
      bbox: [400, 300, 800, 600],
      space: 'source',
      width: 4000,
      height: 3000,
      note: 'Peak 61.2 °C',
      fields: [{ key: 'peak', label: 'Peak', type: 'number', value: 61.2, unit: '°C' }],
    },
  ],
  sightingsOmitted: 2,
};
const passOf = (detections) => ({
  schema: 'aio.detections/1',
  source: 'model',
  layer: 'photos-1',
  detections,
});

describe('the multi-view vote is additive', () => {
  it('0.21 reads a voted pass and drops only the vote', () => {
    const r = v021.DetectionsFile.safeParse(passOf([{ ...draft, vote }]));
    expect(r.success).toBe(true);
    expect(r.data.detections[0]).toEqual(draft);
  });

  it('0.21 reads a hot-spot pass', () => {
    const hot = {
      ...draft,
      id: 'hs-th1-0',
      class: 'hot-spot',
      label: 'Hot spot',
      suggestedNew: true,
      note: 'Peak 61.2 °C, 9.4 °C above its surroundings.',
      vote: { views: 1, seenBy: 3, singleView: true },
    };
    expect(v021.DetectionsFile.safeParse(passOf([hot])).success).toBe(true);
  });

  it('this build keeps the vote', () => {
    expect(current.DetectionsFile.parse(passOf([{ ...draft, vote }])).detections[0].vote).toEqual(
      vote,
    );
  });

  it('a pass written before the vote reads unchanged', () => {
    const pass = passOf([draft]);
    expect(current.DetectionsFile.parse(pass)).toEqual(pass);
  });
});
