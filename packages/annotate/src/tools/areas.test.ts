import type { Issue, Sighting, Vec3 } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { makeIssue, photoSighting, tankModel } from '../testing';
import { areaBuffers, clipRing, hitArea, issueAreas, screenAreas } from './areas';

const ring: Vec3[] = [
  [0, 0, 0],
  [2, 0, 0],
  [2, 0, 2],
  [0, 0, 2],
];
const outline = (layer: string): Sighting => ({
  on: 'mesh',
  layer,
  geom: { type: 'spolygon', points: ring },
  from: { sighting: 0 },
});
const prism: Sighting = {
  on: 'pointcloud',
  layer: 'cloud',
  geom: { type: 'polygon3', points: ring, height: 1 },
  from: { sighting: 0 },
};
const placed = (over: Partial<Issue> = {}) =>
  makeIssue({ sightings: [photoSighting, outline('tank'), prism], ...over });

describe('issueAreas', () => {
  it('lists the outline and the prism of a placed issue in its severity colour', () => {
    const a = issueAreas([placed()], [tankModel], null, 'all', {});
    expect(a.map((x) => [x.kind, x.layer, x.height])).toEqual([
      ['surface', 'tank', 0],
      ['prism', 'cloud', 1],
    ]);
    expect(a[0]?.color).toBe('#e5484d');
    expect(a[0]?.centre).toEqual([1, 0, 1]);
    expect(a[1]?.centre).toEqual([1, 0.5, 1]);
  });

  it('skips hidden layers, hand-drawn polygons and issues the pin filter hides', () => {
    expect(
      issueAreas([placed()], [tankModel], null, 'all', { tank: true }).map((x) => x.layer),
    ).toEqual(['cloud']);
    const drawn = makeIssue({
      sightings: [{ on: 'mesh', layer: 'tank', geom: { type: 'spolygon', points: ring } }],
    });
    expect(issueAreas([drawn], [tankModel], null, 'all', {})).toEqual([]);
    const low = placed({ severity: 2 });
    expect(issueAreas([low], [tankModel], null, 4, {})).toEqual([]);
    expect(issueAreas([low], [tankModel], low.id, 4, {})).toHaveLength(2);
  });
});

describe('areaBuffers', () => {
  it('draws a surface as its ring with a fan, a prism as a wireframe with closed faces', () => {
    const [surface, box] = issueAreas([placed()], [tankModel], null, 'all', {});
    if (!surface || !box) throw new Error('no areas');
    const rgb = (): [number, number, number] => [1, 0, 0];
    const s = areaBuffers([surface], new Set(), rgb);
    expect(s.lines.length / 3).toBe(8); // 4 segments
    expect(s.fill.length / 3).toBe(12); // 4 triangles
    const p = areaBuffers([box], new Set(), rgb);
    expect(p.lines.length / 3).toBe(24); // bottom, top, 4 posts
    expect(p.fill.length / 3).toBe(48); // 2 fans and 4 sides of 2 triangles
    const lit = areaBuffers([surface], new Set([surface.issueId]), rgb);
    expect(lit.lineColors[1]).toBeGreaterThan(0); // mixed towards white
    expect(s.lineColors[1]).toBe(0);
  });
});

describe('screen hits', () => {
  it('projects each area and picks the smallest under the cursor', () => {
    const areas = issueAreas(
      [
        placed({ id: 'big' }),
        makeIssue({
          id: 'small',
          code: 'F02',
          sightings: [
            photoSighting,
            {
              on: 'mesh',
              layer: 'tank',
              geom: { type: 'spolygon', points: ring.map((p): Vec3 => [p[0] / 4, 0, p[2] / 4]) },
              from: { sighting: 0 },
            },
          ],
        }),
      ],
      [tankModel],
      null,
      'all',
      { cloud: true },
    );
    const top = (p: Vec3) => ({ x: p[0] * 100, y: p[2] * 100 });
    const hits = screenAreas(areas, top);
    expect(hits.map((h) => h.issueId)).toEqual(['big', 'small']);
    expect(hits[0]?.centre).toEqual({ x: 100, y: 100 });
    expect(hitArea(hits, 20, 20)).toBe('small');
    expect(hitArea(hits, 150, 150)).toBe('big');
    expect(hitArea(hits, 500, 500)).toBeNull();
    // off screen: no ring, no centre, still in order
    expect(screenAreas(areas, () => null).map((h) => [h.rings.length, h.centre])).toEqual([
      [0, null],
      [0, null],
    ]);
  });
});

describe('clipRing', () => {
  it('cuts a ring at a plane and keeps the part in front', () => {
    const depth = (p: Vec3) => p[2];
    const sq: Vec3[] = [
      [0, 0, -1],
      [2, 0, -1],
      [2, 0, 3],
      [0, 0, 3],
    ];
    expect(clipRing(sq, depth, 1)).toEqual([
      [2, 0, 1],
      [2, 0, 3],
      [0, 0, 3],
      [0, 0, 1],
    ]);
    expect(clipRing(sq, depth, 5)).toEqual([]);
  });

  it('lets screenAreas keep a ring with a vertex behind the camera', () => {
    const [area] = issueAreas([placed()], [tankModel], null, 'all', { cloud: true });
    if (!area) throw new Error('no area');
    const front = (p: Vec3) => (p[2] > 1 ? null : { x: p[0], y: p[2] });
    expect(screenAreas([area], front)[0]?.rings).toEqual([]);
    const hit = screenAreas([area], front, (r) => clipRing(r, (p) => 1 - p[2], 0));
    expect(hit[0]?.rings).toHaveLength(1);
  });
});
