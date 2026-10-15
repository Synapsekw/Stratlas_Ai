/**
 * Acceptance C (placement and reconstruction stated honestly) and I (nothing raw goes to a model)
 * across the seams, from the packs the Python `model.evidence` job wrote (committed fixtures,
 * synthetic only): the run store's georeference, the measurement summary and the exact request
 * payload.
 */
import { readFileSync } from 'node:fs';
import { buildEngineerPayload, SUMMARY_MAX_CHARS } from '@aio/ai/main';
import { assemble, setupFor, stackProposal } from '@aio/modelling';
import { EngineerProposal, EvidencePack, type EngineerSetup } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { georefFor } from './runStore';
import { measurementSummary, SUMMARY_MAX_ITEMS } from './summary';

const pack = (name: string) =>
  EvidencePack.parse(
    JSON.parse(
      readFileSync(
        new URL(
          `../../../../../packages/schema/src/__fixtures__/engineering/${name}`,
          import.meta.url,
        ),
        'utf8',
      ),
    ),
  );

const partial = pack('evidence.partial-stack.json');
const single = pack('evidence.single-photo.json');
const project = { crs: { epsg: 32633 }, origin: [500000, 3200000, 10] as [number, number, number] };

const setup = (o: Partial<EngineerSetup>): EngineerSetup => ({
  ...setupFor('chimney'),
  ...o,
});

const build = (evidence: typeof partial, s: EngineerSetup) =>
  assemble({
    modelId: 'acc-1',
    runId: 'run-acc',
    family: 'chimney',
    scope: 'asset',
    evidence,
    proposal: EngineerProposal.parse(stackProposal()),
    setup: s,
    user: { params: {}, counts: {}, levels: {}, removed: [], added: [] },
    previous: null,
    now: '2026-10-16T00:00:00.000Z',
  }).model;

/** The longest list anywhere in a JSON value, and whether any list looks like points. */
function lists(v: unknown): { longest: number; pointLike: boolean } {
  let longest = 0;
  let pointLike = false;
  const walk = (x: unknown) => {
    if (Array.isArray(x)) {
      longest = Math.max(longest, x.length);
      if (x.length >= 3 && x.every((e) => Array.isArray(e) && e.length === 3))
        pointLike ||= x.length > 64;
      x.forEach(walk);
    } else if (x && typeof x === 'object') Object.values(x).forEach(walk);
  };
  walk(v);
  return { longest, pointLike };
}

describe('C: a single photo, placed and described honestly', () => {
  it('stays unplaced with a provisional scale, whatever placement was asked for from source', () => {
    for (const placement of ['from-source', 'unplaced'] as const) {
      const s = setup({ placement });
      const g = georefFor(build(single, s), s, single, project);
      expect(g.horizontal.status).toBe('unplaced');
      expect(g.scale.status).toBe('provisional');
      expect(g.heading.status).toBe('assumed-grid');
    }
    expect(single.reconstruction).toBe('unavailable');
  });

  it('a metric cloud placed from source is placed, with a measured scale', () => {
    const s = setup({ placement: 'from-source' });
    const g = georefFor(build(partial, s), s, partial, project);
    expect(g.horizontal.status).toBe('from-source');
    expect(g.scale.status).toBe('measured');
    expect(partial.reconstruction).toBe('not-needed');
  });
});

describe('I: nothing raw is sent to a model', () => {
  it('the pack holds measurements only', () => {
    const l = lists(partial);
    expect(l.longest).toBeLessThanOrEqual(256);
    expect(l.pointLike).toBe(false);
    expect(partial.samples.kept).toBeGreaterThan(10_000);
  });

  it('the summary is short, rounded and cut to a few items per list', () => {
    const text = measurementSummary(partial, setup({}));
    expect(text.length).toBeLessThan(SUMMARY_MAX_CHARS);
    const parsed: unknown = JSON.parse(text);
    expect(lists(parsed).longest).toBeLessThanOrEqual(SUMMARY_MAX_ITEMS);
    expect(lists(parsed).pointLike).toBe(false);
    expect(text).not.toMatch(/photos\/|\.jpg|\.las|\.laz|\.copc|[A-Za-z]:\\/i);
    expect(text).not.toMatch(/"(?:xyz|points|positions|vertices)"/);
  });

  it('the request payload is the summary and the pack images, a small fraction of the cloud', async () => {
    const summary = measurementSummary(partial, setup({}));
    const built = await buildEngineerPayload(
      {
        projectId: 'p',
        runId: 'run-acc',
        pass: 1,
        images: [],
        summary,
        setup: setup({}),
      },
      { vision: true, structured: true, maxImages: 20, maxImagePx: 1568 },
    );
    if (!built.ok) throw new Error(built.reason);
    expect(built.payload.images).toEqual([]);
    expect(built.payload.bytes).toBeLessThan(60_000);
    // one point of the cloud is at least 12 bytes: the whole payload is far smaller than 10 000 of them
    expect(built.payload.bytes).toBeLessThan(partial.samples.kept * 12 * 0.1);
    expect(built.payload.text).toContain('"taper"');
    expect(built.payload.text).not.toMatch(/"(?:xyz|points|positions|vertices)"/);
    // a summary that is too long is refused, not cut silently into the request
    const tooLong = await buildEngineerPayload(
      {
        projectId: 'p',
        runId: 'run-acc',
        pass: 1,
        images: [],
        summary: 'x'.repeat(SUMMARY_MAX_CHARS + 1),
        setup: setup({}),
      },
      { vision: true, structured: true, maxImages: 20, maxImagePx: 1568 },
    );
    expect(tooLong.ok).toBe(false);
  });
});
