/**
 * Path-loss golden vectors (`fixtures/golden/propagation.json`, written by `gen_propagation.py`).
 * The Python `rf.coverage` job (Task 6) runs the same file, so the TypeScript preview and the
 * Python path-loss cache cannot drift (spec D16).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { RfEnvironment } from '@aio/schema';
import {
  PathLossRefusalError,
  cost231HataDb,
  freeSpacePathLossDb,
  okumuraHataDb,
  pathLossDb,
  pathLossRefusal,
  rma38901,
  uma38901,
  umi38901,
  type HataArea,
  type PropagationModelId,
} from './propagation';

interface Vector {
  id: string;
  covers: string[];
  input: {
    model: PropagationModelId;
    environment: RfEnvironment;
    hataArea: HataArea | null;
    frequencyMHz: number;
    d2DM: number;
    hBsM: number;
    hUtM: number;
  };
  expected:
    | {
        refused: false;
        pathLossDb: number;
        losDb: number | null;
        nlosDb: number | null;
        pLos: number | null;
        breakpointM: number | null;
      }
    | { refused: true; code: 'frequency' | 'height'; rangeMHz: [number, number] | null };
}

interface File {
  format: string;
  suite: string;
  tolerance: { db: number; probability: number; m: number };
  units: Record<string, string>;
  conventions: Record<string, unknown>;
  vectors: Vector[];
}

const g = JSON.parse(
  readFileSync(new URL('../fixtures/golden/propagation.json', import.meta.url), 'utf8'),
) as File;

const tr = { uma: uma38901, umi: umi38901, rma: rma38901 } as const;

describe('propagation golden vectors', () => {
  it('is self-describing and covers every model, band and distance asked for', () => {
    expect(g.format).toBe('aio.rf-golden/1');
    expect(g.suite).toBe('propagation');
    expect(g.tolerance.db).toBeLessThanOrEqual(0.01);
    for (const k of [
      'distance',
      'heights',
      'tr38901',
      'losProbability',
      'expected',
      'hata',
      'freeSpace',
    ])
      expect(g.conventions[k], k).toBeDefined();
    expect(new Set(g.vectors.map((v) => v.id)).size).toBe(g.vectors.length);
    const covered = new Set(g.vectors.flatMap((v) => v.covers));
    for (const tag of [
      'uma',
      'umi',
      'rma',
      'okumura-hata',
      'cost231-hata',
      'free-space',
      'f-760',
      'f-1840',
      'f-2600',
      'f-3500',
      'd-50',
      'd-10000',
      'los-pl1',
      'los-pl2',
      'nlos-floor-los',
      'uma-c-prime',
      'free-space-floor',
      'refused-frequency',
      'refused-height',
    ])
      expect(covered.has(tag), tag).toBe(true);
  });

  for (const v of g.vectors) {
    it(v.id, () => {
      const i = v.input;
      const setup = {
        model: i.model,
        environment: i.environment,
        frequencyMHz: i.frequencyMHz,
        hBsM: i.hBsM,
        hUtM: i.hUtM,
        ...(i.hataArea === null ? {} : { hataArea: i.hataArea }),
      };
      const e = v.expected;
      if (e.refused) {
        expect(pathLossRefusal(setup)).toMatchObject({ code: e.code });
        if (e.rangeMHz) expect(pathLossRefusal(setup)?.rangeMHz).toEqual(e.rangeMHz);
        expect(() => pathLossDb(setup, i.d2DM)).toThrow(PathLossRefusalError);
        return;
      }
      const db = g.tolerance.db;
      expect(Math.abs(pathLossDb(setup, i.d2DM) - e.pathLossDb)).toBeLessThanOrEqual(db);
      if (i.model === 'tr38901') {
        const r = tr[i.environment](i.frequencyMHz, i.d2DM, i.hBsM, i.hUtM);
        expect(Math.abs(r.losDb - (e.losDb ?? Number.NaN))).toBeLessThanOrEqual(db);
        expect(Math.abs(r.nlosDb - (e.nlosDb ?? Number.NaN))).toBeLessThanOrEqual(db);
        expect(Math.abs(r.pLos - (e.pLos ?? Number.NaN))).toBeLessThanOrEqual(
          g.tolerance.probability,
        );
        expect(Math.abs(r.breakpointM - (e.breakpointM ?? Number.NaN))).toBeLessThanOrEqual(
          g.tolerance.m,
        );
      } else if (i.model === 'okumura-hata' && i.hataArea) {
        expect(
          Math.abs(
            okumuraHataDb(i.frequencyMHz, i.d2DM, i.hBsM, i.hUtM, i.hataArea) - e.pathLossDb,
          ),
        ).toBeLessThanOrEqual(db);
      } else if (i.model === 'cost231-hata' && i.hataArea) {
        expect(
          Math.abs(
            cost231HataDb(i.frequencyMHz, i.d2DM, i.hBsM, i.hUtM, i.hataArea) - e.pathLossDb,
          ),
        ).toBeLessThanOrEqual(db);
      } else if (i.model === 'free-space') {
        const d3 = Math.hypot(Math.max(i.d2DM, 10), i.hBsM - i.hUtM);
        expect(
          Math.abs(freeSpacePathLossDb(i.frequencyMHz, d3) - e.pathLossDb),
        ).toBeLessThanOrEqual(db);
      }
    });
  }
});
