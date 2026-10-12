import { describe, expect, it } from 'vitest';
import { rawCameraImported } from './rawCamera';

describe('rawCameraImported', () => {
  it('is true when a camera file was imported', () => {
    expect(
      rawCameraImported([
        { file: 'LRV_20260101_120000_01_001.lrv', status: 'skipped' },
        { file: 'VID_20260101_120000_00_001.insv', status: 'imported' },
      ]),
    ).toBe(true);
    expect(rawCameraImported([{ file: 'clip.LRV', status: 'imported' }])).toBe(true);
  });

  it('is false for a stitched MP4, a camera file that did not land, or nothing', () => {
    expect(rawCameraImported([{ file: 'Site tour.mp4', status: 'imported' }])).toBe(false);
    expect(rawCameraImported([{ file: 'VID_1.insv', status: 'skipped' }])).toBe(false);
    expect(rawCameraImported([{ file: 'VID_1.insv', status: 'failed' }])).toBe(false);
    expect(rawCameraImported([])).toBe(false);
  });
});
