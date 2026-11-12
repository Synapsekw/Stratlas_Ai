/**
 * The index at size: history cuts keep the newest entries with true totals, long names stay within
 * the contract, and a 20,000-detection project builds in a bounded time (the numbers are printed
 * for the session note). `QUADRION_FACTS_BENCH` (folders separated by `;`) also times real
 * project folders, such as the built demos.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Detection, type AuditEntry } from '@aio/schema';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { extractFacts, fitKey } from './extract';
import { pruneIndexes, stillThere, syncFolder } from './folder';
import { readProjectSources, type ProjectSources } from './sources';
import { openFactIndex } from './store';
import { writeFixtureProject } from './testing';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'facts-scale-'));
  writeFixtureProject(join(root, 'p'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const base = () => readProjectSources(join(root, 'p'));

/** `n` detections on photo p1 (survey c2), each a little older than the next. */
function detections(n: number): ProjectSources['detections'][number] {
  return {
    file: 'detections/big.json',
    source: 'ai',
    layer: 'ph1',
    detections: Array.from({ length: n }, (_, i) =>
      Detection.parse({
        id: `big-${String(i).padStart(5, '0')}`,
        photo: 'p1',
        class: 'crack',
        bbox: [0, 0, 10, 10],
        createdAt: new Date(Date.UTC(2026, 7, 1, 0, 0, i % 3600)).toISOString(),
      }),
    ),
  };
}

function event(i: number, subject: { rec: string; id: string }): AuditEntry {
  return {
    op: `op-${String(i).padStart(5, '0')}`,
    chain: 'c',
    seq: i,
    hlc: '',
    at: new Date(Date.UTC(2026, 7, 1) + i * 60_000).toISOString(),
    actor: { id: 'a' },
    device: 'd',
    kind: 'measurement.patch',
    target: subject,
    label: `Edit ${i}`,
    how: 'hand',
    state: 'ok',
  };
}

describe('history at size', () => {
  it('a survey with 300 detections still shows its issue and volumes, with true totals', async () => {
    const src = await base();
    src.detections.push(detections(300));
    const ix = openFactIndex(':memory:');
    ix.sync(extractFacts(src));
    const h = ix.historyOf('survey:c2');
    expect(h.linked.length).toBe(200);
    expect(h.totals.linked).toBeGreaterThan(300);
    const subjects = new Set(h.linked.map((l) => l.fact.subject));
    expect(subjects).toContain('issue:i1');
    expect(subjects).toContain('measurement:pile-north');
    ix.close();
  });

  it('a measurement with 300 journal ops keeps its newest 200, oldest first', async () => {
    const src = await base();
    src.events = Array.from({ length: 300 }, (_, i) =>
      event(i, { rec: 'measurement', id: 'pile-north' }),
    );
    const ix = openFactIndex(':memory:');
    ix.sync(extractFacts(src));
    const h = ix.historyOf('measurement:pile-north');
    expect(h.totals.events).toBe(300);
    expect(h.events).toHaveLength(200);
    expect(h.events[0]?.op).toBe('op-00100');
    expect(h.events.at(-1)?.op).toBe('op-00299');
    expect(h.totals.facts).toBe(h.facts.length);
    ix.close();
  });
});

describe('long names', () => {
  it('keeps keys unique and within the limit', () => {
    const a = fitKey(`issue:${'x'.repeat(500)}a`, 400);
    const b = fitKey(`issue:${'x'.repeat(500)}b`, 400);
    expect(a.length).toBe(400);
    expect(a).not.toBe(b);
    expect(fitKey('issue:i1', 400)).toBe('issue:i1');
  });
});

describe('folders', () => {
  it('syncs a folder into a file and prunes it once the folder is gone', async () => {
    const dir = join(root, 'ix');
    const file = join(dir, 'a.sqlite');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(dir);
    const r = await syncFolder(join(root, 'p'), file);
    expect(r.added).toBe(r.facts);
    expect((await syncFolder(join(root, 'p'), file)).added).toBe(0);
    expect(await pruneIndexes(dir)).toEqual([]);
    rmSync(join(root, 'p'), { recursive: true, force: true });
    expect(await pruneIndexes(dir)).toEqual([file]);
  });
});

describe('an unplugged drive', () => {
  it('keeps the index of a folder whose drive or share is not there', () => {
    const on =
      (...paths: string[]) =>
      (p: string) =>
        paths.includes(p);
    // the drive is there but the folder is gone: prune
    expect(stillThere('E:\\Sites\\gone', on('E:\\'))).toBe(false);
    // the drive itself is missing (unplugged): keep
    expect(stillThere('F:\\Sites\\quarry', on('E:\\'))).toBe(true);
    // a share offline: keep
    expect(stillThere('\\\\nas\\survey\\quarry', on())).toBe(true);
    expect(stillThere('E:\\Sites\\here', on('E:\\', 'E:\\Sites\\here'))).toBe(true);
  });

  it('prunes nothing whose drive is missing', async () => {
    const dir = join(root, 'ix');
    const file = join(dir, 'a.sqlite');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(dir);
    await syncFolder(join(root, 'p'), file);
    expect(await pruneIndexes(dir, () => true)).toEqual([]);
  });
});

describe('build time', () => {
  it('builds a 20,000-detection project in bounded time', { timeout: 120_000 }, async () => {
    const src = await base();
    src.detections.push(detections(20_000));
    const t0 = performance.now();
    const next = extractFacts(src);
    const t1 = performance.now();
    const file = join(root, 'big.sqlite');
    const ix = openFactIndex(file);
    ix.sync(next);
    const t2 = performance.now();
    const again = ix.sync(extractFacts(src));
    const t3 = performance.now();
    ix.close();
    // eslint-disable-next-line no-console -- the numbers go in the session note
    console.log(
      `[facts bench] 20k detections: ${next.facts.length} facts, ${next.links.length} links; extract ${Math.round(t1 - t0)} ms, first write ${Math.round(t2 - t1)} ms, unchanged update ${Math.round(t3 - t2)} ms`,
    );
    expect(again.added + again.changed + again.removed).toBe(0);
    expect(t2 - t0).toBeLessThan(60_000);
  });

  const bench = (process.env.QUADRION_FACTS_BENCH ?? '').split(';').filter(Boolean);
  it.skipIf(bench.length === 0)('times real folders', { timeout: 600_000 }, async () => {
    for (const folder of bench) {
      const r = await syncFolder(folder, join(root, `${String(bench.indexOf(folder))}.sqlite`));
      // eslint-disable-next-line no-console -- the numbers go in the session note
      console.log(
        `[facts bench] ${folder}: ${r.facts} facts, ${r.links} links; read ${r.ms.read} ms, extract ${r.ms.extract} ms, write ${r.ms.sync} ms`,
      );
    }
  });
});
