import type { Layer } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { carryVideoCalibration } from './calibration';

const clip = (id: string): Layer => ({
  kind: 'video',
  id,
  name: id,
  visible: true,
  src: { path: `video/${id}.mp4` },
  flight: { src: { path: 'flights/flight1.json' }, startUtcMs: 0 },
  lens: { model: 'pinhole', hfovDeg: 72.2, aspect: 1.8963 },
  offsetMs: 0,
});

describe('carryVideoCalibration (Al-Zour re-import after the height fix)', () => {
  // the A1 calibration of a project imported with EL = 100 + relative altitude: each clip lifted
  // by its flight's abs_minus_rel (F1 41.9 m, F5 22.7 m), F1 also 1.2 m east of its log
  const previous = {
    layers: [
      {
        ...clip('clip-DJI_0658'),
        orientation: { yawDeg: 0.4, pitchDeg: -0.9, rollDeg: 0.1 },
        positionOffsetM: [1.2, 41.9, 0],
      },
      { ...clip('clip-DJI_0678'), positionOffsetM: [0, 22.7, 0] },
      { ...clip('clip-DJI_0789'), positionOffsetM: [0, 0.8, 0] },
      { kind: 'photos', id: 'photos', positionOffsetM: [0, 9, 0] },
    ],
  };
  const layers = [clip('clip-DJI_0658'), clip('clip-DJI_0678'), clip('clip-DJI_0789'), clip('new')];
  // the re-import lifts the logged heights by abs_minus_rel (F4: 25.6 m)
  const deltaY = new Map([
    ['clip-DJI_0658', 41.9],
    ['clip-DJI_0678', 22.7],
    ['clip-DJI_0789', 25.6],
  ]);

  it('keeps orientation, takes the height change off the offset and drops what is left of nothing', () => {
    const r = carryVideoCalibration(previous, layers, deltaY);
    expect(r.layers[0]?.orientation).toEqual({ yawDeg: 0.4, pitchDeg: -0.9, rollDeg: 0.1 });
    expect(r.layers[0]?.positionOffsetM).toEqual([1.2, 0, 0]);
    expect(r.layers[1]).not.toHaveProperty('positionOffsetM');
    // an offset that did not compensate the datum turns into the opposite correction: kept, reported
    expect(r.layers[2]?.positionOffsetM).toEqual([0, -24.8, 0]);
    expect(r.layers[3]).not.toHaveProperty('positionOffsetM');
    expect(r.notes.join('\n')).toMatch(
      /clip-DJI_0678: position offset \[0\.00, 22\.70, 0\.00\] m dropped/,
    );
    expect(r.notes.join('\n')).toMatch(/clip-DJI_0789: .* rebased to \[0\.00, -24\.80, 0\.00\]/);
  });

  it('keeps offsets as they are when the heights did not change, and needs no previous manifest', () => {
    const same = carryVideoCalibration(previous, layers, new Map());
    expect(same.layers[1]?.positionOffsetM).toEqual([0, 22.7, 0]);
    const none = carryVideoCalibration(undefined, layers, deltaY);
    expect(none.notes).toEqual([]);
    expect(none.layers[0]).toEqual(layers[0]);
  });
});
