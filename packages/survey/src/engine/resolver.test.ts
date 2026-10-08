import type { HeightTiles } from '@aio/schema';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { compareItem } from './compare';
import { projectResolver } from './resolver';

const DIR = join(
  fileURLToPath(new URL('.', import.meta.url)),
  '..',
  '..',
  '..',
  'schema',
  'src',
  '__fixtures__',
  'survey',
);
const cone = JSON.parse(
  readFileSync(join(DIR, 'tiles', 'cone', 'tiles.json'), 'utf8'),
) as HeightTiles;
const ring: [number, number][] = Array.from({ length: 24 }, (_, k) => [
  302010 + 8 * Math.cos((2 * Math.PI * k) / 24),
  2574010 + 8 * Math.sin((2 * Math.PI * k) / 24),
]);

describe('projectResolver', () => {
  const fetched: string[] = [];
  const fetchBytes = (path: string) => {
    fetched.push(path);
    const m = /^survey\/surfaces\/cone\/(.+)$/.exec(path);
    return Promise.resolve(
      m?.[1] ? new Uint8Array(readFileSync(join(DIR, 'tiles', 'cone', m[1]))) : null,
    );
  };
  const flat = { ...cone, id: 'flat', capture: 'c1', fingerprint: 'fp-flat-prepared' };
  const resolve = projectResolver({
    surfaces: [{ ...cone, capture: 'c2' }, flat],
    captures: ['c1', 'c2'],
    fetchBytes,
  });

  it('reads prepared tiles and gives the fixture volume', async () => {
    const r = await compareItem(
      ring,
      {
        id: 'a',
        from: { kind: 'reference', mode: 'level', levelM: 100 },
        to: { kind: 'survey', surface: 'cone' },
        useDeadband: false,
      },
      resolve,
    );
    const cases = JSON.parse(readFileSync(join(DIR, 'cases.json'), 'utf8')) as {
      cases: { id: string; expected: { fillM3: number } }[];
    };
    const want = cases.cases.find((c) => c.id === 'cone-over-flat')?.expected.fillM3 ?? 0;
    expect(r.fillM3).toBeCloseTo(want, 9);
    expect(fetched).toEqual(['survey/surfaces/cone/0/0_0.bin']);
  });

  it('resolves current and previous through the captures', async () => {
    const cur = await resolve({ kind: 'current' });
    const prev = await resolve({ kind: 'previous' });
    expect([cur.capture, cur.fingerprint, prev.capture, prev.fingerprint]).toEqual([
      'c2',
      cone.fingerprint,
      'c1',
      'fp-flat-prepared',
    ]);
    const first = projectResolver({
      surfaces: [flat],
      captures: ['c1', 'c2'],
      capture: 'c1',
      fetchBytes,
    });
    await expect(first({ kind: 'previous' })).rejects.toThrow('There is no previous survey');
    await expect(resolve({ kind: 'survey', surface: 'nope' })).rejects.toThrow('not prepared');
  });
});
