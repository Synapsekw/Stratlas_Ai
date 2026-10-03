import { BoxGeometry, Group, Mesh, MeshBasicMaterial, Raycaster, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { makeIssue, photoSighting, tankModel } from '../testing';
import {
  bestAnchor,
  issuePins,
  meshDrawReducer,
  initialMeshDraw,
  meshSightingFromDraw,
  severityColor,
  sightingAnchor,
  surfacePointFromHit,
} from './mesh';

describe('anchors', () => {
  it('anchors each 3D sighting kind', () => {
    expect(
      sightingAnchor({
        on: 'mesh',
        layer: 'm',
        geom: { type: 'spoint', p: [1, 2, 3], n: [0, 1, 0] },
      }),
    ).toEqual([1, 2, 3]);
    expect(
      sightingAnchor({
        on: 'mesh',
        layer: 'm',
        geom: {
          type: 'spolyline',
          points: [
            [0, 0, 0],
            [2, 2, 2],
          ],
        },
      }),
    ).toEqual([1, 1, 1]);
    expect(
      sightingAnchor({
        on: 'pointcloud',
        layer: 'c',
        geom: { type: 'box3', min: [0, 0, 0], max: [2, 4, 6] },
      }),
    ).toEqual([1, 2, 3]);
    expect(sightingAnchor(photoSighting)).toBeNull();
  });

  it('prefers mesh over point cloud for the best anchor', () => {
    const issue = makeIssue({
      sightings: [
        photoSighting,
        { on: 'pointcloud', layer: 'c', geom: { type: 'point3', p: [9, 9, 9] } },
        { on: 'mesh', layer: 'm', geom: { type: 'spoint', p: [1, 1, 1], n: [0, 1, 0] } },
      ],
    });
    expect(bestAnchor(issue)).toEqual([1, 1, 1]);
    expect(bestAnchor(makeIssue({ sightings: [photoSighting] }))).toBeNull();
  });
});

describe('issuePins', () => {
  it('makes one pin per anchored issue with the model colour', () => {
    const pins = issuePins(
      [makeIssue(), makeIssue({ id: 'x', code: 'F02', sightings: [photoSighting] })],
      [tankModel],
      'i1',
    );
    expect(pins).toEqual([
      { issueId: 'i1', code: 'F01', p: [1, 2, 3], color: '#e5484d', selected: true, draft: true },
    ]);
  });

  it('colours uncertain and unknown severities', () => {
    expect(severityColor(tankModel, 'uncertain')).toBe('#b68ef8');
    expect(severityColor(undefined, 3)).toBe('#8a94a6');
  });
});

describe('mesh drawing', () => {
  it('a point finishes on one pick', () => {
    const s = meshDrawReducer(initialMeshDraw('point'), {
      type: 'pick',
      layer: 'tank',
      p: [1, 2, 3],
      n: [0, 0, 1],
    });
    expect(meshSightingFromDraw(s)).toEqual({
      on: 'mesh',
      layer: 'tank',
      geom: { type: 'spoint', p: [1, 2, 3], n: [0, 0, 1] },
    });
  });

  it('polylines and polygons finish with enough vertices', () => {
    let s = initialMeshDraw('polygon');
    for (const p of [
      [0, 0, 0],
      [1, 0, 0],
    ] as [number, number, number][]) {
      s = meshDrawReducer(s, { type: 'pick', layer: 'tank', p, n: [0, 1, 0] });
    }
    expect(meshDrawReducer(s, { type: 'finish' }).done).toBe(false);
    s = meshDrawReducer(s, { type: 'pick', layer: 'tank', p: [1, 0, 1], n: [0, 1, 0] });
    s = meshDrawReducer(s, { type: 'finish' });
    expect(meshSightingFromDraw(s)?.geom.type).toBe('spolygon');
    let l = meshDrawReducer(initialMeshDraw('polyline'), {
      type: 'pick',
      layer: 't',
      p: [0, 0, 0],
      n: [0, 1, 0],
    });
    l = meshDrawReducer(l, { type: 'pick', layer: 't', p: [0, 1, 0], n: [0, 1, 0] });
    l = meshDrawReducer(l, { type: 'finish' });
    expect(meshSightingFromDraw(l)?.geom.type).toBe('spolyline');
  });
});

describe('surfacePointFromHit', () => {
  it('reads point, world normal, face and layer from a raycast hit', () => {
    const g = new Group();
    g.userData.layerId = 'tank';
    const box = new Mesh(new BoxGeometry(2, 2, 2), new MeshBasicMaterial());
    g.add(box);
    g.updateMatrixWorld(true);
    const hit = new Raycaster(new Vector3(0, 5, 0), new Vector3(0, -1, 0)).intersectObject(
      g,
      true,
    )[0];
    if (!hit) throw new Error('no hit');
    const s = surfacePointFromHit(hit);
    expect(s.layer).toBe('tank');
    expect(s.p[1]).toBeCloseTo(1);
    expect(s.n[1]).toBeCloseTo(1);
  });
});
