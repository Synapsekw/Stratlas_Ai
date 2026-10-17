import { describe, expect, it } from 'vitest';
import {
  groupPanoFrames,
  horizontalM,
  isReadyMadePano,
  PANO_GROUPING,
  pitchRows,
  yawSpanDeg,
  type PanoFrameMeta,
} from './panoGroups';

const LAT = 46.5;
const LON = 7.5;
const M_PER_DEG_LAT = 111_195;
const north = (m: number) => m / M_PER_DEG_LAT;
const east = (m: number) => m / (M_PER_DEG_LAT * Math.cos((LAT * Math.PI) / 180));

/** Deterministic jitter in [-1, 1). */
function jitter(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1_103_515_245 + 12_345) % 2_147_483_648;
    return (s / 2_147_483_648) * 2 - 1;
  };
}

const time = (start: Date, s: number) =>
  new Date(start.getTime() + s * 1000).toISOString().slice(0, 19);

/** DJI file numbers wrap after 0999 to 0001. */
const fileName = (no: number) => `SYN_${String(((no - 1) % 999) + 1).padStart(4, '0')}.JPG`;

interface SphereOpts {
  start: Date;
  eastM: number;
  northM: number;
  firstNo: number;
  pattern: 'rows' | 'bursts';
  /** Keep only this many frames (a short sphere). */
  take?: number;
  /** Yaws to shoot (a wide panorama uses fewer). */
  yaws?: number[];
  seed?: number;
}

/** Pattern A: rows at 0, -35, -70 (8 yaws each) then nadir, 6 s apart. Pattern B: 7 yaws, a
 * burst of 3 pitches (+20, -17, -55) per yaw 1 s apart, 5 s between yaws, then nadir. */
function sphere(o: SphereOpts): PanoFrameMeta[] {
  const rnd = jitter(o.seed ?? 1);
  const shots: { yaw: number; pitch: number; t: number }[] = [];
  if (o.pattern === 'rows') {
    const yaws = o.yaws ?? [-180, -135, -90, -45, 0, 45, 90, 135];
    let t = 0;
    for (const pitch of [0, -35, -70])
      for (const yaw of yaws) {
        shots.push({ yaw, pitch, t });
        t += 6;
      }
    shots.push({ yaw: 0, pitch: -90, t });
  } else {
    const yaws = o.yaws ?? [-180, -128.6, -77.1, -25.7, 25.7, 77.1, 128.6];
    let t = 0;
    for (const yaw of yaws) {
      for (const pitch of [20, -17, -55]) {
        shots.push({ yaw, pitch, t });
        t += 1;
      }
      t += 4;
    }
    shots.push({ yaw: 0, pitch: -90, t });
  }
  return shots.slice(0, o.take ?? shots.length).map((s, i) => ({
    file: `D:/card/100MEDIA/${fileName(o.firstNo + i)}`,
    bytes: 11_000_000,
    takenAt: time(o.start, s.t),
    lat: LAT + north(o.northM + rnd() * 1.0),
    lon: LON + east(o.eastM + rnd() * 1.0),
    absAlt: 620 + rnd() * 1.5,
    relAlt: 70 + rnd() * 1.5,
    gimbal: { yaw: s.yaw + rnd() * 0.5, pitch: s.pitch + rnd() * 0.5, roll: 0 },
    width: 5472,
    height: 3648,
  }));
}

/** A mapping run: nadir photos 20 m apart, 2 s apart, one flight yaw. */
function mapping(start: Date, firstNo: number, n: number, eastM: number): PanoFrameMeta[] {
  return Array.from({ length: n }, (_, i) => ({
    file: `D:/card/100MEDIA/${fileName(firstNo + i)}`,
    bytes: 9_000_000,
    takenAt: time(start, i * 2),
    lat: LAT + north(300),
    lon: LON + east(eastM + i * 20),
    absAlt: 650,
    relAlt: 100,
    gimbal: { yaw: 92, pitch: -90, roll: 0 },
    width: 5472,
    height: 3648,
  }));
}

function must<T>(v: T | undefined): T {
  if (v === undefined) throw new Error('fixture missing');
  return v;
}

