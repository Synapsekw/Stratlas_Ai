import { projectToLocal } from '@aio/geo';
import { ReportViewsFrame, type Vec3 } from '@aio/schema';
import { OrthographicCamera, PerspectiveCamera, Vector3 } from 'three';
import { describe, expect, it, vi } from 'vitest';
import {
  captureViews,
  pictureRun,
  planShots,
  type CaptureRequest,
  type CaptureStage,
  type PictureSurface,
} from './captureViews';
import { pixelOf } from './framing';

const ORIGIN: Vec3 = [500_000, 2_000_000, 40];

const ring = (e: number, n: number, r: number, z = 45): [number, number, number][] => [
  [e - r, n - r, z],
  [e + r, n - r, z],
  [e + r, n + r, z],
  [e - r, n + r, z],
];

const REQ: CaptureRequest = {
  projectId: 'p1',
  dates: ['c-jan', 'c-feb', 'c-mar'],
  pair: { from: 'c-feb', to: 'c-mar' },
  piles: [
    { id: 'm-a', points: ring(500_100, 2_000_100, 10) },
    {
      id: 'm-b',
      points: ring(500_200, 2_000_150, 8, 50),
      outlines: [{ capture: 'c-jan', points: ring(500_190, 2_000_150, 6, 50) }],
    },
  ],
  fingerprint: 'fp-1',
  maxSide: 1000,
};

interface Call {
  op: string;
  arg?: unknown;
}

function fakeStage(over: Partial<CaptureStage> = {}) {
  const calls: Call[] = [];
  const state = { date: 'c-feb', surface: 'photo' as PictureSurface, labels: true };
  const shots: {
    camera: PerspectiveCamera | OrthographicCamera;
    w: number;
    h: number;
    q: number;
  }[] = [];
  const stage: CaptureStage = {
    origin: ORIGIN,
    view: { fovDeg: 50, aspect: 1.6 },
    save: () => {
      calls.push({ op: 'save' });
      return { ...state };
    },
    restore: (token) => {
      calls.push({ op: 'restore', arg: token });
      Object.assign(state, token);
    },
    prepare: () => {
      calls.push({ op: 'prepare' });
      state.labels = false;
    },
    showDate: (c) => {
      calls.push({ op: 'date', arg: c });
      state.date = c;
    },
    showSurface: (s, at) => {
      calls.push({ op: 'surface', arg: [s, at.capture, at.pair?.from ?? null] });
      state.surface = s;
      return Promise.resolve(true);
    },
    aim: (pose) => {
      calls.push({ op: 'aim', arg: pose });
    },
    settle: (timeoutMs, what) => {
      calls.push({ op: 'settle', arg: [what, timeoutMs] });
      return Promise.resolve();
    },
    shoot: (camera, w, h, q) => {
      calls.push({ op: 'shoot', arg: [state.date, state.surface] });
      shots.push({ camera, w, h, q });
      return Promise.resolve(new Uint8Array([0xff, 0xd8, shots.length]));
    },
    ...over,
  };
  return { stage, calls, shots, state };
}

describe('planShots', () => {
  it('takes per date a photo, an elevation and a 3D view, and the compared pair once', () => {
    const shots = planShots(REQ.dates, REQ.pair);
    expect(shots.map((s) => s.file)).toEqual([
      'photo-1.jpg',
      '3d-1.jpg',
      'elevation-1.jpg',
      'photo-2.jpg',
      '3d-2.jpg',
      'elevation-2.jpg',
      'photo-3.jpg',
      '3d-3.jpg',
      'elevation-3.jpg',
      'cutfill.jpg',
    ]);
    expect(shots.at(-1)).toMatchObject({ kind: 'cutfill', capture: 'c-mar', pair: 'c-feb' });
    for (const s of shots) expect(s.file).toMatch(/^[a-z0-9-]{1,80}\.jpg$/);
  });

  it('keeps the newest dates when there are more than 64 pictures could hold', () => {
    const dates = Array.from({ length: 30 }, (_, i) => `c${String(i)}`);
    const shots = planShots(dates, null);
    expect(shots.length).toBeLessThanOrEqual(64);
    expect(shots[0]?.capture).toBe('c9');
    expect(shots.at(-1)?.capture).toBe('c29');
  });
});

