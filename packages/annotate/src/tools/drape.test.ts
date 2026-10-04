import type { Sighting } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { makeIssue, tankModel } from '../testing';
import { drapedShapes, mapToLocal } from './drape';

const square: Sighting = {
  on: 'map',
  layer: 'ortho',
  geojson: {
    type: 'Polygon',
    coordinates: [
      [
        [0, 0],
        [10, 0],
        [10, 10],
        [0, 10],
        [0, 0],
      ],
    ],
  },
};

// a fake frame: lon is x east, lat is north (z = -lat)
const toLocal = (lon: number, lat: number): [number, number] => [lon, 0 - lat];

describe('map sightings draped on the ground', () => {
  it('outlines and fills polygon map sightings in their severity colour', () => {
    const issues = [
      makeIssue({ id: 'a', severity: 5, sightings: [square] }),
      makeIssue({ id: 'b', code: 'F02' }), // a mesh sighting only
    ];
    const d = drapedShapes(issues, [tankModel], null, toLocal, 0.05);
    // 4 edges, two vertices each, three floats per vertex
    expect(d.lines.positions).toHaveLength(4 * 2 * 3);
    expect(d.lines.positions.slice(0, 6)).toEqual(new Float32Array([0, 0.05, 0, 10, 0.05, 0]));
    // a square is two triangles
    expect(d.fill.indices).toHaveLength(6);
    expect(d.fill.faceIssue).toEqual(['a', 'a']);
    const red = tankModel.levels.find((l) => l.value === 5)?.color ?? '';
    const r = parseInt(red.slice(1, 3), 16) / 255;
    expect(d.lines.colors[0]).toBeCloseTo(r, 5);
    expect(d.selected).toBeNull();
  });

  it('keeps the selected issue apart, to draw it brighter', () => {
    const d = drapedShapes(
      [makeIssue({ id: 'a', sightings: [square] })],
      [tankModel],
      'a',
      toLocal,
      0,
    );
    expect(d.selected?.issueId).toBe('a');
    expect(d.selected?.positions).toHaveLength(4 * 2 * 3);
  });

  it('converts lon/lat to the local frame of a UTM project', () => {
    // UTM 38N origin of the ring road; a point 10 m east and 20 m north of it
    const f = mapToLocal({ epsg: 32638 }, [789217, 3252895, 0]);
    const fwd = mapToLocal({ epsg: 32638 }, [789207, 3252915, 0]);
    expect(f).not.toBeNull();
    const [lon, lat] = [47.9784, 29.3739];
    const a = f?.(lon, lat);
    const b = fwd?.(lon, lat);
    expect((a?.[0] ?? 0) - (b?.[0] ?? 0)).toBeCloseTo(-10, 6);
    // z points south: seen from an origin 20 m further north the point is 20 m more south
    expect((a?.[1] ?? 0) - (b?.[1] ?? 0)).toBeCloseTo(-20, 6);
  });
});