/** The frame without the given keys (exactOptionalPropertyTypes forbids `key: undefined`). */
function without(f: PanoFrameMeta, ...keys: (keyof PanoFrameMeta)[]): PanoFrameMeta {
  const drop = new Set<string>(keys);
  return Object.fromEntries(
    Object.entries(f).filter(([k]) => !drop.has(k)),
  ) as unknown as PanoFrameMeta;
}

const names = (fs: readonly PanoFrameMeta[]) => fs.map((f) => f.file).sort();
const t0 = new Date('2026-09-10T10:00:00Z');
const later = (min: number) => new Date(t0.getTime() + min * 60_000);

describe('yawSpanDeg and pitchRows', () => {
  it('measures yaw coverage across the 180 degree wrap', () => {
    expect(yawSpanDeg([170, -170])).toBeCloseTo(20, 6);
    expect(yawSpanDeg([0, 90, 180, 270])).toBeCloseTo(270, 6);
    expect(yawSpanDeg([-180, -135, -90, -45, 0, 45, 90, 135])).toBeCloseTo(315, 6);
    expect(yawSpanDeg([])).toBe(0);
  });

  it('counts rows of at least two frames within the tolerance', () => {
    expect(pitchRows([0, 0.4, -35, -35.3, -70, -69.8, -90], 8, 2)).toBe(3);
    expect(pitchRows([20, -17, -55, -90], 8, 2)).toBe(0);
    expect(pitchRows([20, 20, -17, -17, -55, -55, -90], 8, 2)).toBe(3);
  });
});

