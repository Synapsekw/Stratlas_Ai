import type { Detection } from '@aio/annotate/detections';
import { describe, expect, it } from 'vitest';
import { boxScreenLines, framesNear, projectDir, pixelToLook } from './detOverlay';

const FRAME = { width: 2000, height: 1000 };
const VIEW = { width: 800, height: 600 };
const AHEAD = { yawDeg: 0, pitchDeg: 0, fovDeg: 70 };
const RAD = Math.PI / 180;

describe('equirect pixels as directions', () => {
  it('puts the picture centre at yaw 0, the right edge at 180 and the top at pitch 90', () => {
    expect(pixelToLook(1000, 500, 2000, 1000)).toEqual([0, 0]);
    expect(pixelToLook(2000, 500, 2000, 1000)).toEqual([180, 0]);
    expect(pixelToLook(1500, 0, 2000, 1000)).toEqual([90, 90]);
  });
});

describe('projecting a direction to the 360 view', () => {
  it('puts the look direction at the screen centre', () => {
    const p = projectDir([0, 0, -1], AHEAD, VIEW);
    expect(p?.[0]).toBeCloseTo(400);
    expect(p?.[1]).toBeCloseTo(300);
  });

  it('reads the fov as vertical: half the fov up lands on the top edge', () => {
    const d: [number, number, number] = [0, Math.sin(35 * RAD), -Math.cos(35 * RAD)];
    const p = projectDir(d, AHEAD, VIEW);
    expect(p?.[0]).toBeCloseTo(400);
    expect(p?.[1]).toBeCloseTo(0);
  });

  it('widens the horizontal fov by the aspect: the right edge is at atan(tan(fov/2) * aspect)', () => {
    const half = Math.atan(Math.tan(35 * RAD) * (800 / 600));
    const p = projectDir([Math.sin(half), 0, -Math.cos(half)], AHEAD, VIEW);
    expect(p?.[0]).toBeCloseTo(800);
    expect(p?.[1]).toBeCloseTo(300);
  });

  it('turns clockwise: a point east of the look is to the right', () => {
    const p = projectDir([Math.sin(10 * RAD), 0, -Math.cos(10 * RAD)], AHEAD, VIEW);
    expect(p?.[0]).toBeGreaterThan(400);
  });

  it('follows the look: looking up puts the horizon below the centre', () => {
    const p = projectDir([0, 0, -1], { ...AHEAD, pitchDeg: 20 }, VIEW);
    expect(p?.[1]).toBeGreaterThan(300);
  });

  it('gives nothing behind the camera', () => {
    expect(projectDir([0, 0, 1], AHEAD, VIEW)).toBeNull();
  });
});

describe('a detection box in the 360 view', () => {
  it('draws a box at the frame centre around the screen centre when looking at yaw 0', () => {
    const r = boxScreenLines([990, 490, 1010, 510], FRAME, AHEAD, VIEW);
    expect(r.lines).toHaveLength(1);
    const line = r.lines[0] ?? [];
    // closed: the last point is the first
    expect(line[0]).toEqual(line[line.length - 1]);
    for (const [x, y] of line) {
      expect(Math.abs(x - 400)).toBeLessThan(20);
      expect(Math.abs(y - 300)).toBeLessThan(20);
    }
    const xs = line.map((p) => p[0]);
    expect(Math.min(...xs)).toBeLessThan(400);
    expect(Math.max(...xs)).toBeGreaterThan(400);
    expect(r.anchor?.[1]).toBeLessThan(300);
  });

  it('samples each edge so a wide box bends with the sphere', () => {
    const r = boxScreenLines([900, 400, 1100, 600], FRAME, AHEAD, VIEW);
    expect((r.lines[0] ?? []).length).toBeGreaterThanOrEqual(4 * 8 + 1);
  });

  it('gives no points for a box behind the camera', () => {
    const r = boxScreenLines([0, 490, 20, 510], FRAME, AHEAD, VIEW);
    expect(r.lines).toEqual([]);
    expect(r.anchor).toBeNull();
  });

  it('draws a box across the seam as one continuous outline when looking at yaw 180', () => {
    // x 1950 to 2100 in a 2000 wide frame: yaw 171 to 198
    const r = boxScreenLines([1950, 450, 2100, 550], FRAME, { ...AHEAD, yawDeg: 180 }, VIEW);
    expect(r.lines).toHaveLength(1);
    const line = r.lines[0] ?? [];
    for (const [x, y] of line) {
      expect(x).toBeGreaterThan(0);
      expect(x).toBeLessThan(800);
      expect(y).toBeGreaterThan(0);
      expect(y).toBeLessThan(600);
    }
    for (let i = 1; i < line.length; i++) {
      const a = line[i - 1] ?? [0, 0];
      const b = line[i] ?? [0, 0];
      expect(Math.hypot(b[0] - a[0], b[1] - a[1])).toBeLessThan(60);
    }
    // centred at yaw 184.5: a little right of the screen centre
    const xs = line.map((p) => p[0]);
    expect((Math.min(...xs) + Math.max(...xs)) / 2).toBeGreaterThan(400);
  });

  it('cuts a box that reaches behind the camera into open parts with finite points', () => {
    // yaw -120 to 120 at the horizon: its ends are behind a camera looking at yaw 0
    const r = boxScreenLines([333, 450, 1667, 550], FRAME, AHEAD, VIEW);
    expect(r.lines.length).toBeGreaterThanOrEqual(2);
    for (const line of r.lines) {
      expect(line.length).toBeGreaterThanOrEqual(2);
      for (const [x, y] of line) {
        expect(Number.isFinite(x)).toBe(true);
        expect(Number.isFinite(y)).toBe(true);
      }
    }
  });
});