describe('captureViews', () => {
  it('sets each date and surface in turn and saves the pictures with their frame', async () => {
    const { stage, calls, shots } = fakeStage();
    const save = vi.fn(() => Promise.resolve({ ok: true }));
    const r = await captureViews(REQ, stage, { save });
    expect(r.ok).toBe(true);
    expect(calls.filter((c) => c.op === 'shoot').map((c) => c.arg)).toEqual([
      ['c-jan', 'photo'],
      ['c-jan', 'photo'],
      ['c-jan', 'elev'],
      ['c-feb', 'photo'],
      ['c-feb', 'photo'],
      ['c-feb', 'elev'],
      ['c-mar', 'photo'],
      ['c-mar', 'photo'],
      ['c-mar', 'elev'],
      ['c-mar', 'change'],
    ]);
    expect(
      calls.find((c) => c.op === 'surface' && (c.arg as string[])[0] === 'change')?.arg,
    ).toEqual(['change', 'c-mar', 'c-feb']);
    // labels off and nothing selected before the first shot
    expect(calls.findIndex((c) => c.op === 'prepare')).toBeLessThan(
      calls.findIndex((c) => c.op === 'shoot'),
    );
    // waits for the tiles before each shot, and the heat map before the cut and fill
    expect(calls.filter((c) => c.op === 'settle').length).toBeGreaterThanOrEqual(shots.length);
    expect(calls.some((c) => c.op === 'settle' && (c.arg as string[])[0] === 'heat')).toBe(true);

    expect(save).toHaveBeenCalledTimes(1);
    const [frame, files] = save.mock.calls[0] as unknown as [
      ReportViewsFrame,
      { name: string; data: Uint8Array }[],
    ];
    expect(ReportViewsFrame.safeParse(frame).success).toBe(true);
    expect(frame.fingerprint).toBe('fp-1');
    expect(frame.views.map((v) => v.file)).toEqual(files.map((f) => f.name));
    expect(frame.views.find((v) => v.kind === 'cutfill')).toMatchObject({
      capture: 'c-mar',
      pair: 'c-feb',
    });
    expect(Math.max(frame.widthPx, frame.heightPx)).toBe(1000);
    // the yard's extent: the piles plus margin, whole pixels
    const [e0, n0, e1, n1] = frame.extent;
    expect(e0).toBeLessThan(500_090);
    expect(e1).toBeGreaterThan(500_208);
    expect((e1 - e0) / frame.mPerPx).toBeCloseTo(frame.widthPx, 6);
    expect((n1 - n0) / frame.mPerPx).toBeCloseTo(frame.heightPx, 6);
    expect(files[0]?.data).toEqual(new Uint8Array([0xff, 0xd8, 1]));
  });

  it('renders top-down shots at the frame size through a camera straight down, at the spec quality', async () => {
    const { stage, shots } = fakeStage();
    let frame: ReportViewsFrame | null = null;
    await captureViews(REQ, stage, {
      save: (f) => {
        frame = f;
        return Promise.resolve({ ok: true });
      },
    });
    expect(frame).not.toBeNull();
    const f = frame as unknown as ReportViewsFrame;
    const photo = shots[0];
    const elev = shots[2];
    const three = shots[1];
    const cut = shots[9];
    expect(photo?.camera).toBeInstanceOf(OrthographicCamera);
    expect([photo?.w, photo?.h]).toEqual([f.widthPx, f.heightPx]);
    expect(photo?.q).toBe(0.8);
    expect(elev?.q).toBe(0.88);
    expect(cut?.q).toBe(0.88);
    expect(three?.q).toBe(0.8);
    expect(three?.camera).toBeInstanceOf(PerspectiveCamera);
    const dir = photo?.camera.getWorldDirection(new Vector3());
    expect(dir?.y).toBeCloseTo(-1, 9);
    // a site point lands on the pixel the frame says
    const p = projectToLocal([500_100, 2_000_100, 45], ORIGIN);
    const px = photo ? pixelOf(photo.camera, p, photo.w, photo.h) : null;
    expect(px?.[0]).toBeCloseTo((500_100 - f.extent[0]) / f.mPerPx, 6);
    expect(px?.[1]).toBeCloseTo((f.extent[3] - 2_000_100) / f.mPerPx, 6);
  });

  it('records where the 3D camera saw each pile centre, on that date’s outline', async () => {
    const { stage, shots } = fakeStage();
    let frame: ReportViewsFrame | null = null;
    await captureViews(REQ, stage, {
      save: (f) => {
        frame = f;
        return Promise.resolve({ ok: true });
      },
    });
    const f = frame as unknown as ReportViewsFrame;
    const jan = shots[1];
    expect(jan).toBeDefined();
    if (!jan) return;
    const want = pixelOf(
      jan.camera,
      projectToLocal([500_190, 2_000_150, 50], ORIGIN),
      jan.w,
      jan.h,
    );
    expect(f.markers3d['c-jan']?.['m-b']?.[0]).toBeCloseTo(want?.[0] ?? NaN, 6);
    expect(f.markers3d['c-jan']?.['m-b']?.[1]).toBeCloseTo(want?.[1] ?? NaN, 6);
    expect(Object.keys(f.markers3d['c-mar'] ?? {}).sort()).toEqual(['m-a', 'm-b']);
  });

  it('uses the height under a pile centre when the stage can say it', async () => {
    const { stage, shots } = fakeStage({ heightAt: () => 58 });
    let frame: ReportViewsFrame | null = null;
    await captureViews(REQ, stage, {
      save: (f) => {
        frame = f;
        return Promise.resolve({ ok: true });
      },
    });
    const f = frame as unknown as ReportViewsFrame;
    const jan = shots[1];
    if (!jan) throw new Error('no 3D shot');
    const want = pixelOf(
      jan.camera,
      projectToLocal([500_100, 2_000_100, 58], ORIGIN),
      jan.w,
      jan.h,
    );
    expect(f.markers3d['c-jan']?.['m-a']?.[1]).toBeCloseTo(want?.[1] ?? NaN, 6);
  });

  it('skips a surface a date does not have', async () => {
    const { stage } = fakeStage({
      showSurface: (s, at) => Promise.resolve(!(s === 'elev' && at.capture === 'c-jan')),
    });
    let frame: ReportViewsFrame | null = null;
    await captureViews(REQ, stage, {
      save: (f) => {
        frame = f;
        return Promise.resolve({ ok: true });
      },
    });
    const f = frame as unknown as ReportViewsFrame;
    expect(f.views.map((v) => v.file)).not.toContain('elevation-1.jpg');
    expect(f.views.map((v) => v.file)).toContain('elevation-2.jpg');
  });

  it('puts everything back after the run', async () => {
    const { stage, calls, state } = fakeStage();
    await captureViews(REQ, stage, { save: () => Promise.resolve({ ok: true }) });
    expect(calls.at(-1)?.op).toBe('restore');
    expect(state).toEqual({ date: 'c-feb', surface: 'photo', labels: true });
  });

  it('puts everything back and saves nothing when a shot throws', async () => {
    let n = 0;
    const { stage, calls, state } = fakeStage();
    const shoot = stage.shoot.bind(stage);
    stage.shoot = (...a) => {
      n++;
      if (n === 4) return Promise.reject(new Error('context lost'));
      return shoot(...a);
    };
    const save = vi.fn(() => Promise.resolve({ ok: true }));
    const r = await captureViews(REQ, stage, { save });
    expect(r).toEqual({ ok: false, error: 'context lost' });
    expect(save).not.toHaveBeenCalled();
    expect(calls.at(-1)?.op).toBe('restore');
    expect(state).toEqual({ date: 'c-feb', surface: 'photo', labels: true });
    expect(pictureRun.getState().running).toBe(false);
  });

  it('reports progress and refuses a second run while one is going', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const { stage } = fakeStage({ settle: () => gate });
    const seen: [number, number][] = [];
    const first = captureViews(REQ, stage, {
      save: () => Promise.resolve({ ok: true }),
      onProgress: (done, total) => seen.push([done, total]),
    });
    await Promise.resolve();
    expect(pictureRun.getState()).toMatchObject({ running: true, done: 0, total: 10 });
    const second = await captureViews(REQ, fakeStage().stage, {
      save: () => Promise.resolve({ ok: true }),
    });
    expect(second.ok).toBe(false);
    release();
    expect((await first).ok).toBe(true);
    expect(seen.at(-1)).toEqual([10, 10]);
    expect(pictureRun.getState().running).toBe(false);
  });

  it('refuses without a pile and passes a failed save on', async () => {
    const none = await captureViews({ ...REQ, piles: [] }, fakeStage().stage, {
      save: () => Promise.resolve({ ok: true }),
    });
    expect(none.ok).toBe(false);
    const failed = await captureViews(REQ, fakeStage().stage, {
      save: () => Promise.resolve({ ok: false, error: 'disk full' }),
    });
    expect(failed).toEqual({ ok: false, error: 'disk full' });
  });
});
