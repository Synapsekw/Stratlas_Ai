// The walk height offset (Drop to ground for 360 walks) is additive, pinned against the 0.21 schema
// (tools/compat/schema-0.21):
// - `heightOffsetM` sits on the walk layer, not in its strict `place`: 0.21 reads the walk and
//   drops the field when it saves (the walk then shows at its pins' heights, as before);
// - a walk saved before the offset reads unchanged in this build.
import { describe, expect, it } from 'vitest';
import * as current from '../../packages/schema/src/index.ts';
import * as v021 from './schema-0.21/index.mjs';

const walk = {
  kind: 'walk',
  id: 'walk-w1',
  name: 'Walk',
  visible: true,
  record: { path: 'walks/w1/walk.json' },
  src: { path: 'walks/w1/playback.mp4' },
  durationS: 10,
  place: {
    pins: [
      { t: 1, surface: '@model', at: [0, 0], y: 0 },
      { t: 9, surface: '@model', at: [10, 0], y: 0 },
    ],
    yawOffsetDeg: 0,
    heightM: 1.7,
    quality: 'good',
  },
};

describe('the walk height offset is additive', () => {
  it('0.21 reads an offset walk and drops only the offset', () => {
    const r = v021.Layer.safeParse({ ...walk, heightOffsetM: 1.25 });
    expect(r.success).toBe(true);
    expect(r.data).toEqual(walk);
  });

  it('this build keeps the offset', () => {
    expect(current.Layer.parse({ ...walk, heightOffsetM: 1.25 }).heightOffsetM).toBe(1.25);
  });

  it('a walk saved before the offset reads unchanged', () => {
    expect(JSON.stringify(current.Layer.parse(walk))).toBe(JSON.stringify(walk));
  });
});
