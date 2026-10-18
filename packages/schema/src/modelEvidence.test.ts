import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { EngineerRun } from './engineer';
import {
  EVIDENCE_LIMITS,
  ENGINEER_MEASUREMENT_ALGORITHM,
  EvidencePack,
  MODEL_EVIDENCE_MIN_PACK,
  ModelEvidenceParams,
} from './modelEvidence';

function must<T>(x: T | undefined | null): T {
  if (x === undefined || x === null) throw new Error('expected a value');
  return x;
}

const base = { run: 'run-1', clouds: [{ layer: 'cloud-a' }], meshes: [], photos: [] };

describe('ModelEvidenceParams', () => {
  it('uses cloud-supported hardware discovery version 6 for measurement freshness', () => {
    expect(ENGINEER_MEASUREMENT_ALGORITHM).toBe('components/7');
  });
  it('accepts the full photo inventory, drawings and calibrated camera poses', () => {
    const photos = Array.from({ length: 560 }, (_, i) => ({ path: `photos/${String(i)}.jpg` }));
    const p = {
      ...base,
      detail: 'detailed',
      photos,
      drawings: [{ path: 'site.dxf' }],
      cameraPoses: { path: 'cameras.xml' },
    };
    expect(ModelEvidenceParams.safeParse(p).success).toBe(true);
    expect(ModelEvidenceParams.safeParse({ ...p, drawings: [{ path: '' }] }).success).toBe(false);
  });
  it('limits default per detail', () => {
    for (const detail of ['fast', 'standard', 'detailed'] as const) {
      const r = ModelEvidenceParams.safeParse({ ...base, detail });
      expect(r.success).toBe(true);
      expect(must(r.data).limits).toEqual(EVIDENCE_LIMITS[detail]);
    }
    expect(EVIDENCE_LIMITS.fast).toEqual({ maxPoints: 300_000, maxImages: 12, maxPx: 1024 });
    expect(EVIDENCE_LIMITS.standard).toEqual({ maxPoints: 1_000_000, maxImages: 24, maxPx: 1568 });
    expect(EVIDENCE_LIMITS.detailed).toEqual({ maxPoints: 2_000_000, maxImages: 40, maxPx: 1568 });
  });
  it('keeps explicit limits', () => {
    const limits = { maxPoints: 500_000, maxImages: 8, maxPx: 800 };
    const r = ModelEvidenceParams.safeParse({ ...base, detail: 'fast', limits });
    expect(must(r.data).limits).toEqual(limits);
  });
  it('refuses 5 clouds and 2001 photos', () => {
    const clouds = Array.from({ length: 5 }, (_, i) => ({ layer: `c${String(i)}` }));
    expect(ModelEvidenceParams.safeParse({ ...base, clouds, detail: 'fast' }).success).toBe(false);
    const photos = Array.from({ length: 2001 }, (_, i) => ({ path: `p${String(i)}.jpg` }));
    expect(ModelEvidenceParams.safeParse({ ...base, photos, detail: 'fast' }).success).toBe(false);
  });
  it('accepts a circle or box region and refuses unknown keys', () => {
    const circle = { centre: [0, 0], radiusM: 30 };
    const box = { min: [-1, -1, 0], max: [1, 1, 50] };
    for (const region of [circle, box]) {
      expect(ModelEvidenceParams.safeParse({ ...base, region, detail: 'fast' }).success).toBe(true);
    }
    expect(ModelEvidenceParams.safeParse({ ...base, detail: 'fast', extra: 1 }).success).toBe(
      false,
    );
  });
});

const slice = (y: number, coverage: number) => ({
  y,
  centre: [0, 0],
  r: 3 - y * 0.01,
  residualM: 0.02,
  support: 900,
  coverage,
});

