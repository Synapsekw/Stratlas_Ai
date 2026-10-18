import type { HeightTiles } from '@aio/schema';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { compareItem } from './compare';
import { projectResolver, ringShifts } from './resolver';

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

describe('ringShifts', () => {
  const surfaces: HeightTiles[] = [
    { ...cone, capture: 'c2', dateShiftM: { eastM: 2, northM: -1 } },
  ];
  it('takes the prepared shift to sample with and the shift now for the fingerprint', () => {
    expect(ringShifts(surfaces, { c2: [3.5, 0.5] }, 'c2')).toEqual({
      ringShift: [2, -1],
      ringCurrent: [3.5, 0.5],
    });
  });
  it('uses the shift now for a surface prepared before any line-up, and none for a site ring', () => {
    const plain: HeightTiles[] = [{ ...cone, capture: 'c2' }];
    expect(ringShifts(plain, { c2: [3, 0] }, 'c2')).toEqual({
      ringShift: [3, 0],
      ringCurrent: [3, 0],
    });
    expect(ringShifts(surfaces, { c2: [3, 0] }, undefined)).toEqual({});
  });
  it('ring shifts follows a turned line-up: the prepared turn to sample with, the turn now for the fingerprint', async () => {
    const turn = { rotationDeg: 0.5, scale: 1, pivotE: 500000, pivotN: 3200000 };
    const now = { ...turn, rotationDeg: 0.25 };
    const turned: HeightTiles[] = [
      { ...cone, capture: 'c2', dateShiftM: { eastM: 2, northM: -1 }, dateTurn: turn },
    ];
    expect(ringShifts(turned, { c2: [3.5, 0.5] }, 'c2', { c2: now })).toEqual({
      ringShift: [2, -1],
      ringCurrent: [3.5, 0.5],
      ringTurn: turn,
      ringCurrentTurn: now,
    });
    // prepared before the turn: no prepared turn, the turn now still reads stale
    expect(ringShifts(surfaces, { c2: [3.5, 0.5] }, 'c2', { c2: now })).toEqual({
      ringShift: [2, -1],
      ringCurrent: [3.5, 0.5],
      ringCurrentTurn: now,
    });
    const resolve = projectResolver({
      surfaces: turned,
      captures: ['c2'],
      shifts: { c2: [3.5, 0.5] },
      turns: { c2: now },
      fetchBytes: () => Promise.resolve(null),
    });
    expect((await resolve({ kind: 'current' })).currentTurn).toEqual(now);
  });
  it('puts the date shift now on the surfaces it resolves', async () => {
    const resolve = projectResolver({
      surfaces,
      captures: ['c2'],
      shifts: { c2: [3.5, 0.5] },
      fetchBytes: () => Promise.resolve(null),
    });
    expect((await resolve({ kind: 'current' })).current).toEqual([3.5, 0.5]);
  });
});
