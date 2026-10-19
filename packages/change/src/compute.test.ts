import {
  ChangeSet,
  DEFAULT_CHANGE_THRESHOLDS,
  type Layer,
  type ProjectManifest,
} from '@aio/schema';
import { captureIndex } from '@aio/workspace/captures';
import { describe, expect, it } from 'vitest';
import { ChangeCancelled, computeInApp, type ComputeSources } from './compute';
import { changeSetStale } from './stale';
import { issue, SITE } from './testing';

const vector = (id: string, capture: string): Layer => ({
  kind: 'vector',
  id,
  name: 'Tracks',
  visible: true,
  capture,
  src: { path: `vectors/${id}.geojson` },
  format: 'geojson',
});
const M = 1 / 111_195;
const fc = (y: number) => ({
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      properties: { name: 'Fence' },
      geometry: {
        type: 'LineString',
        coordinates: [
          [0, y * M],
          [100 * M, y * M],
        ],
      },
    },
  ],
});

function sources(over: Partial<ComputeSources> = {}): ComputeSources {
  const manifest = {
    ...SITE,
    layers: [...SITE.layers, vector('tracks-d1', 'd1'), vector('tracks-d2', 'd2')],
  };
  return {
    manifest,
    index: captureIndex(manifest),
    thresholds: DEFAULT_CHANGE_THRESHOLDS,
    issues: () =>
      Promise.resolve([
        issue({ code: 'F01', layer: 'model-d1', at: [0, 0, 0] }),
        issue({ code: 'F11', layer: 'model-d2', at: [20, 0, 0] }),
      ]),
    passes: () => Promise.resolve([]),
    geojson: (l) => Promise.resolve(fc(l.id === 'tracks-d1' ? 0 : 4)),
    previous: () => Promise.resolve(null),
    now: () => '2026-10-06T12:00:00.000Z',
    ...over,
  };
}

const lineUpOf = (
  m: ProjectManifest,
  capture: string,
  eastM: number,
  northM = 0,
): ProjectManifest => ({
  ...m,
  captures: m.captures.map((c) =>
    c.id === capture
      ? { ...c, lineUp: { eastM, northM, with: 'd1', at: '2026-10-10T00:00:00.000Z' } }
      : c,
  ),
});

function shifted(eastM: number, over: Partial<ComputeSources> = {}): ComputeSources {
  const base = sources(over);
  const manifest = lineUpOf(base.manifest, 'd2', eastM);
  return { ...base, manifest, index: captureIndex(manifest) };
}

describe('a turned date without a coordinate system', () => {
  it('a turned vector pair without a coordinate system is skipped, other kinds still run', async () => {
    const base = sources();
    const manifest: ProjectManifest = {
      ...base.manifest,
      captures: base.manifest.captures.map((c) =>
        c.id === 'd2'
          ? {
              ...c,
              lineUp: { eastM: 1, northM: 0, with: 'd1', at: '2026-10-10T00:00:00.000Z' },
              lineUpTurn: {
                rotationDeg: 0.5,
                scale: 1,
                pivotE: base.manifest.origin[0],
                pivotN: base.manifest.origin[1],
              },
            }
          : c,
      ),
    };
    const notes: string[] = [];
    const sets = await computeInApp(
      { ...base, manifest, index: captureIndex(manifest), note: (t) => notes.push(t) },
      'd1',
      'd2',
      ['issue', 'vector'],
    );
    expect(sets.map((s) => s.producer)).toEqual(['issues']);
    // the set records the turn beside the shift, so it is not out of date at once
    expect(sets[0]?.lineUpTurn?.to?.rotationDeg).toBe(0.5);
    expect(changeSetStale(ChangeSet.parse(sets[0]), manifest)).toBe(false);
    expect(notes).toEqual([
      "Vector changes were skipped: a turned line-up needs the project's coordinate system.",
    ]);
  });
});

