import type { LedgerEntry } from '@aio/schema';
import { appendFile, mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendLedger, clearLedger, ledgerStats, readLedger, suggestThreshold } from './ledger';

const SHA = 'a'.repeat(64);
const entry = (
  verdict: LedgerEntry['verdict'],
  score: number | null,
  over: Partial<LedgerEntry> = {},
): LedgerEntry => ({
  detectorId: 'chimney',
  detectorVersion: 1,
  modelSha256: SHA,
  score,
  verdict,
  box: [0, 0, 10, 10],
  photo: { project: 'p', layer: 'l', id: 'i' },
  at: '2026-10-21T10:00:00.000Z',
  ...over,
});
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ledger-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('ledger', () => {
  it('append then read round-trips', async () => {
    const a = entry('accepted', 0.9);
    const b = entry('rejected', 0.4, { reason: undefined, note: 'shadow' });
    await appendLedger(dir, a, jpeg);
    await appendLedger(dir, b, jpeg);
    expect(await readLedger(dir, 'chimney')).toEqual([
      { ...a, crop: '1.jpg' },
      { ...b, crop: '2.jpg' },
    ]);
    expect((await readdir(join(dir, 'crops', 'chimney'))).sort()).toEqual(['1.jpg', '2.jpg']);
  });

  it('refuses unsafe ids and oversized crops', async () => {
    await expect(
      appendLedger(dir, entry('accepted', 1, { detectorId: '../x' }), jpeg),
    ).rejects.toThrow();
    await expect(readLedger(dir, '../x')).rejects.toThrow();
    await expect(
      appendLedger(dir, entry('accepted', 1), Buffer.alloc(3 * 1024 * 1024)),
    ).rejects.toThrow();
  });

  it('stats counts misses separately', () => {
    expect(
      ledgerStats([
        entry('accepted', 0.9),
        entry('rejected', 0.5),
        entry('miss', null),
        entry('miss', null),
      ]),
    ).toEqual({ accepted: 1, rejected: 1, misses: 2 });
  });

  it('the entry records its crop file', async () => {
    await appendLedger(dir, entry('accepted', 0.9, { detectionId: 'd1' }), jpeg);
    await appendLedger(dir, entry('miss', null), jpeg);
    const read = await readLedger(dir, 'chimney');
    expect(read.map((e) => e.crop)).toEqual(['1.jpg', '2.jpg']);
    expect(read[0]?.detectionId).toBe('d1');
  });

  it('a crop name sent by the caller is replaced by the one written', async () => {
    await appendLedger(dir, entry('accepted', 0.9, { crop: '../../x.jpg' }), jpeg);
    expect((await readLedger(dir, 'chimney'))[0]?.crop).toBe('1.jpg');
  });

  it('stats count the latest line per detection', () => {
    expect(
      ledgerStats([
        entry('accepted', 0.9, { detectionId: 'd1' }),
        entry('rejected', 0.9, { detectionId: 'd1' }),
        entry('accepted', 0.8, { detectionId: 'd2' }),
      ]),
    ).toEqual({ accepted: 1, rejected: 1, misses: 0 });
    expect(
      ledgerStats([
        entry('accepted', 0.9, { detectionId: 'd1' }),
        entry('rejected', 0.9, { detectionId: 'd1' }),
      ]),
    ).toEqual({ accepted: 0, rejected: 1, misses: 0 });
  });

  it('lines without detectionId all count', () => {
    expect(
      ledgerStats([entry('accepted', 0.9), entry('accepted', 0.9), entry('miss', null)]),
    ).toEqual({ accepted: 2, rejected: 0, misses: 1 });
  });

  it('the suggested threshold uses the latest line per detection', () => {
    // 20 detections accepted at 0.9, but one was then rejected: only 19 scored lines count as accepted
    const es = [
      ...Array.from({ length: 20 }, (_, i) => entry('accepted', 0.9, { detectionId: `d${i}` })),
      entry('rejected', 0.9, { detectionId: 'd0' }),
    ];
    expect(suggestThreshold(es)).not.toBeNull();
    expect(suggestThreshold(es.slice(0, 19).concat(es.slice(20)))).toBeNull();
  });

  it('suggest is null under 20', () => {
    const es = Array.from({ length: 19 }, (_, i) =>
      entry(i % 2 ? 'accepted' : 'rejected', 0.5 + i / 50),
    );
    expect(suggestThreshold(es)).toBeNull();
    // unscored accepts do not count toward the minimum
    expect(suggestThreshold([...es, entry('accepted', null)])).toBeNull();
  });

  it('suggest separates accepts above 0.9 from rejects near 0.6', () => {
    const es = [
      ...Array.from({ length: 12 }, (_, i) => entry('accepted', i === 0 ? 0.88 : 0.92 + i / 200)),
      ...Array.from({ length: 12 }, (_, i) => entry('rejected', 0.55 + i / 100)),
    ];
    const t = suggestThreshold(es);
    expect(t).toBeGreaterThanOrEqual(0.65);
    expect(t).toBeLessThanOrEqual(0.9);
  });

  it('ties pick the higher threshold', () => {
    // all accepted: every threshold up to the lowest score gives F1 = 1; the highest wins.
    const es = Array.from({ length: 20 }, () => entry('accepted', 0.8));
    expect(suggestThreshold(es)).toBe(0.8);
  });

  it('clear removes jsonl and crops', async () => {
    await appendLedger(dir, entry('accepted', 0.9), jpeg);
    await clearLedger(dir, 'chimney');
    expect(await readLedger(dir, 'chimney')).toEqual([]);
    await expect(stat(join(dir, 'crops', 'chimney'))).rejects.toThrow();
    await expect(stat(join(dir, 'chimney.jsonl'))).rejects.toThrow();
  });

  it('a torn last line is skipped, not fatal', async () => {
    await appendLedger(dir, entry('accepted', 0.9), jpeg);
    await appendFile(
      join(dir, 'chimney.jsonl'),
      '{"detectorId":"chim\nnot json\n{"detectorId":"chim',
    );
    expect(await readLedger(dir, 'chimney')).toHaveLength(1);
  });

  it('an append after a torn last line keeps earlier entries and the new one', async () => {
    const a = entry('accepted', 0.9);
    const b = entry('rejected', 0.3);
    await appendLedger(dir, a, jpeg);
    await appendFile(join(dir, 'chimney.jsonl'), '{"detectorId":"chim');
    await appendLedger(dir, b, jpeg);
    expect(await readLedger(dir, 'chimney')).toEqual([
      { ...a, crop: '1.jpg' },
      { ...b, crop: '2.jpg' },
    ]);
  });
});
