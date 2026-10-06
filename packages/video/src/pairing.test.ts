import type { Layer, LensModel, PoseSample, Quat, Vec3 } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import type { Flight } from './flight';
import { biasQuat } from './orientation';
import {
  applyHomography,
  calibratedVideoPose,
  createViewFollower,
  footprintOverlap,
  groundFootprint,
  groundHomography,
  homographyCss,
  matchView,
  pairsFor,
  viewDirection,
  viewSources,
  type ViewPose,
  type ViewSource,
} from './pairing';

type VideoLayer = Extract<Layer, { kind: 'video' }>;
type PhotoLayer = Extract<Layer, { kind: 'photos' }>;

const PIN: LensModel = { model: 'pinhole', hfovDeg: 70, aspect: 1.5 };
const FPS = 30;
/** Heading east (camera -Z turned to +X), pitched 60 degrees down. */
const EAST_DOWN: Quat = biasQuat({ yawDeg: -90, pitchDeg: -60, rollDeg: 0 });

/** A straight flight east at `y` metres: x = x0 + speed * t (s), sampled at 10 Hz. */
function flight(x0: number, speed: number, z: number, y: number, seconds: number, q = EAST_DOWN) {
  const samples: PoseSample[] = [];
  for (let i = 0; i <= seconds * 10; i++) {
    const t = i * 100;
    samples.push({ t, pos: [x0 + (speed * t) / 1000, y, z], q });
  }
  const f: Flight = {
    schema: 'aio.flight/1',
    startUtcMs: 1_700_000_000_000,
    lens: PIN,
    samples,
    durationMs: seconds * 1000,
  };
  return f;
}

function videoLayer(id: string, f: Flight, extra: Partial<VideoLayer> = {}): VideoLayer {
  return {
    kind: 'video',
    id,
    name: id,
    visible: true,
    opacity: 1,
    src: { path: `video/${id}.mp4` },
    flight: { src: { path: `video/${id}.json` }, startUtcMs: f.startUtcMs },
    lens: PIN,
    offsetMs: 0,
    ...extra,
  } as VideoLayer;
}

const photo = (id: string, pos: Vec3, q: Quat = EAST_DOWN) => ({
  id,
  src: { path: `photos/${id}.jpg` },
  pos,
  q,
  lens: PIN,
});

function photoLayer(id: string, items: ReturnType<typeof photo>[], capture?: string): PhotoLayer {
  return {
    kind: 'photos',
    id,
    name: id,
    visible: true,
    opacity: 1,
    items,
    ...(capture ? { capture } : {}),
  } as PhotoLayer;
}

describe('view geometry', () => {
  it('turns a camera quaternion into its view direction', () => {
    const d = viewDirection(EAST_DOWN);
    expect(d[0]).toBeCloseTo(Math.cos(Math.PI / 3), 6);
    expect(d[1]).toBeCloseTo(-Math.sin(Math.PI / 3), 6);
    expect(d[2]).toBeCloseTo(0, 6);
  });

  it('puts a nadir camera footprint around the point below it', () => {
    const nadir = biasQuat({ yawDeg: 0, pitchDeg: -90, rollDeg: 0 });
    const fp = groundFootprint({ pos: [10, 20, -5], q: nadir, lens: PIN });
    if (!fp) throw new Error('no footprint');
    const xs = fp.map((p) => p[0]);
    const zs = fp.map((p) => p[1]);
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
    const cz = (Math.min(...zs) + Math.max(...zs)) / 2;
    expect(cx).toBeCloseTo(10, 3);
    expect(cz).toBeCloseTo(-5, 3);
  });

  it('measures footprint overlap: one for the same view, none for views apart', () => {
    const a: ViewPose = { pos: [0, 30, 0], q: EAST_DOWN, lens: PIN };
    expect(footprintOverlap(a, a)).toBeCloseTo(1, 6);
    const far: ViewPose = { ...a, pos: [2000, 30, 0] };
    expect(footprintOverlap(a, far)).toBe(0);
    const near: ViewPose = { ...a, pos: [5, 30, 0] };
    const o = footprintOverlap(a, near);
    expect(o).toBeGreaterThan(0.5);
    expect(o).toBeLessThan(1);
  });

  it('applies the video calibration (position offset and orientation bias)', () => {
    const f = flight(0, 5, 0, 30, 10);
    const plain = calibratedVideoPose(videoLayer('v', f), f, 2);
    expect(plain.pos[0]).toBeCloseTo(10, 6);
    const cal = calibratedVideoPose(
      videoLayer('v', f, {
        positionOffsetM: [0, -20, 0],
        orientation: { yawDeg: 0, pitchDeg: -30, rollDeg: 0 },
        offsetMs: 1000,
      }),
      f,
      2,
    );
    // video 2 s is flight 3 s with the clip starting 1 s into the log
    expect(cal.pos[0]).toBeCloseTo(15, 6);
    expect(cal.pos[1]).toBeCloseTo(10, 6);
    // 60 down plus 30 more: straight down
    expect(viewDirection(cal.q)[1]).toBeCloseTo(-1, 6);
  });
});

