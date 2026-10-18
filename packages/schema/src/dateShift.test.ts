import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  Capture,
  CaptureLineUpTurn,
  captureLineUpShift,
  composeShift,
  DateShiftSchema,
  invertShift,
  turnOf,
  type DateShift,
  ProjectManifest,
  isZeroShift,
  drawnTransform,
  shiftCorners,
  shiftEN,
  shiftLocal,
  shiftTransform,
  shiftedDirectionKeys,
  shiftedLayer,
  storedTransform,
  unshiftCorners,
  unshiftLocal,
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
    expect(captureLineUpShift(c, [0, 0, 0])).toBeNull();
    expect(
      captureLineUpShift(
        { ...c, lineUp: { eastM: 1.5, northM: -2, with: 'c0', at: '2026-10-16T08:00:00Z' } },
        [0, 0, 0],
      ),
    ).toEqual({ eastM: 1.5, northM: -2 });
    expect(isZeroShift(null)).toBe(true);
    expect(isZeroShift({ eastM: 0.0004, northM: -0.0004 })).toBe(true);
    expect(isZeroShift({ eastM: 0.001, northM: 0 })).toBe(false);
  });
});

describe('drawn and stored placements (builder tools)', () => {
  it('draws a stored transform shifted and stores a drawn one unshifted', () => {
    const t = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 5, 6, 7, 1];
    const drawn = drawnTransform(t, S);
    expect(drawn.slice(12)).toEqual([7, 6, 6, 1]);
    expect(storedTransform(drawn, S)).toEqual(t);
    expect(storedTransform(t, null)).toBe(t);
    expect(drawnTransform(t, { eastM: 0, northM: 0 })).toBe(t);
  });

  it('stores drawn raster corners unshifted', () => {
    const c = { tl: [0, 0, 0], tr: [10, 0, 0], bl: [0, 0, 10] } as const;
    const drawn = shiftCorners({ tl: [...c.tl], tr: [...c.tr], bl: [...c.bl] }, S);
    expect(unshiftCorners(drawn, S)).toEqual(c);
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

describe('line-up turn and scale (similarity fixture, shared with Python)', () => {
  const file = new URL('./__fixtures__/date-shift/similarity.json', import.meta.url);
  interface Case {
    name: string;
    s: {
      eastM: number;
      northM: number;
      rotationDeg: number;
      scale: number;
      pivotE: number;
      pivotN: number;
    };
    en: [number, number][];
    enOut: [number, number][];
    local: [number, number, number][];
    localOut: [number, number, number][];
    mat4: number[];
  }
  const { origin, cases } = JSON.parse(readFileSync(file, 'utf8')) as {
    origin: [number, number, number];
    cases: Case[];
  };
  const at = '2026-10-16T08:00:00Z';
  const must = <V>(v: V | null | undefined): V => {
    if (v === null || v === undefined) throw new Error('missing');
    return v;
  };
  const base: Capture = { id: 'c1', label: 'A', date: '2026-01-01' };
  const capture = (s: Case['s']): Capture => ({
    ...base,
    lineUp: { eastM: s.eastM, northM: s.northM, with: 'c0', at },
    lineUpTurn: { rotationDeg: s.rotationDeg, scale: s.scale, pivotE: s.pivotE, pivotN: s.pivotN },
  });
  const near = (got: readonly number[] | undefined, want: readonly number[], what: string) => {
    expect(got?.length, what).toBe(want.length);
    want.forEach((w, i) => {
      expect(Math.abs((got?.[i] ?? NaN) - w), `${what}[${i}]`).toBeLessThanOrEqual(1e-9);
    });
  };
  const turned = must(captureLineUpShift(capture(must(cases[3]).s), origin));
  const c3 = Math.cos(0.3);
  const s3 = Math.sin(0.3);
  const T = [c3, 0, -s3, 0, 0, 1, 0, 0, s3, 0, c3, 0, 40, 5, -70, 1];

  it('fixture parity: shiftEN, shiftLocal and shiftTransform match every case to 1e-9', () => {
    expect(cases.length).toBe(4);
    for (const c of cases) {
      const s = captureLineUpShift(capture(c.s), origin);
      c.en.forEach((p, i) => {
        near(shiftEN(p, s), must(c.enOut[i]), `${c.name} en ${i}`);
      });
      c.local.forEach((p, i) => {
        near(shiftLocal(p, s), must(c.localOut[i]), `${c.name} local ${i}`);
      });
      near(shiftTransform(identity, s), c.mat4, `${c.name} mat4`);
      // a zero shift hands back what it was given (no transform: none)
      if (!isZeroShift(s))
        near(shiftTransform(undefined, s), c.mat4, `${c.name} mat4 from nothing`);
    }
  });

  it('a {eastM,northM} literal behaves exactly as before', () => {
    const lit: DateShift = { eastM: 2, northM: -1 };
    expect(turnOf(lit)).toBeNull();
    expect(shiftLocal([1, 2, 3], lit)).toEqual([3, 2, 4]);
    expect(shiftEN([10, 20, 30], lit)).toEqual([12, 19, 30]);
    expect(invertShift(lit)).toEqual({ eastM: -2, northM: 1 });
    expect(composeShift(lit, { eastM: 0.5, northM: 0.25 })).toEqual({
      eastM: 2.5,
      northM: -0.75,
    });
    // the shift-only fixture case through a literal
    const c = must(cases[1]);
    const s: DateShift = { eastM: c.s.eastM, northM: c.s.northM };
    c.local.forEach((p, i) => {
      expect(shiftLocal(p, s)).toEqual([p[0] + s.eastM, p[1], p[2] - s.northM]);
      near(shiftLocal(p, s), must(c.localOut[i]), `literal local ${i}`);
    });
    near(shiftTransform(identity, s), c.mat4, 'literal mat4');
  });

  it('a turned shift is not zero, even with no translation', () => {
    expect(isZeroShift({ ...turned, eastM: 0, northM: 0 })).toBe(false);
    expect(isZeroShift(turned)).toBe(false);
    const p: [number, number, number] = [1, 2, 3];
    // an identity turn is no turn
    const id = { eastM: 0, northM: 0, turn: { ...must(turned.turn), rotationDeg: 0, scale: 1 } };
    expect(isZeroShift(id)).toBe(true);
    expect(shiftLocal(p, id)).toBe(p);
  });

  it('stored(drawn(t)) is t for a turned shift', () => {
    const drawn = drawnTransform(T, turned);
    expect(drawn).not.toEqual(T);
    near(storedTransform(drawn, turned), T, 'stored(drawn)');
    near(drawnTransform(storedTransform(T, turned), turned), T, 'drawn(stored)');
  });

  it('unshiftLocal undoes shiftLocal', () => {
    for (const p of must(cases[3]).local) {
      near(unshiftLocal(shiftLocal(p, turned), turned), p, 'local');
      const q: [number, number, number] = [p[0] + origin[0], origin[1] - p[2], 7];
      near(shiftEN(shiftEN(q, turned), turned, -1), q, 'en');
    }
    const c: RasterCornersT = { tl: [0, 1, 0], tr: [10, 1, 0], bl: [0, 1, 10] };
    const back = unshiftCorners(shiftCorners(c, turned), turned);
    near(back.tl, c.tl, 'tl');
    near(back.tr, c.tr, 'tr');
    near(back.bl, c.bl, 'bl');
  });

  it('composes and inverts', () => {
    const second = must(captureLineUpShift(capture(must(cases[2]).s), origin));
    const both = composeShift(turned, second);
    const inv = invertShift(turned);
    for (const p of must(cases[3]).local) {
      near(shiftLocal(p, both), shiftLocal(shiftLocal(p, turned), second), 'compose local');
      near(shiftLocal(p, inv), unshiftLocal(p, turned), 'invert local');
    }
    for (const p of must(cases[3]).en)
      near(shiftEN(p, both), shiftEN(shiftEN(p, turned), second), 'compose en');
    const none = composeShift(turned, inv);
    near(shiftLocal([123, 4, -56], none), [123, 4, -56], 'compose with inverse');
    // composing with a plain shift keeps the turn's pivot
    const plain = composeShift(turned, { eastM: 1, northM: 2 });
    for (const p of must(cases[3]).local)
      near(shiftLocal(p, plain), shiftLocal(shiftLocal(p, turned), { eastM: 1, northM: 2 }), 'p');
    const s = must(cases[3]).s;
    expect(turnOf(turned)).toEqual({
      rotationDeg: s.rotationDeg,
      scale: s.scale,
      pivotE: s.pivotE,
      pivotN: s.pivotN,
    });
  });

  it('the same capture under two origins moves a CRS point the same', () => {
    const c = capture(must(cases[2]).s);
    const o2: [number, number, number] = [500300, 2699800, 0];
    const a = must(captureLineUpShift(c, origin));
    const b = must(captureLineUpShift(c, o2));
    for (const [E, N] of must(cases[2]).en) {
      const la = shiftLocal([E - origin[0], 0, origin[1] - N], a);
      const lb = shiftLocal([E - o2[0], 0, o2[1] - N], b);
      near([la[0] + origin[0], origin[1] - la[2]], [lb[0] + o2[0], o2[1] - lb[2]], 'two origins');
      near([la[0] + origin[0], origin[1] - la[2]], shiftEN([E, N], a), 'local vs CRS');
    }
  });

  it('captureLineUpShift ignores a missing lineUpTurn', () => {
    const s = captureLineUpShift(
      { ...base, lineUp: { eastM: 1.5, northM: -2, with: 'c0', at } },
      origin,
    );
    expect(s).toEqual({ eastM: 1.5, northM: -2 });
    expect(s).not.toHaveProperty('turn');
    const t = must(captureLineUpShift(capture(must(cases[2]).s), origin));
    expect(t.turn).toEqual({
      rotationDeg: 0.1,
      scale: 1.0035,
      pivotE: must(cases[2]).s.pivotE,
      pivotN: must(cases[2]).s.pivotN,
      pivotX: must(cases[2]).s.pivotE - origin[0],
      pivotZ: origin[1] - must(cases[2]).s.pivotN,
    });
  });

  it('CaptureLineUpTurn stores within 2 degrees and 2 per cent', () => {
    const ok = { rotationDeg: 2, scale: 1.02, pivotE: 1, pivotN: 2 };
    expect(CaptureLineUpTurn.safeParse(ok).success).toBe(true);
    expect(CaptureLineUpTurn.safeParse({ ...ok, rotationDeg: -2, scale: 0.98 }).success).toBe(true);
    expect(CaptureLineUpTurn.safeParse({ ...ok, rotationDeg: 2.5 }).success).toBe(false);
    expect(CaptureLineUpTurn.safeParse({ ...ok, rotationDeg: -2.5 }).success).toBe(false);
    expect(CaptureLineUpTurn.safeParse({ ...ok, scale: 1.03 }).success).toBe(false);
    expect(CaptureLineUpTurn.safeParse({ ...ok, scale: 0.97 }).success).toBe(false);
  });

  it('Capture keeps unknown keys out but parses lineUpTurn', () => {
    const turn = { rotationDeg: 0.1, scale: 1.0035, pivotE: 1, pivotN: 2 };
    const r = Capture.parse({ ...base, lineUpTurn: turn, somethingElse: 1 });
    expect(r.lineUpTurn).toEqual(turn);
    expect(r).not.toHaveProperty('somethingElse');
    expect(Capture.safeParse({ ...base, lineUpTurn: { ...turn, scale: 2 } }).success).toBe(false);
  });

  it('video offset adds the move at the pivot for a turned shift', () => {
    const video = {
      kind: 'video',
      id: 'v',
      name: 'V',
      visible: true,
      src: { path: 'a.mp4' },
      flight: { src: { path: 'a.srt' }, startUtcMs: 0 },
      lens: { model: 'pinhole', fovDeg: 80 },
      offsetMs: 0,
      positionOffsetM: [10, 5, -20],
    } as unknown as Layer;
    const t = must(turned.turn);
    const pivot: [number, number, number] = [t.pivotX, 0, t.pivotZ];
    const moved = shiftLocal(pivot, turned);
    const r = shiftedLayer(video, turned);
    const got = r.kind === 'video' ? r.positionOffsetM : undefined;
    near(got, [10 + moved[0] - pivot[0], 5, -20 + moved[2] - pivot[2]], 'offset');
    expect(got).toEqual([10 + turned.eastM, 5, -20 - turned.northM]);
    // with no turn it is today's offset
    const plain = shiftedLayer(video, { eastM: turned.eastM, northM: turned.northM });
    expect(plain.kind === 'video' && plain.positionOffsetM).toEqual(got);
  });
});

type RasterCornersT = Parameters<typeof shiftCorners>[0];
