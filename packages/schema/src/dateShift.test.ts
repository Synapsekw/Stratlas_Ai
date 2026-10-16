import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  captureLineUpShift,
  DateShiftSchema,
  ProjectManifest,
  isZeroShift,
  shiftCorners,
  shiftEN,
  shiftLocal,
  shiftTransform,
  shiftedDirectionKeys,
  shiftedLayer,
  unshiftLocal,
  type Capture,
  type DirectionKey,
  type Layer,
} from './index';

const S = { eastM: 2, northM: 1 };
const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

describe('date shift helpers', () => {
  it('moves a local point east and north', () => {
    expect(shiftLocal([1, 2, 3], S)).toEqual([3, 2, 2]);
    expect(unshiftLocal([3, 2, 2], S)).toEqual([1, 2, 3]);
  });

  it('shifts a project CRS point, forwards and back', () => {
    expect(shiftEN([10, 20, 30], S)).toEqual([12, 21, 30]);
    expect(shiftEN([12, 21, 30], S, -1)).toEqual([10, 20, 30]);
  });

  it('shifts a column-major transform', () => {
    const t = [...identity];
    t[12] = 5;
    t[14] = 7;
    const r = shiftTransform(t, S);
    expect(r?.[12]).toBe(7);
    expect(r?.[14]).toBe(6);
    expect(r?.filter((_, i) => i !== 12 && i !== 14)).toEqual(
      t.filter((_, i) => i !== 12 && i !== 14),
    );
    const fromNothing = shiftTransform(undefined, S);
    expect(fromNothing?.[12]).toBe(2);
    expect(fromNothing?.[14]).toBe(-1);
    expect(shiftTransform(undefined, null)).toBeUndefined();
  });

  it('shifts raster corners and leaves a cloud as it is', () => {
    const corners = { tl: [0, 0, 0], tr: [10, 0, 0], bl: [0, 0, 10] } as const;
    expect(shiftCorners({ ...corners, tl: [0, 0, 0], tr: [10, 0, 0], bl: [0, 0, 10] }, S)).toEqual({
      tl: [2, 0, -1],
      tr: [12, 0, -1],
      bl: [2, 0, 9],
    });
    const cloud: Layer = {
      kind: 'pointcloud',
      id: 'c',
      name: 'Cloud',
      visible: true,
      src: { path: 'a.copc.laz' },
      format: 'copc',
    };
    expect(shiftedLayer(cloud, S)).toBe(cloud);
  });

  it('shifts a mesh, a raster with corners and panoramas', () => {
    const mesh: Layer = {
      kind: 'mesh',
      id: 'm',
      name: 'M',
      visible: true,
      src: { path: 'a.glb' },
      transform: identity,
    };
    const m = shiftedLayer(mesh, S);
    expect(m.kind === 'mesh' && m.transform[12]).toBe(2);
    expect(m.kind === 'mesh' && m.transform[14]).toBe(-1);
    const pano: Layer = {
      kind: 'panoramas',
      id: 'p',
      name: 'P',
      visible: true,
      items: [{ id: 'a', src: { path: 'a.jpg' }, pos: [1, 2, 3], headingDeg: 0 }],
    };
    const p = shiftedLayer(pano, S);
    expect(p.kind === 'panoramas' && p.items[0]?.pos).toEqual([3, 2, 2]);
  });

  it('adds the shift to a video offset', () => {
    const video = {
      kind: 'video',
      id: 'v',
      name: 'V',
      visible: true,
      src: { path: 'a.mp4' },
      flight: { src: { path: 'a.srt' }, startUtcMs: 0 },
      lens: { model: 'pinhole', fovDeg: 80 },
      offsetMs: 0,
      positionOffsetM: [0, 5, 0],
    } as unknown as Layer;
    const r = shiftedLayer(video, S);
    expect(r.kind === 'video' && r.positionOffsetM).toEqual([2, 5, -1]);
  });

  it('returns the same object for no shift', () => {
    const p: [number, number, number] = [1, 2, 3];
    expect(shiftLocal(p, null)).toBe(p);
    expect(shiftLocal(p, { eastM: 0.0001, northM: 0 })).toBe(p);
    expect(unshiftLocal(p, null)).toBe(p);
    expect(shiftEN(p, null)).toBe(p);
    const t = [...identity];
    expect(shiftTransform(t, null)).toBe(t);
    const l: Layer = {
      kind: 'basemap',
      id: 'b',
      name: 'B',
      visible: true,
      pack: 'x',
      style: 'dark',
    };
    expect(shiftedLayer(l, null)).toBe(l);
  });

  it('reads the shift of a capture', () => {
    const c: Capture = { id: 'c1', label: 'A', date: '2026-01-01' };
    expect(captureLineUpShift(c)).toBeNull();
    expect(
      captureLineUpShift({
        ...c,
        lineUp: { eastM: 1.5, northM: -2, with: 'c0', at: '2026-10-16T08:00:00Z' },
      }),
    ).toEqual({ eastM: 1.5, northM: -2 });
    expect(isZeroShift(null)).toBe(true);
    expect(isZeroShift({ eastM: 0.0004, northM: -0.0004 })).toBe(true);
    expect(isZeroShift({ eastM: 0.001, northM: 0 })).toBe(false);
  });
});

describe('shiftedDirectionKeys', () => {
  const keys: DirectionKey[] = [
    { t: 0, yaw: 10, pitch: -30, roll: 0, fill: 'smooth' },
    { t: 1000, yaw: 0, pitch: -45, roll: 0, fill: 'lookAt', target: [10, 0, -5] },
  ];

  it('moves a look-at target with the date and leaves directions alone', () => {
    const out = shiftedDirectionKeys(keys, S);
    expect(out?.[0]).toBe(keys[0]);
    expect(out?.[1]).toEqual({ ...keys[1], target: [12, 0, -6] });
    expect(keys[1]?.target).toEqual([10, 0, -5]);
  });

  it('is the same array for no shift', () => {
    expect(shiftedDirectionKeys(keys, null)).toBe(keys);
    expect(shiftedDirectionKeys(keys, { eastM: 0, northM: 0.0001 })).toBe(keys);
    const plain = keys.slice(0, 1);
    expect(shiftedDirectionKeys(plain, S)).toBe(plain);
    expect(shiftedDirectionKeys(null, S)).toBeNull();
  });
});

describe('membership fixture (shared with the Python resolver)', () => {
  const file = new URL('./__fixtures__/date-shift/membership.json', import.meta.url);
  const { cases } = JSON.parse(readFileSync(file, 'utf8')) as {
    cases: { name: string; manifest: unknown; expected: Record<string, unknown> }[];
  };
  it('holds valid manifests and shifts', () => {
    expect(cases.length).toBeGreaterThanOrEqual(7);
    for (const c of cases) {
      expect(ProjectManifest.safeParse(c.manifest).success, c.name).toBe(true);
      for (const v of Object.values(c.expected))
        expect(DateShiftSchema.safeParse(v).success).toBe(true);
    }
  });
});
