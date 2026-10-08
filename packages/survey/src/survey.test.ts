import { describe, expect, it } from 'vitest';
import { SURVEY_ENGINE_VERSION, signedVolumeTotals } from './index';

describe('@aio/survey public API (G0)', () => {
  it('gives net as fill minus cut and total as fill plus cut', () => {
    expect(signedVolumeTotals(120.5, 80)).toEqual({
      cut: 120.5,
      fill: 80,
      net: -40.5,
      total: 200.5,
    });
    expect(signedVolumeTotals(0, 12)).toEqual({ cut: 0, fill: 12, net: 12, total: 12 });
    expect(signedVolumeTotals(0, 0)).toEqual({ cut: 0, fill: 0, net: 0, total: 0 });
  });

  it('refuses a negative or non-finite cut or fill', () => {
    expect(() => signedVolumeTotals(-1, 5)).toThrow(RangeError);
    expect(() => signedVolumeTotals(1, Number.NaN)).toThrow(/fill must be a finite volume/);
    expect(() => signedVolumeTotals(Number.POSITIVE_INFINITY, 0)).toThrow(/cut/);
  });

  it('has an engine version for result fingerprints', () => {
    expect(Number.isInteger(SURVEY_ENGINE_VERSION)).toBe(true);
    expect(SURVEY_ENGINE_VERSION).toBeGreaterThan(0);
  });
});
