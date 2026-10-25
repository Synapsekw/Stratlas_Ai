import { layerTransformToGeoref, type ProjectGeo } from '@aio/geo';
import type { Georef, Layer, Mat4 } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import type { Box } from '../shell/layerBounds';
import {
  droppable,
  formatShift,
  groundUnder,
  percentile,
  planDrop,
  type DropItem,
} from './dropToGround';

const PROJECT: ProjectGeo = { crs: { epsg: 32639 }, origin: [500000, 4000000, 10] };
const I: Mat4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const GEOREF: Georef = {
  schema: 'aio.georef/1',
  crs: { epsg: 32639 },
  anchor: [500000, 4000000, 10],
  axes: 'x-east,y-up,z-south',
  units: 'm',
  modelToCrs: [1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 500000, 4000000, 10, 1],
  heading: { deg: 0, status: 'assumed-grid' },
  scale: { factor: 1, status: 'provisional' },
  horizontal: { status: 'unplaced' },
  vertical: { datum: 'unknown', status: 'unknown' },
  provenance: { by: 'engineer' },
};

const cloud = (low: number, heightOffsetM = 0): DropItem => ({
  kind: 'pointcloud',
  layerId: 'c',
  name: 'Cloud',
  low,
  heightOffsetM,
});

describe('planDrop', () => {
  it('lowers a cloud 31.2 m onto the project ground', () => {
    const s = planDrop(cloud(31.2), 0, PROJECT);
    expect(s).toEqual({
      layerId: 'c',
      name: 'Cloud',
      shift: -31.2,
      patch: { heightOffsetM: -31.2 },
      undo: { heightOffsetM: null },
    });
  });

  it('adds to an existing offset and clears it at zero', () => {
    expect(planDrop(cloud(5, -10), 2, PROJECT)?.patch).toEqual({ heightOffsetM: -13 });
    const back = planDrop(cloud(-7.5, -7.5), 0, PROJECT);
    expect(back?.patch).toEqual({ heightOffsetM: null });
    expect(back?.undo).toEqual({ heightOffsetM: -7.5 });
    expect(back?.shift).toBe(7.5);
  });

  it('moves a model by its transform and rewrites its georef', () => {
    const item: DropItem = {
      kind: 'mesh',
      layerId: 'm',
      name: 'Model',
      low: 12,
      transform: I,
      georef: GEOREF,
      placement: 'needed',
    };
    const s = planDrop(item, 2, PROJECT);
    const moved = [...I] as Mat4;
    moved[13] = -10;
    expect(s?.shift).toBe(-10);
    expect(s?.patch).toEqual({
      transform: moved,
      georef: layerTransformToGeoref(moved, PROJECT, GEOREF, 'place-model'),
      placement: 'placed',
    });
    const g = (s?.patch as { georef: Georef }).georef;
    expect(g.provenance.by).toBe('place-model');
    expect(s?.undo).toEqual({ transform: I, georef: GEOREF, placement: 'needed' });
  });

  it('marks a waiting model without a georef placed, as Place model does', () => {
    const s = planDrop(
      { kind: 'mesh', layerId: 'm', name: 'M', low: 1, transform: I, placement: 'needed' },
      0,
      PROJECT,
    );
    const moved = [...I] as Mat4;
    moved[13] = -1;
    expect(s?.patch).toEqual({ transform: moved, placement: 'placed' });
    expect(s?.undo).toEqual({ transform: I, placement: 'needed' });
  });

  it('moves a plain model by its transform alone', () => {
    const s = planDrop(
      { kind: 'mesh', layerId: 'm', name: 'M', low: -3, transform: I },
      0,
      PROJECT,
    );
    const moved = [...I] as Mat4;
    moved[13] = 3;
    expect(s?.patch).toEqual({ transform: moved });
    expect(s?.undo).toEqual({ transform: I });
  });

  it('leaves an item within 5 cm', () => {
    expect(planDrop(cloud(0.04), 0, PROJECT)).toBeNull();
    expect(planDrop(cloud(-0.04), 0, PROJECT)).toBeNull();
  });
});

describe('groundUnder', () => {
  const box: Box = { min: [0, 0, 0], max: [60, 5, 60] };

  it('uses the 10th percentile of the DSM hits', () => {
    const seen: [number, number][] = [];
    let n = 0;
    const g = groundUnder(box, (x, z) => {
      seen.push([x, z]);
      n++;
      // two low spikes (a hole in the DSM) and the rest at 5
      return n <= 2 ? -40 : 5;
    });
    expect(seen).toHaveLength(49);
    expect(seen[0]).toEqual([0, 0]);
    expect(seen.at(-1)).toEqual([60, 60]);
    expect(g).toEqual({ y: 5, source: 'dsm' });
  });

  it('falls back to the project ground with too few DSM hits', () => {
    let n = 0;
    const g = groundUnder(box, () => (n++ < 4 ? 3 : null));
    expect(g).toEqual({ y: 0, source: 'project' });
  });
});

