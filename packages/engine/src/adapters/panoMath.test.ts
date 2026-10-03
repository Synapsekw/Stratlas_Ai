import { describe, expect, it } from 'vitest';
import {
  FULL_SPHERE,
  PANO_FOV,
  azElToDir,
  coverageFromImage,
  coverageLabel,
  dirToAzEl,
  dragLook,
  panoUv,
  parsePanoIndex,
  startLook,
  zoomLook,
} from './panoMath';

const close = (a: readonly number[] | null, b: readonly number[], digits = 9) => {
  expect(a).not.toBeNull();
  b.forEach((v, i) => {
    expect(a?.[i]).toBeCloseTo(v, digits);
  });
};

describe('panorama maths', () => {
  it('reads partial coverage from panoramas.json and defaults the rest', () => {
    const m = parsePanoIndex({
      schema: 'aio.panoramas/1',
      panoramas: [
        { id: 'w', hspanDeg: 210, vtopDeg: 45, vbotDeg: 43.8 },
        { id: 's', kind: 'equirectangular-360' },
        { hspanDeg: 10 },
      ],
    });
    expect(m.get('w')).toEqual({ hspanDeg: 210, vtopDeg: 45, vbotDeg: 43.8 });
    expect(m.get('s')).toEqual(FULL_SPHERE);
    expect(m.size).toBe(2);
    expect(parsePanoIndex(null).size).toBe(0);
  });

  it('guesses coverage from the image size when there is no metadata', () => {
    expect(coverageFromImage(4096, 2048)).toEqual(FULL_SPHERE);
    expect(coverageFromImage(4096, 1024)).toEqual({ hspanDeg: 360, vtopDeg: 45, vbotDeg: 45 });
  });

  it('turns azimuth and elevation into local directions (north is -Z, east is +X)', () => {
    close(azElToDir(0, 0), [0, 0, -1]);
    close(azElToDir(90, 0), [1, 0, 0]);
    close(azElToDir(180, 0), [0, 0, 1]);
    close(azElToDir(0, 90), [0, 1, 0]);
    close(dirToAzEl(azElToDir(237, -21)), [237, -21]);
  });

  it('maps the image centre column to the heading, like the viewer shader', () => {
    // full sphere whose centre column looks east
    close(panoUv(azElToDir(90, 0), 90, FULL_SPHERE), [0.5, 0.5]);
    close(panoUv(azElToDir(180, 0), 90, FULL_SPHERE), [0.75, 0.5]);
    close(panoUv(azElToDir(0, 0), 90, FULL_SPHERE), [0.25, 0.5]);
    close(panoUv(azElToDir(90, 90), 90, FULL_SPHERE), [0.5, 1]);
    close(panoUv(azElToDir(90, -45), 90, FULL_SPHERE), [0.5, 0.25]);
  });

  it('leaves the uncovered part of a wide panorama empty', () => {
    const wide = { hspanDeg: 210, vtopDeg: 45, vbotDeg: 43.8 };
    close(panoUv(azElToDir(109.3, 0), 109.3, wide), [0.5, 43.8 / 88.8]);
    close(panoUv(azElToDir(109.3 + 104.999, 44.999), 109.3, wide), [1, 1], 4);
    expect(panoUv(azElToDir(109.3 + 106, 0), 109.3, wide)).toBeNull();
    expect(panoUv(azElToDir(109.3 - 106, 0), 109.3, wide)).toBeNull();
    expect(panoUv(azElToDir(109.3, 46), 109.3, wide)).toBeNull();
    expect(panoUv(azElToDir(109.3, -44), 109.3, wide)).toBeNull();
  });

  it('drags the panorama with the pointer and zooms within limits', () => {
    const look = { yawDeg: 10, pitchDeg: 0, fovDeg: 60 };
    // dragging right by a sixth of the height turns the view 10 deg to the left
    expect(dragLook(look, 100, 0, 600)).toEqual({ yawDeg: 0, pitchDeg: 0, fovDeg: 60 });
    expect(dragLook(look, 200, 0, 600).yawDeg).toBeCloseTo(350, 9);
    // dragging down looks up, never past the zenith
    expect(dragLook(look, 0, 300, 600).pitchDeg).toBe(30);
    expect(dragLook(look, 0, 9000, 600).pitchDeg).toBe(89);
    expect(zoomLook(look, -100).fovDeg).toBeCloseTo(55.2, 9);
    expect(zoomLook({ ...look, fovDeg: PANO_FOV.min }, -1).fovDeg).toBe(PANO_FOV.min);
    expect(zoomLook({ ...look, fovDeg: PANO_FOV.max }, 1).fovDeg).toBe(PANO_FOV.max);
  });

  it('starts along the heading, a little below the horizon', () => {
    expect(startLook(370, FULL_SPHERE)).toEqual({ yawDeg: 10, pitchDeg: -10, fovDeg: 70 });
    expect(startLook(0, { hspanDeg: 210, vtopDeg: 45, vbotDeg: 43.8 }).pitchDeg).toBeCloseTo(-9.4);
    expect(coverageLabel(FULL_SPHERE)).toBe('360°');
    expect(coverageLabel({ hspanDeg: 210, vtopDeg: 45, vbotDeg: 43.8 })).toBe('Wide 210° x 89°');
  });
});
