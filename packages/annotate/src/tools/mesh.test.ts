import type { Sighting, Vec3 } from '@aio/schema';
import { BoxGeometry, Group, Mesh, MeshBasicMaterial, Raycaster, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { shiftOfManifest } from '../model/dateFrame';
import { linedUp, makeIssue, photoSighting, tankModel } from '../testing';
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
      {
        issueId: 'i1',
        code: 'F01',
        p: [1, 2, 3],
        color: '#e5484d',
        selected: true,
        draft: true,
        rank: 5,
      },
    ]);
  });

  it('applies the pin filter but always keeps the selected issue', () => {
    const issues = [
      makeIssue(),
      makeIssue({ id: 'low', code: 'F02', severity: 2 }),
      makeIssue({ id: 'unc', code: 'F03', severity: 'uncertain' }),
    ];
    const ids = (sel: string | null, f: Parameters<typeof issuePins>[3]) =>
      issuePins(issues, [tankModel], sel, f).map((p) => p.issueId);
    expect(ids(null, 'all')).toEqual(['i1', 'low', 'unc']);
    expect(ids(null, 3)).toEqual(['i1']);
    expect(ids(null, 'off')).toEqual([]);
    expect(ids('low', 'off')).toEqual(['low']);
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

describe('placed areas', () => {
  it('prefer a placed area for the best anchor', () => {
    const issue = makeIssue({
      sightings: [
        photoSighting,
        { on: 'mesh', layer: 'm', geom: { type: 'spoint', p: [9, 9, 9], n: [0, 1, 0] } },
        {
          on: 'pointcloud',
          layer: 'c',
          geom: {
            type: 'polygon3',
            points: [
              [0, 0, 0],
              [3, 0, 0],
              [3, 0, 3],
            ],
          },
          from: { sighting: 0 },
        },
      ],
    });
    expect(bestAnchor(issue)).toEqual([2, 0, 1]);
  });

  it('leave out the pins of issues whose area is drawn', () => {
    const a = makeIssue({ id: 'a' });
    const b = makeIssue({ id: 'b', code: 'F02' });
    expect(
      issuePins([a, b], [tankModel], null, 'all', new Set(['a'])).map((p) => p.issueId),
    ).toEqual(['b']);
  });
});

describe('pins of a lined-up date', () => {
  const shiftOf = shiftOfManifest(linedUp);
  const on = (layer: string, p: Vec3): Sighting => ({
    on: 'mesh',
    layer,
    geom: { type: 'spoint', p, n: [0, 1, 0] },
  });

  it('draws a pin of a lined-up mesh at the corrected place', () => {
    const moved = makeIssue({ id: 'a', sightings: [on('model-d2', [10, 1, -3])] });
    const still = makeIssue({ id: 'b', code: 'F02', sightings: [on('model-d1', [10, 1, -3])] });
    const pins = issuePins([moved, still], [tankModel], null, 'all', undefined, shiftOf);
    expect(pins.map((p) => [p.issueId, p.p])).toEqual([
      ['a', [12, 1, -3]],
      ['b', [10, 1, -3]],
    ]);
    // without the shifts the stored place
    expect(issuePins([moved], [tankModel], null).map((p) => p.p)).toEqual([[10, 1, -3]]);
  });

  it('anchors a sighting and an issue through their layer shift', () => {
    const cloud: Sighting = {
      on: 'pointcloud',
      layer: 'cloud-d2',
      geom: { type: 'box3', min: [0, 0, 0], max: [2, 2, 2] },
    };
    expect(sightingAnchor(cloud, shiftOf)).toEqual([3, 1, 1]);
    expect(bestAnchor(makeIssue({ sightings: [cloud] }), shiftOf)).toEqual([3, 1, 1]);
    expect(sightingAnchor(photoSighting, shiftOf)).toBeNull();
  });
});