describe('helpers', () => {
  it('takes a percentile and none of nothing', () => {
    expect(percentile([3, 1, 2, 5, 4], 0)).toBe(1);
    expect(percentile([3, 1, 2, 5, 4], 1)).toBe(5);
    expect(percentile([3, 1, 2, 5, 4], 0.5)).toBe(3);
    expect(percentile([], 0.1)).toBeNull();
  });

  it('formats a shift', () => {
    expect(formatShift(-31.23)).toBe('31.2 m');
    expect(formatShift(0.5)).toBe('0.5 m');
    expect(formatShift(1500)).toBe('1.5 km');
  });
});

describe('droppable', () => {
  const base = { id: 'x', name: 'X', visible: true, src: { path: 'x' } };
  const pc = (format: string, extra: object = {}) =>
    ({ kind: 'pointcloud', ...base, format, ...extra }) as unknown as Layer;
  const mesh = (extra: object = {}) =>
    ({ kind: 'mesh', ...base, transform: I, ...extra }) as unknown as Layer;

  it('names what cannot drop', () => {
    expect(droppable(pc('copc'))).toBe('ok');
    expect(droppable(pc('png-packed'))).toBe('ok');
    expect(droppable(pc('kit-packed'))).toBe('kit');
    expect(droppable(pc('copc', { derived: { kind: 'change' } }))).toBe('no');
    expect(droppable(pc('copc', { derived: { kind: 'cleanup' } }))).toBe('ok');
    expect(droppable(mesh())).toBe('ok');
    expect(droppable(mesh({ derived: { kind: 'model' } }))).toBe('ok');
    expect(droppable(mesh({ derived: { kind: 'change' } }))).toBe('no');
    expect(droppable(mesh({ derived: { kind: 'model', draft: true } }))).toBe('no');
    expect(droppable({ kind: 'photos', ...base, items: [] } as unknown as Layer)).toBe('no');
  });
});

describe('Drop to ground for a walk', () => {
  // a walk's measure: `low` 0 and the ground the median floor shift (walkFloorShift)
  const walk = (heightOffsetM = 0): DropItem => ({
    kind: 'walk',
    layerId: 'walk-w1',
    name: 'Walk',
    low: 0,
    heightOffsetM,
  });

  it('raises a walk placed on the ortho plane (ground 0) onto a floor 1.25 m up', () => {
    expect(planDrop(walk(), 1.25, PROJECT)).toEqual({
      layerId: 'walk-w1',
      name: 'Walk',
      shift: 1.25,
      patch: { heightOffsetM: 1.25 },
      undo: { heightOffsetM: null },
    });
  });

  it('lowers a walk whose pins sat on a roof: a negative offset', () => {
    const s = planDrop(walk(), -6.2, PROJECT);
    expect(s?.patch).toEqual({ heightOffsetM: -6.2 });
    expect(s?.shift).toBe(-6.2);
  });

  it('adds to the offset it has, and leaves a walk already on the floor', () => {
    const s = planDrop(walk(1.25), -0.5, PROJECT);
    expect(s?.patch).toEqual({ heightOffsetM: 0.75 });
    expect(s?.undo).toEqual({ heightOffsetM: 1.25 });
    expect(planDrop(walk(1.25), 0.02, PROJECT)).toBeNull();
  });

  it('drops a placed walk, not one without a placement', () => {
    const w = (extra: object = {}) =>
      ({
        kind: 'walk',
        id: 'walk-w1',
        name: 'W',
        visible: true,
        record: { path: 'walks/w1/walk.json' },
        src: { path: 'walks/w1/playback.mp4' },
        durationS: 10,
        ...extra,
      }) as unknown as Layer;
    const place = (quality: string) => ({
      place: {
        pins: [
          { t: 1, surface: '@model', at: [0, 0] },
          { t: 9, surface: '@model', at: [9, 0] },
        ],
        yawOffsetDeg: 0,
        heightM: 1.7,
        quality,
      },
    });
    expect(droppable(w(place('good')))).toBe('ok');
    expect(droppable(w())).toBe('no');
    expect(droppable(w(place('unplaced')))).toBe('no');
  });
});
