import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { panoFrameMeta, readPanoFrameMeta } from './panoScan';
import { withExif } from './testing';

let dir = '';
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pano-scan-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 5 });
});

describe('readPanoFrameMeta', () => {
  it('reads time, position, altitudes and gimbal angles of a DJI frame', async () => {
    const file = join(dir, 'SYN_0001.JPG');
    const bytes = withExif({
      make: 'DJI',
      dateTimeOriginal: '2026:09:10 10:00:06',
      width: 5472,
      height: 3648,
      dji: {
        GpsLatitude: '46.5',
        GpsLongitude: '7.5',
        AbsoluteAltitude: '+620.5',
        RelativeAltitude: '+70.2',
        GimbalYawDegree: '-45.1',
        GimbalPitchDegree: '-35.0',
        GimbalRollDegree: '0.0',
      },
    });
    await writeFile(file, bytes);
    expect(await readPanoFrameMeta(file)).toEqual({
      file,
      bytes: bytes.length,
      takenAt: '2026-09-10T10:00:06',
      lat: 46.5,
      lon: 7.5,
      absAlt: 620.5,
      relAlt: 70.2,
      gimbal: { yaw: -45.1, pitch: -35, roll: 0 },
      width: 5472,
      height: 3648,
    });
  });

  it('marks a file that is not a JPEG as unreadable', async () => {
    const file = join(dir, 'notes.jpg');
    await writeFile(file, 'hello');
    expect(await readPanoFrameMeta(file)).toEqual({ file, bytes: 5, unreadable: true });
  });

  it('falls back to EXIF GPS and flags GPano', () => {
    const m = panoFrameMeta('x.jpg', 10, {
      gps: { lat: 1, lon: 2, alt: 30 },
      gpano: { projection: 'equirectangular' },
      width: 8000,
      height: 4000,
    });
    expect(m).toEqual({
      file: 'x.jpg',
      bytes: 10,
      lat: 1,
      lon: 2,
      absAlt: 30,
      gpano: true,
      width: 8000,
      height: 4000,
    });
  });
});
