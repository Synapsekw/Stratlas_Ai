import { ChangeSet, DEFAULT_CHANGE_THRESHOLDS, type Layer } from '@aio/schema';
import { captureIndex } from '@aio/workspace/captures';
import { describe, expect, it } from 'vitest';
import { ChangeCancelled, computeInApp, type ComputeSources } from './compute';
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
