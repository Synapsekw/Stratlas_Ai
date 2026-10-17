/**
 * Golden vector runner. The same files run in pytest (python/tests/rf, Task 6), so the TypeScript
 * preview and the Python job cannot drift (spec D16). Every `fixtures/golden/*.json` is read.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { evaluatePoint, type MarginSettings, type RsrpClass, type RsrpThresholds } from './budget';
import type { Tech } from './bands';
import { normalizeDeg180 } from './geometry';
import { makeTwoCutPattern, type AntennaPattern } from './pattern';

type GoldenPattern =
  | {
      kind: 'parametric';
      hBeamwidthDeg: number;
      vBeamwidthDeg: number;
      amDb: number;
      slavDb: number;
    }
  | {
      kind: 'two-cut';
      tiltDeg: number;
      capDb: number;
      horizontalDb: number[];
      verticalDb: number[];
    };

interface GoldenVector {
  id: string;
  covers: string[];
  note: string;
  input: {
    directionGrid: { east: number; north: number; up: number };
    azimuthGridDeg: number;
    convergenceDeg: number;
    mechanicalDowntiltDeg: number;
    eTiltDeg: number | null;
    pattern: string;
    portPowerDbm: number;
    carrier: { tech: Tech; bandwidthMHz: number; scsKHz: number | null };
    feederLossDb: number;
    antennaGainDbi: number;
    pathLossDb: number;
    margins: MarginSettings;
  };
  expected: {
    trueAzimuthDeg: number;
    antennaAzimuthDeg: number;
    antennaDownElevationDeg: number;
    attenuationDb: number;
    perReOffsetDb: number;
    marginDb: number;
    rsrpDbm: number;
    rsrpClass: RsrpClass;
  };
}

interface GoldenFile {
  format: string;
  tolerance: { db: number; deg: number };
  units: Record<string, string>;
  conventions: Record<string, unknown>;
  thresholds: RsrpThresholds;
  patterns: Record<string, GoldenPattern>;
  vectors: GoldenVector[];
}

const dir = new URL('../fixtures/golden/', import.meta.url);
// Every golden file without a `suite` is a pattern-and-budget file; the only other suite is
// `propagation` (propagation.json), which has its own runner (propagation.golden.test.ts).
const all = readdirSync(dir)
  .filter((f) => f.endsWith('.json'))
  .map((f) => ({
    file: f,
    suite: (JSON.parse(readFileSync(new URL(f, dir), 'utf8')) as { suite?: unknown }).suite,
  }));
const files = all.filter((x) => x.suite === undefined).map((x) => x.file);

function toPattern(p: GoldenPattern, eTiltDeg: number | null): AntennaPattern {
  if (p.kind === 'two-cut') return makeTwoCutPattern(p.horizontalDb, p.verticalDb, p.capDb);
  if (eTiltDeg === null) throw new Error('A parametric vector needs eTiltDeg');
  return {
    kind: 'parametric',
    hBeamwidthDeg: p.hBeamwidthDeg,
    vBeamwidthDeg: p.vBeamwidthDeg,
    eTiltDeg,
    amDb: p.amDb,
    slavDb: p.slavDb,
  };
}

describe('golden vectors', () => {
  it('has at least one pattern-and-budget golden file', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it('knows every suite a golden file carries', () => {
    for (const x of all.filter((y) => y.suite !== undefined))
      expect(x.suite, x.file).toBe('propagation');
  });

  for (const file of files) {
    const g = JSON.parse(readFileSync(new URL(file, dir), 'utf8')) as GoldenFile;

    describe(file, () => {
      it('is self-describing: format, tolerance, units and conventions', () => {
        expect(g.format).toBe('aio.rf-golden/1');
        expect(g.tolerance.db).toBeLessThanOrEqual(0.01);
        for (const k of ['frames', 'azimuth', 'tilt', 'antennaFrame', 'pattern', 'budget']) {
          expect(g.conventions[k], k).toBeDefined();
        }
        expect(Object.keys(g.units).length).toBeGreaterThan(0);
        expect(new Set(g.vectors.map((v) => v.id)).size).toBe(g.vectors.length);
      });

      it('covers the cases the plan asks for', () => {
        const covered = new Set(g.vectors.flatMap((v) => v.covers));
        for (const tag of [
          'boresight',
          'h-3db-edge',
          'v-3db-edge',
          'back-lobe',
          'mech-tilt-0',
          'mech-tilt-45',
          'mech-tilt-90',
          'etilt-0',
          'etilt-45',
          'etilt-90',
          'convergence-1.5',
          'two-cut',
          'nr',
        ]) {
          expect(covered.has(tag), tag).toBe(true);
        }
        const classes = new Set(g.vectors.map((v) => v.expected.rsrpClass));
        expect([...classes].sort()).toEqual(['excellent', 'fair', 'good', 'none', 'poor']);
      });

      for (const v of g.vectors) {
        it(`${v.id}: ${v.note}`, () => {
          const p = g.patterns[v.input.pattern];
          if (!p) throw new Error(`unknown pattern ${v.input.pattern}`);
          const { scsKHz } = v.input.carrier;
          const r = evaluatePoint({
            directionGrid: v.input.directionGrid,
            azimuthGridDeg: v.input.azimuthGridDeg,
            convergenceDeg: v.input.convergenceDeg,
            mechanicalDowntiltDeg: v.input.mechanicalDowntiltDeg,
            pattern: toPattern(p, v.input.eTiltDeg),
            portPowerDbm: v.input.portPowerDbm,
            carrier:
              scsKHz === null
                ? { tech: v.input.carrier.tech, bandwidthMHz: v.input.carrier.bandwidthMHz }
                : {
                    tech: v.input.carrier.tech,
                    bandwidthMHz: v.input.carrier.bandwidthMHz,
                    scsKHz,
                  },
            feederLossDb: v.input.feederLossDb,
            antennaGainDbi: v.input.antennaGainDbi,
            pathLossDb: v.input.pathLossDb,
            margins: v.input.margins,
            thresholds: g.thresholds,
          });
          const e = v.expected;
          const deg = g.tolerance.deg;
          const db = g.tolerance.db;
          expect(
            Math.abs(normalizeDeg180(r.trueAzimuthDeg - e.trueAzimuthDeg)),
          ).toBeLessThanOrEqual(deg);
          expect(
            Math.abs(normalizeDeg180(r.antennaAzimuthDeg - e.antennaAzimuthDeg)),
          ).toBeLessThanOrEqual(deg);
          expect(
            Math.abs(r.antennaDownElevationDeg - e.antennaDownElevationDeg),
          ).toBeLessThanOrEqual(deg);
          expect(Math.abs(r.attenuationDb - e.attenuationDb)).toBeLessThanOrEqual(db);
          expect(Math.abs(r.perReOffsetDb - e.perReOffsetDb)).toBeLessThanOrEqual(db);
          expect(Math.abs(r.marginDb - e.marginDb)).toBeLessThanOrEqual(db);
          expect(Math.abs(r.rsrpDbm - e.rsrpDbm)).toBeLessThanOrEqual(db);
          expect(r.rsrpClass).toBe(e.rsrpClass);
        });
      }
    });
  }
});
