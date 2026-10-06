import { DEFAULT_CHANGE_THRESHOLDS, type ChangeItem } from '@aio/schema';
import { captureIndex } from '@aio/workspace/captures';
import { describe, expect, it } from 'vitest';
import { issueChanges, issueDate, issuePosition, issueSize } from './issues';
import { issue, SITE } from './testing';

const index = captureIndex(SITE);
const run = (issues: Parameters<typeof issueChanges>[0]['issues']) =>
  issueChanges({
    manifest: SITE,
    index,
    issues,
    from: 'd1',
    to: 'd2',
    thresholds: DEFAULT_CHANGE_THRESHOLDS,
  });
const byId = (items: ChangeItem[]) => Object.fromEntries(items.map((i) => [i.id, i]));

describe('issue dates', () => {
  it('takes Issue.capture, then the sightings layer date, then createdAt', () => {
    expect(issueDate(issue({ code: 'F01', layer: 'model-d1', at: [0, 0, 0] }), index)).toBe('d1');
    expect(
      issueDate(issue({ code: 'F01', layer: 'model-d1', at: [0, 0, 0], capture: 'd2' }), index),
    ).toBe('d2');
    // an undated layer: the last survey on or before createdAt
    const common = { code: 'F02', layer: 'site-plan', at: [0, 0, 0] as const };
    expect(
      issueDate(issue({ ...common, at: [0, 0, 0], createdAt: '2026-05-01T00:00:00Z' }), index),
    ).toBe('d1');
    expect(
      issueDate(issue({ ...common, at: [0, 0, 0], createdAt: '2026-10-01T00:00:00Z' }), index),
    ).toBe('d2');
    // before every survey: the first
    expect(
      issueDate(issue({ ...common, at: [0, 0, 0], createdAt: '2025-01-01T00:00:00Z' }), index),
    ).toBe('d1');
  });

  it('places an issue by its mesh or cloud sighting and sizes it', () => {
    const i = issue({ code: 'F01', layer: 'model-d1', at: [1, 2, 3], areaM2: 0.75 });
    expect(issuePosition(i)).toEqual({ p: [1, 2, 3], method: 'mesh' });
    expect(issueSize(i)).toEqual({ value: 0.75, unit: 'm2' });
    const poly = {
      ...i,
      measurements: [],
      sightings: [
        {
          on: 'pointcloud' as const,
          layer: 'cloud',
          geom: {
            type: 'polygon3' as const,
            points: [
              [0, 0, 0],
              [2, 0, 0],
              [2, 0, 2],
              [0, 0, 2],
            ] as [number, number, number][],
          },
        },
      ],
    };
    expect(issuePosition(poly)).toEqual({ p: [1, 0, 1], method: 'pointcloud' });
    expect(issueSize(poly)).toEqual({ value: 4, unit: 'm2' });
  });
});

describe('issue change between two dates', () => {
  const items = run([
    // grown: same class, 0.2 m apart, area +50%
    issue({ code: 'F01', layer: 'model-d1', at: [0, 0, 0], areaM2: 1 }),
    issue({ code: 'F11', layer: 'model-d2', at: [0.2, 0, 0], areaM2: 1.5 }),
    // resolved: gone, and the second survey's photos looked at the place
    issue({ code: 'F02', layer: 'model-d1', at: [10, 0, 0], classId: 'coating' }),
    // not seen: gone, but no photo of the second survey looked there
    issue({ code: 'F03', layer: 'model-d1', at: [500, 0, 0] }),
    // new
    issue({ code: 'F12', layer: 'model-d2', at: [20, 0, 5] }),
    // worsened: severity up one level, same size
    issue({ code: 'F04', layer: 'model-d1', at: [30, 0, 0], areaM2: 1 }),
    issue({ code: 'F14', layer: 'model-d2', at: [30.1, 0, 0], areaM2: 1.05, severity: 3 }),
    // unchanged
    issue({ code: 'F05', layer: 'model-d1', at: [35, 0, -5] }),
    issue({ code: 'F15', layer: 'model-d2', at: [35, 0.1, -5] }),
    // another class at the same place: not a match
    issue({ code: 'F06', layer: 'model-d1', at: [40, 0, 10], classId: 'coating' }),
    issue({ code: 'F16', layer: 'model-d2', at: [40, 0, 10] }),
  ]);
  const got = byId(items);

  it('gives each issue its verdict', () => {
    expect(Object.fromEntries(items.map((i) => [i.id, i.verdict]))).toEqual({
      'issue:F01': 'grown',
      'issue:F02': 'resolved',
      'issue:F03': 'not-seen',
      'issue:F12': 'new',
      'issue:F04': 'worsened',
      'issue:F05': 'unchanged',
      'issue:F06': 'resolved',
      'issue:F16': 'new',
    });
  });

  it('records both issues, the size, the severity and the method', () => {
    expect(got['issue:F01']).toMatchObject({
      kind: 'issue',
      from: 'i-f01',
      to: 'i-f11',
      classId: 'corrosion',
      size: { from: 1, to: 1.5, unit: 'm2' },
      method: 'mesh',
    });
    expect(got['issue:F04']).toMatchObject({ severity: { from: 2, to: 3 } });
    expect(got['issue:F12']).toMatchObject({ to: 'i-f12', at: [20, 0, 5] });
    expect(got['issue:F02']).toMatchObject({ from: 'i-f02', at: [10, 0, 0] });
    expect(got['issue:F02']).not.toHaveProperty('to');
  });

  it('matches by a confirmed track first, whatever the distance', () => {
    const r = byId(
      run([
        issue({ code: 'F01', layer: 'model-d1', at: [0, 0, 0], track: 't1' }),
        issue({ code: 'F11', layer: 'model-d2', at: [9, 0, 0], track: 't1' }),
      ]),
    );
    expect(r['issue:F01']).toMatchObject({ verdict: 'unchanged', to: 'i-f11', method: 'track' });
  });

  it('never says resolved without a later photo of the place (no posed photos)', () => {
    const noPhotos = {
      ...SITE,
      layers: SITE.layers.filter((l) => l.id !== 'photos-d2'),
    };
    const r = issueChanges({
      manifest: noPhotos,
      index: captureIndex(noPhotos),
      issues: [issue({ code: 'F02', layer: 'model-d1', at: [10, 0, 0] })],
      from: 'd1',
      to: 'd2',
      thresholds: DEFAULT_CHANGE_THRESHOLDS,
    });
    expect(r.map((i) => i.verdict)).toEqual(['not-seen']);
  });

  it('honours the area threshold and ignores issues of other dates', () => {
    const r = byId(
      run([
        issue({ code: 'F01', layer: 'model-d1', at: [0, 0, 0], areaM2: 1 }),
        issue({ code: 'F11', layer: 'model-d2', at: [0, 0, 0], areaM2: 1.1 }),
      ]),
    );
    expect(r['issue:F01']?.verdict).toBe('unchanged');
    const shrunk = byId(
      run([
        issue({ code: 'F01', layer: 'model-d1', at: [0, 0, 0], areaM2: 1 }),
        issue({ code: 'F11', layer: 'model-d2', at: [0, 0, 0], areaM2: 0.5 }),
      ]),
    );
    expect(shrunk['issue:F01']?.verdict).toBe('shrunk');
  });
});
