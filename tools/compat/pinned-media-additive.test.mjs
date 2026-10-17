// Pinned media (plan 2026-10-17-pinned-media) is additive, pinned against the 0.11 schema
// (tools/compat/schema-0.11):
// - `pin` on a photo or 360 is optional: 0.11 reads a pinned item and drops it when it saves;
// - `PanoRef.pos` loosens: 0.11 refuses an unplaced 360 (documented in contract-changes).
import { describe, expect, it } from 'vitest';
import * as current from '../../packages/schema/src/index.ts';
import * as v011 from './schema-0.11/index.mjs';

const src = { path: 'panoramas/panos-2026-10-17/p1/pano.jpg' };
const pin = { ground: [1, 0, 2], eyeM: 1.6, headingDeg: 95 };

describe('pinned media is additive', () => {
  it('0.11 reads a pinned 360 and drops pin', () => {
    const item = { id: 'p1', src, pos: [1, 1.6, 2], headingDeg: 95, pin };
    expect(current.PanoRef.safeParse(item).success).toBe(true);
    expect(v011.PanoRef.safeParse(item).data).toEqual({
      id: 'p1',
      src,
      pos: [1, 1.6, 2],
      headingDeg: 95,
    });
  });

  it('0.11 reads a pinned photo and drops pin', () => {
    const item = { id: 'a', src: { path: 'photos/a.jpg' }, pos: [1, 1.6, 2], pin };
    expect(current.PhotoRef.safeParse(item).success).toBe(true);
    expect(v011.PhotoRef.safeParse(item).data).toEqual({
      id: 'a',
      src: item.src,
      pos: [1, 1.6, 2],
    });
  });

  it('0.11 refuses an unplaced 360 (documented in contract-changes)', () => {
    expect(v011.PanoRef.safeParse({ id: 'p1', src }).success).toBe(false);
    expect(current.PanoRef.safeParse({ id: 'p1', src }).success).toBe(true);
  });
});
