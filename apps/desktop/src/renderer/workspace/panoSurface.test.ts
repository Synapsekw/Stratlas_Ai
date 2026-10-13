// @vitest-environment jsdom
import type { PanoCoverage } from '@aio/engine';
import { describe, expect, it, vi } from 'vitest';

vi.mock('./panoView', () => ({ createPanoImageView: vi.fn() }));

import { panoFrame } from './panoSurface';

const file = new Map<string, PanoCoverage>([['a', { hspanDeg: 120, vtopDeg: 30, vbotDeg: 20 }]]);

describe('panoFrame', () => {
  it('prefers the item cov, a wide one included, and centres it on its yaw range', () => {
    const f = panoFrame(
      { id: 'a', headingDeg: 10, cov: { top: 40, bottom: 50, left: -90, right: 60 } },
      file,
    );
    expect(f.cov).toEqual({ hspanDeg: 150, vtopDeg: 40, vbotDeg: 50 });
    expect(f.headingDeg).toBe(10 + (-90 + 60) / 2);
  });

  it('takes a full-width item cov as the whole circle', () => {
    expect(panoFrame({ id: 'a', headingDeg: 5, cov: { top: 90, bottom: 90 } }, file)).toEqual({
      headingDeg: 5,
      cov: { hspanDeg: 360, vtopDeg: 90, vbotDeg: 90 },
    });
  });

  it('falls back to panoramas.json, then to nothing, for old projects', () => {
    expect(panoFrame({ id: 'a', headingDeg: 7 }, file)).toEqual({
      headingDeg: 7,
      cov: file.get('a'),
    });
    expect(panoFrame({ id: 'z', headingDeg: 7 }, file)).toEqual({ headingDeg: 7, cov: null });
  });
});