describe('same view on the other date', () => {
  // date A: x = -50 + 5 t; date B (another day): x = -60 + 4 t, 0.8 m south and 1 m higher
  const fa = flight(-50, 5, 0, 30, 20);
  const fb = flight(-60, 4, 0.8, 31, 30);
  const va = videoLayer('va', fa);
  const vb = videoLayer('vb', fb, { offsetMs: 2000 });
  const sourcesB: ViewSource[] = [{ kind: 'video', layer: vb, flight: fb }];

  it('finds the frame of the other flight at the same place, to the frame', () => {
    for (const vA of [1, 4.5, 9.9, 15]) {
      const target = calibratedVideoPose(va, fa, vA);
      const m = matchView(target, sourcesB);
      if (!m) throw new Error('no match');
      // truth: same x; B's log runs 2 s ahead of its clip
      const xA = -50 + 5 * vA;
      const vB = (xA + 60) / 4 - 2;
      expect(m.ref.layer).toBe('vb');
      expect(Math.abs((m.ref.t ?? -1) - vB)).toBeLessThanOrEqual(1 / FPS + 1e-9);
      expect(m.distanceM).toBeCloseTo(Math.hypot(0.8, 1), 1);
      expect(m.angleDeg).toBeLessThan(0.01);
    }
  });

  it('finds no pair when the footprints do not overlap', () => {
    const away = calibratedVideoPose(videoLayer('far', flight(5000, 5, 0, 30, 5)), fa, 1);
    expect(matchView({ ...away, pos: [5000, 30, 4000] }, sourcesB)).toBeNull();
  });

  it('rejects a view that looks the other way', () => {
    const west = biasQuat({ yawDeg: 90, pitchDeg: -60, rollDeg: 0 });
    const target: ViewPose = { pos: [0, 30, 0], q: west, lens: PIN };
    expect(matchView(target, sourcesB)).toBeNull();
    // unless the person allows any angle
    expect(matchView(target, sourcesB, { maxAngleDeg: 180, minOverlap: 0 })).not.toBeNull();
  });

  it('picks the closest photo of the other date', () => {
    const b = photoLayer('pb', [photo('b1', [0, 30, 0]), photo('b2', [8, 30, 0.5])]);
    const target: ViewPose = { pos: [7.5, 30, 0], q: EAST_DOWN, lens: PIN };
    const m = matchView(target, [{ kind: 'photos', layer: b }]);
    expect(m?.ref).toEqual({ layer: 'pb', photo: 'b2' });
    expect(m?.distanceM).toBeCloseTo(Math.hypot(0.5, 0.5), 6);
  });

  it('skips photos without a pose', () => {
    const b = photoLayer('pb', [{ id: 'nopose', src: { path: 'photos/n.jpg' } } as never]);
    expect(
      matchView({ pos: [0, 30, 0], q: EAST_DOWN, lens: PIN }, [{ kind: 'photos', layer: b }]),
    ).toBeNull();
  });
});

describe('pairsFor', () => {
  const fa = flight(-50, 5, 0, 30, 20);
  const fb = flight(-60, 4, 0.8, 31, 30);
  const layers: Layer[] = [
    photoLayer(
      'photos-a',
      [photo('a1', [0, 30, 0]), photo('a2', [40, 30, 0]), photo('a3', [900, 30, 0])],
      'c1',
    ),
    photoLayer('photos-b', [photo('b1', [0.5, 30, 0.2]), photo('b2', [39, 30, 0])]),
    videoLayer('va', fa),
    videoLayer('vb', fb),
  ];
  const captureOf: Record<string, string> = { 'photos-b': 'c2', va: 'c1', vb: 'c2' };
  const flights = new Map([
    ['va', fa],
    ['vb', fb],
  ]);

  it('sorts layers by date, the explicit capture first', () => {
    const a = viewSources(layers, 'c1', captureOf, flights);
    expect(a.map((s) => s.layer.id)).toEqual(['photos-a', 'va']);
    const b = viewSources(layers, 'c2', captureOf, flights);
    expect(b.map((s) => s.layer.id)).toEqual(['photos-b', 'vb']);
  });

  it('pairs each photo of date A with its best view of date B, none when nothing overlaps', () => {
    const pairs = pairsFor('c1', 'c2', { layers, captureOf, flights }, { photosOnly: true });
    expect(pairs.map((p) => [p.a, p.b])).toEqual([
      [
        { layer: 'photos-a', photo: 'a1' },
        { layer: 'photos-b', photo: 'b1' },
      ],
      [
        { layer: 'photos-a', photo: 'a2' },
        { layer: 'photos-b', photo: 'b2' },
      ],
    ]);
    expect(pairs[0]?.poseM).toBeCloseTo(Math.hypot(0.5, 0.2), 6);
  });

  it('pairs video frames of date A every step with frames of date B', () => {
    const pairs = pairsFor('c1', 'c2', { layers, captureOf, flights }, { videoStepS: 5 });
    const frames = pairs.filter((p) => p.a.layer === 'va');
    expect(frames.map((p) => p.a.t)).toEqual([0, 5, 10, 15, 20]);
    for (const p of frames) {
      const xA = -50 + 5 * (p.a.t ?? 0);
      const best = Math.min(Math.abs(xA - 0), Math.abs(xA - 39));
      // a frame or a photo of B, whichever is closer
      if (p.b.layer === 'vb') expect(Math.abs((p.b.t ?? 0) - (xA + 60) / 4)).toBeLessThan(0.05);
      else expect(best).toBeLessThan(1);
    }
  });
});