const pack = (slices: unknown[]) => ({
  schema: 'aio.evidence/1',
  run: 'run-1',
  crs: { epsg: 32633 },
  units: 'm',
  crop: { centre: [0, 0], radiusM: 20 },
  bounds: { min: [-4, 0, -4], max: [4, 80, 4] },
  samples: { read: 1_200_000, kept: 1_000_000, ground: 40_000 },
  axis: { point: [0, 0, 0], dir: [0, 1, 0], tiltDeg: 0.2 },
  base: [0, 0, 0],
  height: 80,
  slices,
  taper: {
    profile: [
      { y: 0, r: 3 },
      { y: 80, r: 2.2 },
    ],
    residualM: 0.03,
  },
  members: [
    {
      kind: 'flue',
      items: [
        { centre: [0.5, 80, 0], size: 0.4, support: 120, azimuthDeg: 0 },
        { centre: [-0.5, 80, 0], size: 0.4, support: 110, azimuthDeg: 180 },
      ],
      metrics: { residualM: 0.01, regularity: 0.9 },
    },
  ],
  familyHints: { fillRatio: 0.8, slenderness: 13, topFeatures: 2, suggested: 'chimney' },
  colours: [{ y0: 70, y1: 80, rgb: [200, 30, 30] }],
  photos: [],
  images: [
    {
      id: 'img-side-n',
      file: 'img/side-n.png',
      kind: 'side',
      view: 'north',
      w: 1024,
      h: 1024,
      bytes: 123_456,
      sha1: 'a'.repeat(40),
    },
  ],
  reconstruction: 'not-needed',
  warnings: [],
});

