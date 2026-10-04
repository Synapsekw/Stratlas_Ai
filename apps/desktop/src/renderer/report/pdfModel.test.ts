import { describe, expect, it } from 'vitest';
import {
  clampPage,
  fitWidthScale,
  nearbyPages,
  nextZoom,
  pageAtOffset,
  searchPages,
} from './pdfModel';

describe('pdf viewer model', () => {
  it('fits a page to the container width with a margin', () => {
    expect(fitWidthScale(612, 1256, 32)).toBeCloseTo(2, 5);
    expect(fitWidthScale(612, 0, 32)).toBe(1);
  });

  it('keeps page numbers in range', () => {
    expect(clampPage(0, 88)).toBe(1);
    expect(clampPage(90, 88)).toBe(88);
    expect(clampPage(Number.NaN, 88)).toBe(1);
    expect(clampPage(12.6, 88)).toBe(13);
  });

  it('steps zoom through fixed levels', () => {
    expect(nextZoom(1, 1)).toBe(1.25);
    expect(nextZoom(1, -1)).toBe(0.75);
    expect(nextZoom(1.1, 1)).toBe(1.25);
    expect(nextZoom(1.1, -1)).toBe(1);
    expect(nextZoom(4, 1)).toBe(4);
    expect(nextZoom(0.25, -1)).toBe(0.25);
  });

  it('renders only pages near the viewport', () => {
    expect(nearbyPages(10, 206, 2)).toEqual([8, 9, 10, 11, 12]);
    expect(nearbyPages(1, 3, 2)).toEqual([1, 2, 3]);
  });

  it('finds the page under a scroll offset', () => {
    const tops = [0, 1000, 2000, 3000];
    expect(pageAtOffset(tops, 0)).toBe(1);
    expect(pageAtOffset(tops, 1500)).toBe(2);
    expect(pageAtOffset(tops, 9999)).toBe(4);
  });

  it('searches page texts case-insensitively with a snippet', () => {
    const hits = searchPages(['Intro', 'A crack in the plate. Another CRACK.', 'none'], 'crack');
    expect(hits).toEqual([{ page: 2, count: 2, snippet: 'A crack in the plate. Another CRACK.' }]);
    expect(searchPages(['x'], ' ')).toEqual([]);
  });
});