describe('lined-up dates in the in-app producers', () => {
  // the fence, 2 m east of itself in the later file
  const east = (m: number) => {
    const f = fc(0);
    return {
      ...f,
      features: f.features.map((x) => ({
        ...x,
        geometry: {
          ...x.geometry,
          coordinates: x.geometry.coordinates.map(([lon, lat]) => [(lon ?? 0) + m * M, lat]),
        },
      })),
    };
  };

  it('compares vectors of a lined-up date at the corrected place', async () => {
    const geojson: ComputeSources['geojson'] = (l) =>
      Promise.resolve(l.id === 'tracks-d1' ? fc(0) : east(2));
    const [plain] = await computeInApp(sources({ geojson }), 'd1', 'd2', ['vector']);
    expect(plain?.items[0]?.verdict).toBe('moved');
    const [fixed] = await computeInApp(shifted(-2, { geojson }), 'd1', 'd2', ['vector']);
    expect(fixed?.items[0]?.verdict).toBe('unchanged');
  });

  it('compares issues of a lined-up date at the corrected place', async () => {
    const issues = () =>
      Promise.resolve([
        issue({ code: 'F01', layer: 'model-d1', at: [0, 0, 0] }),
        issue({ code: 'F11', layer: 'model-d2', at: [20, 0, 0] }),
      ]);
    const [plain] = await computeInApp(sources({ issues }), 'd1', 'd2', ['issue']);
    expect(plain?.items.map((i) => i.verdict).sort()).toEqual(['new', 'resolved']);
    const [fixed] = await computeInApp(shifted(-20, { issues }), 'd1', 'd2', ['issue']);
    expect(fixed?.items).toHaveLength(1);
    expect(fixed?.items[0]?.method).toBe('mesh');
  });

  it('records the shifts on a saved set', async () => {
    const [none] = await computeInApp(sources(), 'd1', 'd2', ['issue']);
    expect(none?.lineUp).toBeUndefined();
    const sets = await computeInApp(shifted(-2.0004), 'd1', 'd2', ['issue', 'vector']);
    for (const s of sets) {
      expect(ChangeSet.safeParse(s).success).toBe(true);
      expect(s.lineUp).toEqual({ to: { eastM: -2, northM: 0 } });
    }
  });
});

describe('the in-app producers of a pair', () => {
  it('writes one valid set per kind, named by pair and producer, earlier date first', async () => {
    const phases: string[] = [];
    const sets = await computeInApp(
      sources({ progress: (p) => phases.push(p), jobId: 'j1' }),
      'd2',
      'd1',
      ['vector', 'issue', 'region'],
    );
    expect(sets.map((s) => s.id)).toEqual(['d1-d2-issues', 'd1-d2-vectors']);
    for (const s of sets) expect(ChangeSet.safeParse(s).success).toBe(true);
    const [issues, vectors] = sets;
    expect(issues?.items.map((i) => i.verdict).sort()).toEqual(['new', 'resolved']);
    expect(issues?.run).toEqual({ at: '2026-10-06T12:00:00.000Z', jobId: 'j1' });
    expect(vectors?.items).toMatchObject([{ verdict: 'moved', distanceM: 4 }]);
    expect(phases.at(-1)).toBe('done');
  });

  it('keeps reviews from the previous file', async () => {
    const review = { status: 'confirmed' as const, by: 'me', at: '2026-10-05T00:00:00Z' };
    const [s] = await computeInApp(
      sources({
        previous: (id) =>
          Promise.resolve(
            id === 'd1-d2-issues'
              ? ChangeSet.parse({
                  schema: 'aio.change/1',
                  id,
                  from: 'd1',
                  to: 'd2',
                  producer: 'issues',
                  createdAt: '2026-10-05T00:00:00Z',
                  items: [{ kind: 'issue', id: 'issue:F11', verdict: 'new', review }],
                })
              : null,
          ),
      }),
      'd1',
      'd2',
      ['issue'],
    );
    expect(s?.items.find((i) => i.id === 'issue:F11')?.review).toEqual(review);
  });

  it('refuses one date twice, pipeline-only kinds, and stops when cancelled', async () => {
    await expect(computeInApp(sources(), 'd1', 'd1', ['issue'])).rejects.toThrow(/two different/);
    await expect(computeInApp(sources(), 'd1', 'd2', ['region'])).rejects.toThrow(/in the app/);
    await expect(
      computeInApp(sources({ cancelled: () => true }), 'd1', 'd2', ['issue']),
    ).rejects.toBeInstanceOf(ChangeCancelled);
  });
});