describe('EvidencePack', () => {
  it('retains individual dimensions, orientation and per-field provenance in a recorded frame', () => {
    const measured = { basis: 'measured', residualM: 0.012, support: 450, coverage: 0.8 };
    const observation = {
      id: 'obs-panel-12',
      kind: 'panel',
      centre: [1.2, 28.3, -0.4],
      size: [0.51, 2.62, 0.19],
      azimuthDeg: 132,
      tiltDeg: 2,
      quality: {
        centre: measured,
        width: measured,
        height: measured,
        depth: { basis: 'inferred', note: 'Rear face hidden' },
        azimuthDeg: measured,
        tiltDeg: measured,
      },
      sources: [
        { kind: 'cloud', ref: 'cloud-1' },
        { kind: 'drawing', ref: 'drawing-1:ABCD' },
      ],
    };
    const frame = {
      coordinates: 'project-local',
      origin: [265092, 2680453, 0],
      algorithm: 'components/1',
      signature: 'f'.repeat(64),
      sources: [{ layer: 'cloud-1', kind: 'cloud', heightOffsetM: -32.542 }],
    };
    const p = { ...pack([]), observations: [observation], frame };
    expect(EvidencePack.parse(p).observations?.[0]).toEqual(observation);
    expect(EvidencePack.parse(p).frame).toEqual(frame);
    expect(
      EvidencePack.safeParse({ ...p, observations: [{ ...observation, size: [0.5, 2, -0.1] }] })
        .success,
    ).toBe(false);
    expect(EvidencePack.safeParse({ ...p, observations: [observation, observation] }).success).toBe(
      false,
    );
    expect(
      EvidencePack.safeParse({
        ...p,
        observations: [
          {
            ...observation,
            quality: { ...observation.quality, depth: { basis: 'inferred', residualM: 0.01 } },
          },
        ],
      }).success,
    ).toBe(false);
  });
  it('parses a pack with two slices and a flue group', () => {
    const r = EvidencePack.safeParse(pack([slice(10, 0.9), slice(40, 0.7)]));
    expect(r.success).toBe(true);
    const p = must(r.data);
    expect(p.slices).toHaveLength(2);
    expect(must(p.slices[0]).shape).toBe('circle');
    expect(must(p.members[0]).items).toHaveLength(2);
  });
  it('says when photogrammetry is there but was not run, and the run keeps that', () => {
    const p = { ...pack([]), reconstruction: 'available-not-run' };
    expect(EvidencePack.safeParse(p).success).toBe(true);
    expect(EngineerRun.shape.reconstruction.safeParse('available-not-run').success).toBe(true);
    expect(EvidencePack.safeParse({ ...p, reconstruction: 'maybe' }).success).toBe(false);
  });
  it('refuses slice coverage outside 0..1', () => {
    expect(EvidencePack.safeParse(pack([slice(10, 1.2)])).success).toBe(false);
    expect(EvidencePack.safeParse(pack([slice(10, -0.1)])).success).toBe(false);
  });
  it('needs the crop key and accepts null for an uncropped source', () => {
    const noCrop: Record<string, unknown> = pack([]);
    delete noCrop.crop;
    expect(EvidencePack.safeParse(noCrop).success).toBe(false);
    expect(EvidencePack.safeParse({ ...pack([]), crop: null }).success).toBe(true);
  });
  it('bounds run, sha1, dupOf and colour channels', () => {
    const p = pack([]);
    const img = must(p.images[0]);
    expect(EvidencePack.safeParse({ ...p, run: 'x'.repeat(5000) }).success).toBe(false);
    expect(EvidencePack.safeParse({ ...p, crs: { wkt: 'x'.repeat(20_001) } }).success).toBe(false);
    expect(
      EvidencePack.safeParse({ ...p, images: [{ ...img, sha1: 'A'.repeat(40) }] }).success,
    ).toBe(false);
    expect(
      EvidencePack.safeParse({ ...p, colours: [{ y0: 0, y1: 1, rgb: [256, 0, 0] }] }).success,
    ).toBe(false);
    const photo = {
      id: 'b'.repeat(40),
      original: 'photos/a.jpg',
      w: 4000,
      h: 3000,
      orientationApplied: true,
      blur: 0.1,
    };
    expect(EvidencePack.safeParse({ ...p, photos: [photo] }).success).toBe(true);
    expect(
      EvidencePack.safeParse({ ...p, photos: [{ ...photo, dupOf: 'not-an-id' }] }).success,
    ).toBe(false);
  });
  it('takes the additive fields: levels, item residual and coverage, reasons, base, isolation', () => {
    const p = pack([]);
    const group = {
      kind: 'light-candidate',
      items: [{ centre: [1, 40, 2], size: 0.4, support: 60, residualM: 0.01, coverage: 0.5 }],
      levels: [40],
      metrics: {},
    };
    const extra = {
      members: [group],
      familyHints: {
        fillRatio: 1,
        slenderness: 6,
        topFeatures: 3,
        suggested: 'chimney',
        reasons: ['x'],
      },
      baseInfo: { observed: false, basis: 'ground', gapM: 20 },
      isolation: {
        components: 2,
        droppedPoints: 900,
        dropped: [{ points: 900, min: [10, 0, -1], max: [12, 30, 1] }],
      },
      identity: {
        sameAsset: false,
        conflicts: [{ imageIds: ['img-photo-1'], reason: 'other asset' }],
      },
      rejectedSlices: { noFit: 1, radiusJump: 2, offAxis: 0 },
    };
    expect(EvidencePack.safeParse({ ...p, ...extra }).success).toBe(true);
    expect(EvidencePack.safeParse(p).success).toBe(true); // all optional
    const bad = { ...extra, baseInfo: { observed: true, basis: 'sea', gapM: 0 } };
    expect(EvidencePack.safeParse({ ...p, ...bad }).success).toBe(false);
    expect(
      EvidencePack.safeParse({
        ...p,
        members: [{ ...group, items: [{ ...must(group.items[0]), coverage: 2 }] }],
      }).success,
    ).toBe(false);
  });
  it('requires the pack with the engineering measurement repairs', () => {
    expect(MODEL_EVIDENCE_MIN_PACK).toBe('0.13.1');
  });
  it('parses the pack the pipeline wrote for the partial synthetic stack', () => {
    const raw: unknown = JSON.parse(
      readFileSync(
        new URL('./__fixtures__/engineering/evidence.partial-stack.json', import.meta.url),
        'utf8',
      ),
    );
    const r = EvidencePack.safeParse(raw);
    expect(r.success, JSON.stringify(r.error?.issues.slice(0, 3))).toBe(true);
    const p = must(r.data);
    expect(p.members.some((g) => g.kind === 'flue')).toBe(true);
    expect(p.taper?.profile.length).toBeGreaterThan(1);
    expect(p.familyHints?.suggested).toBe('chimney');
    expect(p.photos.length).toBeGreaterThan(0);
    // references hold together: a conflict names pack images, a duplicate names a photo of the pack
    const imageIds = new Set(p.images.map((i) => i.id));
    const photoIds = new Set(p.photos.map((x) => x.id));
    expect(p.identity?.sameAsset).toBe(false);
    for (const c of p.identity?.conflicts ?? []) {
      expect(c.imageIds.length).toBeGreaterThan(0);
      for (const id of c.imageIds) expect(imageIds.has(id)).toBe(true);
    }
    for (const x of p.photos) if (x.dupOf) expect(photoIds.has(x.dupOf)).toBe(true);
  });
});