describe('groupPanoFrames', () => {
  it('finds both capture patterns and leaves mapping photos out', () => {
    const a = sphere({ start: t0, eastM: 0, northM: 0, firstNo: 1, pattern: 'rows' });
    const b = sphere({ start: later(5), eastM: 150, northM: 0, firstNo: 40, pattern: 'bursts' });
    const c = sphere({
      start: later(10),
      eastM: 300,
      northM: 50,
      firstNo: 80,
      pattern: 'rows',
      seed: 3,
    });
    const m = mapping(later(15), 120, 6, 0);
    const g = groupPanoFrames([...m, ...c, ...a, ...b]);
    expect(g.spheres.map((s) => names(s.frames))).toEqual([names(a), names(b), names(c)]);
    expect(g.spheres.map((s) => s.shape)).toEqual(['sphere', 'sphere', 'sphere']);
    expect(g.skipped).toEqual(m.map((f) => ({ file: f.file, reason: 'few-frames' })));
    expect(g.ready).toEqual([]);
  });

  it('orders by capture time, not by file number, when numbers wrap', () => {
    const a = sphere({ start: t0, eastM: 0, northM: 0, firstNo: 990, pattern: 'rows' });
    expect(a.some((f) => f.file.endsWith('SYN_0001.JPG'))).toBe(true);
    const shuffled = [...a].sort((x, y) => x.file.localeCompare(y.file));
    const g = groupPanoFrames(shuffled);
    expect(g.spheres).toHaveLength(1);
    expect(g.spheres[0]?.frames.map((f) => f.takenAt)).toEqual(a.map((f) => f.takenAt));
  });

  it('starts a new sphere on a return to the same spot later in the flight', () => {
    const a = sphere({ start: t0, eastM: 0, northM: 0, firstNo: 1, pattern: 'rows' });
    const b = sphere({
      start: later(12),
      eastM: 0,
      northM: 0,
      firstNo: 60,
      pattern: 'rows',
      seed: 9,
    });
    const g = groupPanoFrames([...a, ...b]);
    expect(g.spheres.map((s) => names(s.frames))).toEqual([names(a), names(b)]);
  });

  /** Sphere b starts gapS seconds after sphere a's last frame, offset as given. */
  function twoSpheres(gapS: number, eastM: number, altShift = 0): PanoFrameMeta[] {
    const a = sphere({ start: t0, eastM: 0, northM: 0, firstNo: 1, pattern: 'rows' });
    const b = sphere({
      start: new Date(t0.getTime() + (24 * 6 + gapS) * 1000),
      eastM,
      northM: 0,
      firstNo: 40,
      pattern: 'rows',
      seed: 4,
    }).map((f) => (f.absAlt === undefined ? f : { ...f, absAlt: f.absAlt + altShift }));
    return [...a, ...b];
  }

  it('splits two spheres at the same spot 34 s apart: only the gap rule separates them', () => {
    expect(groupPanoFrames(twoSpheres(34, 0)).spheres).toHaveLength(2);
  });

  it('keeps frames 20 s apart at the same spot in one sphere (gap is within the limit)', () => {
    expect(groupPanoFrames(twoSpheres(20, 0)).spheres).toHaveLength(1);
  });

  it('splits on distance alone: 10 s apart and 8 m apart at the same height', () => {
    expect(groupPanoFrames(twoSpheres(10, 8)).spheres).toHaveLength(2);
  });

  it('splits on height alone: 10 s apart, same spot, 10 m apart in altitude', () => {
    expect(groupPanoFrames(twoSpheres(10, 0, 10)).spheres).toHaveLength(2);
  });

  it('keeps one sphere when a single frame jumps 6 m sideways (GPS noise)', () => {
    const a = sphere({ start: t0, eastM: 0, northM: 0, firstNo: 1, pattern: 'rows' });
    const jumped = a.map((f, i) =>
      i === 11 && f.lat !== undefined ? { ...f, lat: f.lat + north(6) } : f,
    );
    const g = groupPanoFrames(jumped);
    expect(g.spheres.map((s) => s.frames.length)).toEqual([25]);
    expect(g.skipped).toEqual([]);
  });

  it('keeps one sphere when a single frame jumps 4 m in altitude (barometer noise)', () => {
    const a = sphere({ start: t0, eastM: 0, northM: 0, firstNo: 1, pattern: 'rows' });
    const jumped = a.map((f, i) =>
      i === 11 && f.absAlt !== undefined ? { ...f, absAlt: f.absAlt + 4 } : f,
    );
    const g = groupPanoFrames(jumped);
    expect(g.spheres.map((s) => s.frames.length)).toEqual([25]);
    expect(g.skipped).toEqual([]);
  });

  it('judges a wide panorama against wide panoramas, not against spheres', () => {
    const a = sphere({ start: t0, eastM: 0, northM: 0, firstNo: 1, pattern: 'rows' });
    const b = sphere({ start: later(5), eastM: 150, northM: 0, firstNo: 40, pattern: 'rows' });
    const w = sphere({
      start: later(10),
      eastM: 300,
      northM: 0,
      firstNo: 80,
      pattern: 'bursts',
      yaws: [-100, -35.7, 28.7, 60.8, 93],
      seed: 8,
    });
    expect(w).toHaveLength(16);
    const g = groupPanoFrames([...a, ...b, ...w]);
    expect(g.spheres.map((s) => [s.shape, s.incomplete])).toEqual([
      ['sphere', false],
      ['sphere', false],
      ['wide', false],
    ]);
  });

  it('flags a short sphere as incomplete and refuses one under 8 frames', () => {
    const a = sphere({ start: t0, eastM: 0, northM: 0, firstNo: 1, pattern: 'rows' });
    const b = sphere({
      start: later(5),
      eastM: 150,
      northM: 0,
      firstNo: 40,
      pattern: 'rows',
      seed: 2,
    });
    // 18 frames: rows 0 and -35 complete, two of row -70; yaw 315, three rows (two frames at -70)
    const short = sphere({
      start: later(10),
      eastM: 300,
      northM: 0,
      firstNo: 80,
      pattern: 'rows',
      take: 18,
      seed: 5,
    });
    const tiny = sphere({
      start: later(15),
      eastM: 450,
      northM: 0,
      firstNo: 120,
      pattern: 'rows',
      take: 6,
      seed: 6,
    });
    const g = groupPanoFrames([...a, ...b, ...short, ...tiny]);
    expect(g.spheres.map((s) => [s.frames.length, s.incomplete])).toEqual([
      [25, false],
      [25, false],
      [18, true],
    ]);
    expect(new Set(g.skipped.map((s) => s.reason))).toEqual(new Set(['few-frames']));
    expect(g.skipped.map((s) => s.file).sort()).toEqual(names(tiny));
  });

  it('takes a 150 to 270 degree cluster as a wide panorama (P0)', () => {
    // 7 yaws x 3 rows, 193 degrees of yaw: the real wide clusters P0 found
    const yaws = [-100, -67.8, -35.7, -3.5, 28.7, 60.8, 93];
    const w = sphere({
      start: t0,
      eastM: 0,
      northM: 0,
      firstNo: 1,
      pattern: 'bursts',
      yaws,
      seed: 8,
    });
    const g = groupPanoFrames(w);
    expect(g.spheres).toHaveLength(1);
    expect(g.spheres[0]?.shape).toBe('wide');
    expect(g.spheres[0]?.frames).toHaveLength(22);
  });

  it('measures yaw coverage over non-nadir frames only', () => {
    // 193 degrees of yaw plus a nadir frame turned to 180: with it the span would read 273
    const yaws = [-100, -67.8, -35.7, -3.5, 28.7, 60.8, 93];
    const w = sphere({
      start: t0,
      eastM: 0,
      northM: 0,
      firstNo: 1,
      pattern: 'bursts',
      yaws,
      seed: 8,
    });
    const nadir = must(w[w.length - 1]);
    const nadirPitch = must(nadir.gimbal).pitch;
    expect(nadirPitch).toBeLessThan(-85);
    nadir.gimbal = { yaw: 180, pitch: nadirPitch, roll: 0 };
    const g = groupPanoFrames(w);
    expect(g.spheres.map((s) => s.shape)).toEqual(['wide']);
  });

  it('never takes a stitched output tagged GPano as a frame, whatever its aspect', () => {
    const a = sphere({ start: t0, eastM: 0, northM: 0, firstNo: 1, pattern: 'rows' });
    const twin = must(a[10]);
    const full = { ...twin, file: 'D:/card/out_full.JPG', width: 14400, height: 7200, gpano: true };
    const partial = {
      ...twin,
      file: 'D:/card/out_part.JPG',
      width: 14400,
      height: 6100,
      gpano: true,
    };
    const g = groupPanoFrames([...a, full, partial]);
    expect(g.spheres.map((s) => s.frames.length)).toEqual([25]);
    expect(g.ready.map((f) => f.file)).toEqual(['D:/card/out_full.JPG', 'D:/card/out_part.JPG']);
    expect(g.skipped).toEqual([]);
  });

  it('leaves a frame of another image size out of the group (untagged stitched output)', () => {
    const a = sphere({ start: t0, eastM: 0, northM: 0, firstNo: 1, pattern: 'rows' });
    const stitched = {
      ...must(a[10]),
      file: 'D:/card/out_untagged.JPG',
      width: 14400,
      height: 6100,
    };
    const g = groupPanoFrames([...a.slice(0, 12), stitched, ...a.slice(12)]);
    expect(g.spheres.map((s) => s.frames.length)).toEqual([25]);
    expect(g.spheres.some((s) => s.frames.some((f) => f.file === stitched.file))).toBe(false);
    expect(g.skipped).toEqual([{ file: stitched.file, reason: 'different-size' }]);
  });

  it('refuses a cluster that turns less than 150 degrees, or keeps one pitch', () => {
    const narrow = sphere({
      start: t0,
      eastM: 0,
      northM: 0,
      firstNo: 1,
      pattern: 'rows',
      yaws: [0, 20, 40, 60],
      seed: 3,
    });
    const flat = sphere({
      start: later(5),
      eastM: 200,
      northM: 0,
      firstNo: 40,
      pattern: 'rows',
      take: 8,
      seed: 4,
    });
    const g = groupPanoFrames([...narrow, ...flat]);
    expect(g.spheres).toEqual([]);
    const reasons = new Map(g.skipped.map((s) => [s.file, s.reason]));
    expect(narrow.every((f) => reasons.get(f.file) === 'narrow-yaw')).toBe(true);
    expect(flat.every((f) => reasons.get(f.file) === 'one-pitch-row')).toBe(true);
  });

  it('lists frames without gimbal angles, time or position with their reason', () => {
    const a = sphere({ start: t0, eastM: 0, northM: 0, firstNo: 1, pattern: 'rows' });
    const noGimbal = { ...without(must(a[0]), 'gimbal'), file: 'D:/card/IMG_1.JPG' };
    const noTime = { ...without(must(a[1]), 'takenAt'), file: 'D:/card/IMG_2.JPG' };
    const noGps = { ...without(must(a[2]), 'lat', 'lon'), file: 'D:/card/IMG_3.JPG' };
    const broken: PanoFrameMeta = { file: 'D:/card/broken.JPG', bytes: 10, unreadable: true };
    const g = groupPanoFrames([...a, noGimbal, noTime, noGps, broken]);
    expect(g.spheres).toHaveLength(1);
    expect(g.skipped).toEqual([
      { file: 'D:/card/IMG_1.JPG', reason: 'no-gimbal' },
      { file: 'D:/card/IMG_2.JPG', reason: 'no-position' },
      { file: 'D:/card/IMG_3.JPG', reason: 'no-position' },
      { file: 'D:/card/broken.JPG', reason: 'unreadable' },
    ]);
  });

  it('takes 2:1 and GPano frames as ready-made panoramas, with or without a position', () => {
    const base = { bytes: 30_000_000, takenAt: '2026-09-10T10:00:00', lat: LAT, lon: LON };
    const twoToOne = { ...base, file: 'D:/Pano/a.jpg', width: 14400, height: 7200 };
    const gpano = { ...base, file: 'D:/Pano/b.jpg', width: 8000, height: 3000, gpano: true };
    const lost = { file: 'D:/Pano/c.jpg', bytes: 1, width: 4000, height: 2000 };
    const g = groupPanoFrames([twoToOne, gpano, lost]);
    expect(g.ready.map((f) => f.file)).toEqual(['D:/Pano/a.jpg', 'D:/Pano/b.jpg', 'D:/Pano/c.jpg']);
    expect(g.skipped).toEqual([]);
    expect(isReadyMadePano({ file: 'x', bytes: 1, width: 5472, height: 3648 })).toBe(false);
  });

  it('keeps a ground 360 without GPS as an unplaced ready-made panorama', () => {
    const g = groupPanoFrames([{ file: 'g.jpg', bytes: 1, width: 2560, height: 1280 }]);
    expect(g.ready).toHaveLength(1);
    expect(g.ready[0]?.lat).toBeUndefined();
    expect(g.skipped).toEqual([]);
  });

  it('treats a 360 with only half a position as unplaced (no lat without lon)', () => {
    const g = groupPanoFrames([
      { file: 'a.jpg', bytes: 1, width: 2560, height: 1280, lat: LAT },
      { file: 'b.jpg', bytes: 1, width: 2560, height: 1280, lon: LON },
    ]);
    expect(g.ready.map((f) => [f.file, f.lat, f.lon])).toEqual([
      ['a.jpg', undefined, undefined],
      ['b.jpg', undefined, undefined],
    ]);
    expect(g.ready.every((f) => !('lat' in f) && !('lon' in f))).toBe(true);
  });

  it('skips a dual-fisheye Insta360 still instead of taking it as a 360 (Review Focus 1)', () => {
    const g = groupPanoFrames([
      { file: 'IMG_1.insp', bytes: 1, width: 6080, height: 3040, dualFisheye: true },
      { file: 'IMG_2.insp', bytes: 1, width: 6080, height: 3040 },
    ]);
    expect(g.ready.map((f) => f.file)).toEqual(['IMG_2.insp']);
    expect(g.skipped).toEqual([{ file: 'IMG_1.insp', reason: 'dual-fisheye' }]);
  });

  it('places a sphere at the median of its frames and starts it at its first frame', () => {
    const a = sphere({ start: t0, eastM: 40, northM: -30, firstNo: 1, pattern: 'rows' });
    const s = must(groupPanoFrames(a).spheres[0]);
    expect(
      horizontalM({ lat: s.lat, lon: s.lon }, { lat: LAT + north(-30), lon: LON + east(40) }),
    ).toBeLessThan(0.6);
    expect(s.relAlt).toBeCloseTo(70, 0);
    expect(s.startedAt).toBe('2026-09-10T10:00:00');
    expect(s.bytes).toBe(25 * 11_000_000);
  });

  it('keeps its thresholds in one table (tuned by P0)', () => {
    expect(PANO_GROUPING).toMatchObject({
      maxHorizontalM: 5,
      maxVerticalM: 3,
      maxGapS: 30,
      minFrames: 8,
      minYawSpanDeg: 270,
      minWideYawSpanDeg: 150,
      minPitchRows: 2,
      pitchRowToleranceDeg: 8,
    });
  });
});
