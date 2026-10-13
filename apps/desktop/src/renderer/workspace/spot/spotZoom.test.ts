import { describe, expect, it } from 'vitest';
import { clampView, createZoomLink, FIT, panBy, viewCss, zoomAt } from './spotZoom';

describe('linked zoom and pan', () => {
  it('zooms about the box centre', () => {
    expect(zoomAt(FIT, 2, 0, 0)).toEqual({ s: 2, x: 0, y: 0 });
  });
  it('keeps the point under the pointer still', () => {
    const v = zoomAt(FIT, 2, 0.25, 0);
    expect(v).toEqual({ s: 2, x: -0.25, y: 0 });
    // the picture point that was at 0.25 (content 0.25) is still at 0.25
    expect(v.x + v.s * 0.25).toBeCloseTo(0.25);
  });
  it('stops at fit and at eight times', () => {
    expect(zoomAt({ s: 2, x: -0.25, y: 0 }, 0.25, 0, 0)).toEqual(FIT);
    expect(zoomAt(FIT, 100, 0, 0).s).toBe(8);
  });
  it('pans only while zoomed, never past the picture edge', () => {
    expect(panBy(FIT, 0.3, 0)).toEqual(FIT);
    expect(panBy({ s: 2, x: 0, y: 0 }, 1, -1)).toEqual({ s: 2, x: 0.5, y: -0.5 });
    expect(clampView({ s: 3, x: 2, y: -0.2 })).toEqual({ s: 3, x: 1, y: -0.2 });
  });
  it('writes one CSS transform for both sides', () => {
    expect(viewCss({ s: 2, x: -0.25, y: 0 })).toBe('translate(-25%, 0%) scale(2)');
  });
  it('shares one view between two subscribers', () => {
    const link = createZoomLink();
    const seen: number[] = [];
    link.subscribe((st) => seen.push(st.view.s));
    link.getState().set(zoomAt(FIT, 1.25, 0, 0));
    expect(link.getState().view.s).toBe(1.25);
    expect(seen).toEqual([1.25]);
  });
});