describe('scrub follow', () => {
  it('follows date A along the flight and stays on the same clip', () => {
    const fa = flight(-50, 5, 0, 30, 20);
    const fb = flight(-60, 4, 0.8, 31, 30);
    const fb2 = flight(-60, 4, 40, 31, 30); // a parallel strip 40 m away
    const va = videoLayer('va', fa);
    const follow = createViewFollower([
      { kind: 'video', layer: videoLayer('vb', fb), flight: fb },
      { kind: 'video', layer: videoLayer('vb2', fb2), flight: fb2 },
    ]);
    let last = -Infinity;
    for (let v = 0; v <= 20; v += 0.5) {
      const m = follow(calibratedVideoPose(va, fa, v));
      expect(m?.ref.layer).toBe('vb');
      const t = m?.ref.t ?? -1;
      expect(t).toBeGreaterThanOrEqual(last);
      last = t;
    }
    // the same pose twice is answered from the cache
    const p = calibratedVideoPose(va, fa, 3);
    expect(follow(p)).toBe(follow(p));
  });
});

describe('ground homography', () => {
  it('is the identity for the same pose', () => {
    const a: ViewPose = { pos: [0, 30, 0], q: EAST_DOWN, lens: PIN };
    const H = groundHomography(a, a);
    if (!H) throw new Error('no homography');
    const [x, y] = applyHomography(H, 0.3, 0.7);
    expect(x).toBeCloseTo(0.3, 6);
    expect(y).toBeCloseTo(0.7, 6);
  });

  it('maps a ground point seen by one camera to where the other sees it', () => {
    const nadir = biasQuat({ yawDeg: 0, pitchDeg: -90, rollDeg: 0 });
    const a: ViewPose = { pos: [0, 30, 0], q: nadir, lens: PIN };
    const b: ViewPose = {
      pos: [3, 32, 1],
      q: biasQuat({ yawDeg: 4, pitchDeg: -85, rollDeg: 1 }),
      lens: PIN,
    };
    const H = groundHomography(a, b);
    if (!H) throw new Error('no homography');
    // the ground point below camera A (image centre of A): where is it in B?
    const ground: Vec3 = [0, 0, 0];
    const inB = projectToImage(b, ground);
    const [x, y] = applyHomography(H, 0.5, 0.5);
    expect(x).toBeCloseTo(inB[0], 4);
    expect(y).toBeCloseTo(inB[1], 4);
  });

  it('writes a CSS matrix that moves pixels like the homography', () => {
    const H = [1.1, 0.05, 0.02, -0.03, 0.95, 0.01, 0.1, -0.05, 1] as const;
    const css = homographyCss(H, 640, 480);
    const raw = /matrix3d\(([^)]+)\)/.exec(css)?.[1]?.split(',').map(Number) ?? [];
    expect(raw).toHaveLength(16);
    const m = (i: number) => raw[i] ?? NaN;
    // column-major 4x4 acting on (px, py, 0, 1)
    const px = 200;
    const py = 100;
    const X = m(0) * px + m(4) * py + m(12);
    const Y = m(1) * px + m(5) * py + m(13);
    const W = m(3) * px + m(7) * py + m(15);
    const [nx, ny] = applyHomography(H, px / 640, py / 480);
    expect(X / W).toBeCloseTo(nx * 640, 6);
    expect(Y / W).toBeCloseTo(ny * 480, 6);
  });
});

/** Normalised image point of a world point (test helper, independent of the module). */
function projectToImage(v: ViewPose, p: Vec3): [number, number] {
  const [qx, qy, qz, qw] = v.q;
  const d: Vec3 = [p[0] - v.pos[0], p[1] - v.pos[1], p[2] - v.pos[2]];
  // rotate by the conjugate quaternion
  const cx = -qx;
  const cy = -qy;
  const cz = -qz;
  const tx = 2 * (cy * d[2] - cz * d[1]);
  const ty = 2 * (cz * d[0] - cx * d[2]);
  const tz = 2 * (cx * d[1] - cy * d[0]);
  const c: Vec3 = [
    d[0] + qw * tx + (cy * tz - cz * ty),
    d[1] + qw * ty + (cz * tx - cx * tz),
    d[2] + qw * tz + (cx * ty - cy * tx),
  ];
  const tH = Math.tan((PIN.hfovDeg * Math.PI) / 360);
  const nx = c[0] / -c[2] / tH;
  const ny = (c[1] / -c[2] / tH) * PIN.aspect;
  return [(nx + 1) / 2, (1 - ny) / 2];
}
