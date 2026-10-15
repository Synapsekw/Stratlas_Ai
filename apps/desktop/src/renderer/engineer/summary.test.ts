import type { EngineerSetup, EvidencePack } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { measurementSummary, spread, SUMMARY_MAX_ITEMS } from './summary';

const SETUP: EngineerSetup = {
  sources: { clouds: [{ layer: 'cloud-1' }], meshes: [], photos: [{ path: 'C:/private/one.jpg' }] },
  family: 'auto',
  scope: 'asset',
  detail: 'standard',
  reference: { what: 'height', valueM: 60.123456 },
  placement: 'from-source',
};

function pack(): EvidencePack {
  return {
    schema: 'aio.evidence/1',
    run: 'run-1',
    crs: { epsg: 32639 },
    units: 'm',
    crop: null,
    bounds: { min: [-6.123456, 0, -6], max: [6, 60.000049, 6] },
    samples: { read: 2_000_000, kept: 1_000_000, ground: 50_000 },
    axis: { point: [0.1, 0, 0.2], dir: [0.0012345, 0.9999, 0], tiltDeg: 0.123456 },
    base: [0.1234567, 0, -0.7654321],
    height: 60.0004,
    slices: Array.from({ length: 200 }, (_, i) => ({
      y: i * 0.3,
      centre: [0, 0] as [number, number],
      r: 5 - i * 0.01,
      residualM: 0.0123456,
      support: 300,
      coverage: 0.81234,
      shape: 'circle' as const,
    })),
    taper: {
      profile: Array.from({ length: 64 }, (_, i) => ({ y: i, r: 5 - i * 0.02 })),
      residualM: 0.03,
    },
    members: [
      {
        kind: 'light-candidate',
        items: Array.from({ length: 100 }, (_, i) => ({
          centre: [i, 30, 0] as [number, number, number],
          size: 0.4,
          support: 20,
        })),
        levels: [20, 40],
        metrics: { residualM: 0.05 },
      },
    ],
    familyHints: { fillRatio: 0.4, slenderness: 6.666666, topFeatures: 3, suggested: 'chimney' },
    colours: Array.from({ length: 40 }, (_, i) => ({
      y0: i,
      y1: i + 1,
      rgb: [200.4, 100.6, 50] as [number, number, number],
    })),
    photos: Array.from({ length: 30 }, (_, i) => ({
      id: i.toString(16).padStart(40, '0'),
      original: `C:/private/photos/IMG_${String(i)}.jpg`,
      w: 4000,
      h: 3000,
      orientationApplied: true,
      blur: 100,
      ...(i % 10 === 0 && i > 0 ? { dupOf: '0'.repeat(40) } : {}),
    })),
    images: Array.from({ length: 40 }, (_, i) => ({
      id: `img-${String(i)}`,
      file: `img/${String(i)}.png`,
      kind: 'side' as const,
      view: `v${String(i)}`,
      w: 512,
      h: 512,
      bytes: 100,
      sha1: '0'.repeat(40),
    })),
    reconstruction: 'not-needed',
    warnings: Array.from({ length: 30 }, (_, i) => `warning ${String(i)}`),
  };
}

/** Every array in a JSON value, with where it is. */
function arrays(v: unknown, path = '$', out: { path: string; n: number }[] = []) {
  if (Array.isArray(v)) {
    out.push({ path, n: v.length });
    v.forEach((x, i) => arrays(x, `${path}[${String(i)}]`, out));
  } else if (v && typeof v === 'object')
    for (const [k, x] of Object.entries(v)) arrays(x, `${path}.${k}`, out);
  return out;
}

describe('measurementSummary', () => {
  it('is compact JSON: rounded numbers, no list over 16 items, no paths', () => {
    const text = measurementSummary(pack(), SETUP);
    const s = JSON.parse(text) as Record<string, unknown> & {
      height: number;
      base: number[];
      slices: { count: number; items: { y: number }[] };
      taper: { profile: { y: number }[] };
      members: { count: number; items: unknown[]; levels: number[] }[];
      photos: { count: number; duplicates: number };
      setup: { reference: { valueM: number } };
    };
    expect(arrays(s).filter((a) => a.n > SUMMARY_MAX_ITEMS)).toEqual([]);
    expect(s.height).toBe(60);
    expect(s.base).toEqual([0.123, 0, -0.765]);
    expect(s.setup.reference.valueM).toBe(60.123);
    expect(s.slices.count).toBe(200);
    // the ends of a profile are kept
    expect(s.taper.profile[0]?.y).toBe(0);
    expect(s.taper.profile.at(-1)?.y).toBe(63);
    expect(s.members[0]?.count).toBe(100);
    expect(s.photos).toEqual({ count: 30, duplicates: 2 });
    expect(text).not.toMatch(/private|IMG_|\.jpg|img\/|cloud-1/);
    expect(text.length).toBeLessThan(40_000);
    // deterministic, so the AI cache key holds on a reopen
    expect(measurementSummary(pack(), SETUP)).toBe(text);
  });

  it('says there is no evidence when there is none', () => {
    expect(JSON.parse(measurementSummary(null, SETUP))).toMatchObject({ evidence: null });
  });
});

describe('spread', () => {
  it('keeps short lists and spreads long ones evenly, ends included', () => {
    expect(spread([1, 2, 3], 16)).toEqual([1, 2, 3]);
    const s = spread(
      Array.from({ length: 100 }, (_, i) => i),
      5,
    );
    expect(s).toEqual([0, 25, 50, 74, 99]);
  });
});
