import { HeightTiles } from '@aio/schema';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createSectionEngine } from './sectionEngine';

const DIR = join(
  import.meta.dirname,
  '..',
  '..',
  '..',
  '..',
  '..',
  'packages',
  'schema',
  'src',
  '__fixtures__',
  'survey',
  'tiles',
  'cone',
);

describe('the section engine (worker and main thread)', () => {
  it('reads prepared tiles through project URLs and samples sections and pins', async () => {
    const meta = HeightTiles.parse(JSON.parse(readFileSync(join(DIR, 'tiles.json'), 'utf8')));
    const asked: string[] = [];
    const engine = createSectionEngine((url) => {
      asked.push(url);
      const rel = url.replace('aio://project/p/', '');
      if (rel === `survey/surfaces/${meta.id}/0/0_0.bin`)
        return Promise.resolve(new Uint8Array(readFileSync(join(DIR, '0', '0_0.bin'))));
      return Promise.resolve(null);
    });
    await engine.setSources({
      base: 'aio://project/p/',
      surfaces: [meta],
      designs: [],
      captures: [],
    });
    const e0 = meta.originE;
    const n0 = meta.originN;
    const line: [number, number][] = [
      [e0 + 2, n0 + 10],
      [e0 + 18, n0 + 10],
    ];
    const refs = [
      { kind: 'survey' as const, surface: meta.id },
      { kind: 'design' as const, design: 'none', layer: 'x' },
    ];
    const r = await engine.section({ line, refs });
    expect(r.stepM).toBe(meta.cellM / 2);
    expect(r.length).toBeCloseTo(16, 9);
    expect(r.profiles).toHaveLength(1);
    expect(r.missing[0]?.reason).toContain('not in the designs list');
    // the cone (centre 10, 10, radius 7, height 4 over 100 m) at its centre
    const mid = r.profiles[0]?.z[Math.round((r.chainage.length - 1) / 2)] ?? 0;
    expect(mid).toBeGreaterThan(103);
    const pin = await engine.pin({ line, refs, chainage: 8, reference: 0 });
    expect(pin.values[0]?.z).toBeCloseTo(mid, 6);
    expect(asked.every((u) => u.startsWith('aio://project/p/survey/surfaces/'))).toBe(true);
  });
});
