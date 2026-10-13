// packages/geo/src/walk/preview.test.ts
import type { WalkRawPath } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { loadRaw, truthXZ } from '../__fixtures__/walk';
import {
  GHOST_FALLBACK_M,
  ghostLengthM,
  ghostPath,
  outlineAt,
  previewPath,
  walkOutline,
} from './preview';
import type { XZ } from './horizontal';

const dist = (a: XZ, b: XZ) => Math.hypot(a[0] - b[0], a[1] - b[1]);
/** Distance of p from the line through a and b. */
const offChord = (p: XZ, a: XZ, b: XZ) => {
  const dx = b[0] - a[0];
  const dz = b[1] - a[1];
  return Math.abs(dx * (p[1] - a[1]) - dz * (p[0] - a[0])) / Math.hypot(dx, dz);
};

describe('walkOutline', () => {
  it('is null without a raw path or for a pins-only one', () => {
    expect(walkOutline(null)).toBeNull();
    const raw = loadRaw('synthetic');
    expect(walkOutline({ ...raw, source: 'pins-only' })).toBeNull();
  });

  it('keeps the registered stills inside the walking part, sorted by time', () => {
    const o = walkOutline(loadRaw('synthetic'));
    expect(o).not.toBeNull();
    expect(o?.t[0]).toBeGreaterThanOrEqual(4);
    expect(o?.t.at(-1)).toBeLessThanOrEqual(62);
    expect(o?.xz.length).toBe(o?.t.length);
  });

  it('keeps one reconstruction of a broken path: the one with the most stills', () => {
    const o = walkOutline(loadRaw('broken'));
    expect(o).not.toBeNull();
    // segment 0 runs 4 s to 30 s, segment 1 38 s to 62 s: one of them only, never both
    const before = o?.t.filter((t) => t < 30).length ?? 0;
    const after = o?.t.filter((t) => t > 38).length ?? 0;
    expect(before === 0 || after === 0).toBe(true);
  });
});

describe('previewPath', () => {
  const raw = loadRaw('synthetic');
  const o = walkOutline(raw);
  if (!o) throw new Error('no outline');

  it('lays the shape between start and cursor: the corner lands on the truth', () => {
    const start = truthXZ(raw, 4);
    const end = truthXZ(raw, 62);
    const pts = previewPath(o, 4, 62, start, end);
    expect(pts).not.toBeNull();
    const i = o.t.findIndex((t) => t >= 37);
    const p = pts?.[i];
    if (!p) throw new Error('no corner point');
    expect(dist(p, truthXZ(raw, o.t[i] ?? 37))).toBeLessThan(0.05);
    // an L, not a straight line: the corner lies 24 m off the start to end chord
    expect(offChord(p, start, end)).toBeGreaterThan(20);
  });

  it('turns and scales with the cursor', () => {
    const pts = previewPath(o, 4, 62, [0, 0], [0, -100]);
    expect(pts?.[0]?.[0]).toBeCloseTo(0, 6);
    expect(pts?.[0]?.[1]).toBeCloseTo(0, 6);
    const last = pts?.at(-1);
    if (!last) throw new Error('no end');
    expect(dist(last, [0, -100])).toBeLessThan(0.5);
  });

  it('is null when the outline does not move between its anchors', () => {
    const still: WalkRawPath = {
      ...raw,
      stills: raw.stills.map((s) => ({ ...s, pos: [1, 0, 1] as [number, number, number] })),
    };
    const flat = walkOutline(still);
    expect(flat === null || previewPath(flat, 4, 62, [0, 0], [10, 0]) === null).toBe(true);
  });

  it('stays finite on a broken path', () => {
    const b = walkOutline(loadRaw('broken'));
    if (!b) throw new Error('no outline');
    const pts = previewPath(b, 4, 62, [0, 0], [40, -30]);
    expect(pts?.every((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]))).toBe(true);
  });

  it('outlineAt clamps to the ends', () => {
    expect(outlineAt(o, -10)).toEqual(o.xz[0]);
    expect(outlineAt(o, 1e9)).toEqual(o.xz.at(-1));
  });
});

describe('ghostPath', () => {
  const o = walkOutline(loadRaw('synthetic'));
  if (!o) throw new Error('no outline');

  it('puts the first point under the cursor at about 0.7 m a step', () => {
    const length = ghostLengthM(o);
    const steps = (o.steps.at(-1) ?? 0) - (o.steps[0] ?? 0);
    expect(length).toBeCloseTo(0.7 * steps, 6);
    const pts = ghostPath(o, [5, 6], length);
    expect(pts?.[0]).toEqual([5, 6]);
    let walked = 0;
    for (let i = 1; i < (pts?.length ?? 0); i++) {
      const a = pts?.[i - 1];
      const b = pts?.[i];
      if (a && b) walked += dist(a, b);
    }
    expect(walked).toBeCloseTo(length, 3);
  });

  it('falls back to a fixed length when the path counts no steps', () => {
    expect(ghostLengthM({ ...o, steps: o.steps.map(() => 0) })).toBe(GHOST_FALLBACK_M);
  });

  it('is null for a length that is not positive', () => {
    expect(ghostPath(o, [0, 0], 0)).toBeNull();
  });
});