describe('the detections shown at a moment of the walk', () => {
  const det = (id: string, layer: string, t: number, status = 'draft'): Detection =>
    ({
      id,
      source: { kind: 'frame', layer, t },
      status,
    }) as unknown as Detection;
  const list = [
    det('a', 'w', 2),
    det('b', 'w', 2),
    det('c', 'w', 4),
    det('d', 'other', 3),
    det('e', 'w', 4, 'rejected'),
    { id: 'p', source: { kind: 'photo', layer: 'w', photo: 'x' }, status: 'draft' } as Detection,
  ];

  it('are those of the nearest sample of this walk', () => {
    expect(framesNear(list, 'w', 2.4).map((d) => d.id)).toEqual(['a', 'b']);
    expect(framesNear(list, 'w', 3.6).map((d) => d.id)).toEqual(['c']);
  });

  it('are none when the nearest sample is more than a second away', () => {
    expect(framesNear(list, 'w', 5.2)).toEqual([]);
    expect(framesNear(list, 'nothing', 2)).toEqual([]);
  });

  it('leave rejected ones out', () => {
    expect(framesNear(list, 'w', 4).map((d) => d.id)).toEqual(['c']);
  });

  it('show nothing when the nearest sampled frame found nothing', () => {
    // sampled every second; only 2 s and 4 s found anything
    const samples = [0, 1, 2, 3, 4, 5];
    expect(framesNear(list, 'w', 3, samples)).toEqual([]);
    expect(framesNear(list, 'w', 2.4, samples).map((d) => d.id)).toEqual(['a', 'b']);
    expect(framesNear(list, 'w', 2.6, samples)).toEqual([]);
    expect(framesNear(list, 'w', 3.6, samples).map((d) => d.id)).toEqual(['c']);
  });

  it('keep within half the sampling interval of the last sample', () => {
    const samples = [3, 3.5, 4];
    expect(framesNear(list, 'w', 4.2, samples).map((d) => d.id)).toEqual(['c']);
    expect(framesNear(list, 'w', 4.3, samples)).toEqual([]);
  });

  it('cap the window at a second when samples are far apart', () => {
    const one = [det('a', 'w', 2)];
    expect(framesNear(one, 'w', 2.9, [2, 6]).map((d) => d.id)).toEqual(['a']);
    expect(framesNear(one, 'w', 3.2, [2, 6])).toEqual([]);
  });

  it('without the sampled times, keep to half the gap to the neighbouring detection frame', () => {
    const near = [det('x', 'w', 1), det('y', 'w', 1.5), det('z', 'w', 2)];
    expect(framesNear(near, 'w', 2.2).map((d) => d.id)).toEqual(['z']);
    expect(framesNear(near, 'w', 2.3)).toEqual([]);
  });

  it('show none of a sample whose detections were all rejected', () => {
    const only = [det('r', 'w', 4, 'rejected'), det('a', 'w', 3)];
    expect(framesNear(only, 'w', 4, [3, 4])).toEqual([]);
  });
});
