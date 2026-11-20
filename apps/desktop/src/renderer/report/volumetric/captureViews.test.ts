import { projectToLocal } from '@aio/geo';
import { ReportViewsFrame, type Vec3 } from '@aio/schema';
import { OrthographicCamera, PerspectiveCamera, Vector3 } from 'three';
import { describe, expect, it, vi } from 'vitest';
import {
  captureViews,
  pictureRun,
  picturesStopped,
  planShots,
  resetPictureStop,
  stopPictures,
  type CaptureRequest,
  type CaptureStage,
  type PictureSurface,
} from './captureViews';
import { pixelOf } from './framing';

/** The pile pictures of `REQ`: two piles, each a photo on two dates and one 3D picture. */
const PILE_SHOTS = 6;
/** The fake stage as the person left it. */
const HOME = { date: 'c-feb', surface: 'photo', labels: true, outlines: true, pinned: null };

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
  const state = {
    date: 'c-feb',
    surface: 'photo' as PictureSurface,
    labels: true,
    outlines: true,
    pinned: null as string | null,
  };
  const shots: {
    camera: PerspectiveCamera | OrthographicCamera;
    w: number;
    h: number;
    q: number;
    date: string;
    outlines: boolean;
    pinned: string | null;
    label: string;
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
      shots.push({
        camera,
        w,
        h,
        q,
        date: state.date,
        outlines: state.outlines,
        pinned: state.pinned,
        label: pictureRun.getState().label,
      });
      return Promise.resolve(new Uint8Array([0xff, 0xd8, shots.length]));
    },
    openPile: (id, capture) => {
      calls.push({ op: 'open', arg: [id, capture ?? null] });
      state.pinned = id;
      return Promise.resolve(true);
    },
    showOutlines: (on) => {
      calls.push({ op: 'outlines', arg: on });
      state.outlines = on;
    },
    ...over,
  };
  return { stage, calls, shots, state };
}

describe('planShots', () => {
  it('takes per date a photo, an elevation and a 3D view, and the compared pair once', () => {
    const { shots } = planShots(REQ.dates, REQ.pair);
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

  it('keeps the newest dates when there are more than 512 pictures could hold', () => {
    const dates = Array.from({ length: 200 }, (_, i) => `c${String(i)}`);
    const { shots } = planShots(dates, null);
    expect(shots.length).toBeLessThanOrEqual(512);
    expect(shots[0]?.capture).toBe('c30');
    expect(shots.at(-1)?.capture).toBe('c199');
  });

  it('pictures each pile straight down on the compared and the latest date and in 3D on the latest', () => {
    const { shots, unpictured } = planShots(REQ.dates, REQ.pair, ['m-a', 'm-b']);
    expect(unpictured).toEqual([]);
    expect(shots.map((s) => s.file)).toEqual([
      'photo-1.jpg',
      '3d-1.jpg',
      'elevation-1.jpg',
      'photo-2.jpg',
      '3d-2.jpg',
      'pile-1-photo-2.jpg',
      'pile-2-photo-2.jpg',
      'elevation-2.jpg',
      'photo-3.jpg',
      '3d-3.jpg',
      'pile-1-photo-3.jpg',
      'pile-2-photo-3.jpg',
      'pile-1-3d.jpg',
      'pile-2-3d.jpg',
      'elevation-3.jpg',
      'cutfill.jpg',
    ]);
    for (const s of shots) expect(s.file).toMatch(/^[a-z0-9-]{1,80}\.jpg$/);
    const threeD = shots.filter((s) => s.kind === 'pile-3d');
    expect(threeD.map((s) => [s.pile, s.capture])).toEqual([
      ['m-a', 'c-mar'],
      ['m-b', 'c-mar'],
    ]);
    expect(shots.filter((s) => s.kind === 'pile-photo').map((s) => s.capture)).toEqual([
      'c-feb',
      'c-feb',
      'c-mar',
      'c-mar',
    ]);
  });

  it('takes each date in one go, so its layers load once', () => {
    const { shots } = planShots(REQ.dates, REQ.pair, ['m-a', 'm-b']);
    const order = shots.map((s) => s.capture).filter((c, i, all) => c !== all[i - 1]);
    expect(order).toEqual(['c-jan', 'c-feb', 'c-mar']);
    // also when the compared pair is not the newest two dates
    const odd = planShots(REQ.dates, { from: 'c-jan', to: 'c-feb' }, ['m-a']).shots;
    const seen = odd.map((s) => s.capture).filter((c, i, all) => c !== all[i - 1]);
    expect(seen).toEqual(['c-jan', 'c-feb', 'c-mar']);
    expect(odd.find((s) => s.kind === 'pile-3d')?.capture).toBe('c-feb');
  });

  it('pictures one date once per pile without a compared date', () => {
    const { shots } = planShots(['c-mar'], null, ['m-a']);
    expect(shots.map((s) => s.file)).toEqual([
      'photo-1.jpg',
      '3d-1.jpg',
      'pile-1-photo-1.jpg',
      'pile-1-3d.jpg',
      'elevation-1.jpg',
    ]);
  });

  it('gives pictures to the first piles that fit and names the rest', () => {
    const ids = Array.from({ length: 200 }, (_, i) => `m-${String(i)}`);
    const { shots, unpictured } = planShots(['c-feb', 'c-mar'], REQ.pair, ids);
    expect(shots.length).toBeLessThanOrEqual(512);
    expect(new Set(shots.flatMap((s) => (s.pile ? [s.pile] : []))).size).toBe(168);
    expect(unpictured).toEqual(ids.slice(168));
    expect(new Set(shots.map((s) => s.file)).size).toBe(shots.length);
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
      ['c-feb', 'photo'],
      ['c-feb', 'photo'],
      ['c-feb', 'elev'],
      ['c-mar', 'photo'],
      ['c-mar', 'photo'],
      ['c-mar', 'photo'],
      ['c-mar', 'photo'],
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
    const cut = shots.at(-1);
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

  it('saves the cut and fill settings the heat map was drawn with, read at the shot', async () => {
    const style = { stops: [{ value: -1, color: '#ff0000' }], stepped: true, inverted: false };
    let read: string | null = null;
    const { stage, state } = fakeStage({
      cutFillSettings: () => {
        read = state.surface;
        return { thresholdM: 0.25, rangeM: 3, style };
      },
    });
    let frame: ReportViewsFrame | null = null;
    await captureViews(REQ, stage, {
      save: (f) => {
        frame = f;
        return Promise.resolve({ ok: true });
      },
    });
    expect(read).toBe('change');
    expect((frame as unknown as { cutFill: unknown }).cutFill).toEqual({
      thresholdM: 0.25,
      rangeM: 3,
      style,
    });
  });

  it('saves no cut and fill settings without a cut and fill picture', async () => {
    const { stage } = fakeStage({
      cutFillSettings: () => ({ thresholdM: 0.25, rangeM: 3 }),
    });
    let frame: ReportViewsFrame | null = null;
    await captureViews({ ...REQ, pair: null }, stage, {
      save: (f) => {
        frame = f;
        return Promise.resolve({ ok: true });
      },
    });
    expect(frame).not.toHaveProperty('cutFill');
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
    expect(state).toEqual(HOME);
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
    expect(state).toEqual(HOME);
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
    expect(pictureRun.getState()).toMatchObject({
      running: true,
      done: 0,
      total: 10 + PILE_SHOTS,
    });
    const second = await captureViews(REQ, fakeStage().stage, {
      save: () => Promise.resolve({ ok: true }),
    });
    expect(second.ok).toBe(false);
    release();
    expect((await first).ok).toBe(true);
    expect(seen.at(-1)).toEqual([10 + PILE_SHOTS, 10 + PILE_SHOTS]);
    expect(pictureRun.getState().running).toBe(false);
  });

  it('stops after the current shot when asked, saves nothing and puts everything back', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const { stage, calls, state } = fakeStage({ settle: () => gate });
    const save = vi.fn(() => Promise.resolve({ ok: true }));
    const run = captureViews(REQ, stage, { save });
    await Promise.resolve();
    expect(pictureRun.getState()).toMatchObject({ running: true, stopping: false });
    stopPictures();
    expect(pictureRun.getState().stopping).toBe(true);
    release();
    const r = await run;
    expect(r).toEqual({ ok: false, error: picturesStopped() });
    expect(save).not.toHaveBeenCalled();
    expect(calls.filter((c) => c.op === 'shoot').length).toBeLessThanOrEqual(1);
    expect(calls.at(-1)?.op).toBe('restore');
    expect(state).toEqual(HOME);
    expect(pictureRun.getState()).toMatchObject({ running: false, stopping: false });
  });

  it('a stop asked before the run starts takes no picture', async () => {
    const { stage, calls } = fakeStage();
    const save = vi.fn(() => Promise.resolve({ ok: true }));
    stopPictures();
    const r = await captureViews(REQ, stage, { save });
    expect(r).toEqual({ ok: false, error: picturesStopped() });
    expect(calls.filter((c) => c.op === 'shoot')).toHaveLength(0);
    expect(save).not.toHaveBeenCalled();
    expect(pictureRun.getState()).toMatchObject({ running: false, stopping: false });
    resetPictureStop();
  });

  it('a stop asked during the last shot still saves nothing', async () => {
    const { stage } = fakeStage();
    const shoot = stage.shoot.bind(stage);
    let n = 0;
    stage.shoot = (...a) => {
      n++;
      if (n === 10 + PILE_SHOTS) stopPictures();
      return shoot(...a);
    };
    const save = vi.fn(() => Promise.resolve({ ok: true }));
    const r = await captureViews(REQ, stage, { save });
    expect(n).toBe(10 + PILE_SHOTS);
    expect(r).toEqual({ ok: false, error: picturesStopped() });
    expect(save).not.toHaveBeenCalled();
  });

  it('a stop asked while the view comes back saves nothing', async () => {
    const { stage } = fakeStage();
    const restore = stage.restore.bind(stage);
    stage.restore = (token) => {
      stopPictures();
      return restore(token);
    };
    const save = vi.fn(() => Promise.resolve({ ok: true }));
    const r = await captureViews(REQ, stage, { save });
    expect(r).toEqual({ ok: false, error: picturesStopped() });
    expect(save).not.toHaveBeenCalled();
    expect(pictureRun.getState()).toMatchObject({ running: false, stopping: false });
  });

  it('counts as running until its save is done', async () => {
    let during: unknown = null;
    const save = vi.fn(() => {
      during = pictureRun.getState().running;
      return Promise.resolve({ ok: true });
    });
    const r = await captureViews(REQ, fakeStage().stage, { save });
    expect(r.ok).toBe(true);
    expect(during).toBe(true);
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

describe('captureViews, the pile pictures', () => {
  const run = async (stage: CaptureStage, req: CaptureRequest = REQ) => {
    let frame: ReportViewsFrame | null = null;
    const r = await captureViews(req, stage, {
      save: (f) => {
        frame = f;
        return Promise.resolve({ ok: true });
      },
    });
    return { r, frame: frame as unknown as ReportViewsFrame | null };
  };

  it('saves a photo per pictured date and a 3D picture per pile, as typed views', async () => {
    const { stage, shots } = fakeStage();
    const { r, frame } = await run(stage);
    expect(r).toMatchObject({ ok: true, unpictured: [] });
    if (!frame) throw new Error('no frame');
    expect(ReportViewsFrame.safeParse(frame).success).toBe(true);
    const photos = frame.views.filter((v) => v.kind === 'pile-photo');
    const threeD = frame.views.filter((v) => v.kind === 'pile-3d');
    expect(photos.map((v) => [v.pile, v.capture])).toEqual([
      ['m-a', 'c-feb'],
      ['m-b', 'c-feb'],
      ['m-a', 'c-mar'],
      ['m-b', 'c-mar'],
    ]);
    expect(threeD.map((v) => [v.pile, v.capture, v.extent])).toEqual([
      ['m-a', 'c-mar', undefined],
      ['m-b', 'c-mar', undefined],
    ]);
    // 800 x 600 at the photo quality, the photo straight down and the 3D picture at an angle
    const pile = shots.filter((s) => s.w === 800);
    expect(pile).toHaveLength(PILE_SHOTS);
    for (const s of pile) expect([s.h, s.q]).toEqual([600, 0.8]);
    expect(pile.filter((s) => s.camera instanceof OrthographicCamera)).toHaveLength(4);
    expect(pile.filter((s) => s.camera instanceof PerspectiveCamera)).toHaveLength(2);
  });

  it('gives the two photos of a pile one extent, and the picture covers exactly that ground', async () => {
    const { stage, shots } = fakeStage();
    const { frame } = await run(stage);
    const mine = frame?.views.filter((v) => v.kind === 'pile-photo' && v.pile === 'm-a') ?? [];
    expect(mine).toHaveLength(2);
    expect(mine[0]?.extent).toEqual(mine[1]?.extent);
    const [e0, n0, e1, n1] = mine[0]?.extent ?? [0, 0, 0, 0];
    expect((e1 - e0) / (n1 - n0)).toBeCloseTo(4 / 3, 9);
    // the ring (10 m around 500100, 2000100) lies inside with room to spare
    expect(e0).toBeLessThan(500_088);
    expect(e1).toBeGreaterThan(500_112);
    expect(n0).toBeLessThan(2_000_088);
    expect(n1).toBeGreaterThan(2_000_112);
    // the first pile photo: its top left pixel is the extent's north-west corner
    const shot = shots.find((s) => s.w === 800);
    if (!shot) throw new Error('no pile shot');
    const px = pixelOf(shot.camera, projectToLocal([e0, n1, 45], ORIGIN), 800, 600);
    expect(px?.[0]).toBeCloseTo(0, 6);
    expect(px?.[1]).toBeCloseTo(0, 6);
    const dir = shot.camera.getWorldDirection(new Vector3());
    expect(dir.y).toBeCloseTo(-1, 9);
  });

  it('frames a pile whose outline differs by date on both outlines', async () => {
    // m-b on c-jan is 6 m around 500190; compared with c-mar (8 m around 500200) both must fit
    const { stage } = fakeStage();
    const { frame } = await run(stage, { ...REQ, pair: { from: 'c-jan', to: 'c-mar' } });
    const mine = frame?.views.filter((v) => v.kind === 'pile-photo' && v.pile === 'm-b') ?? [];
    expect(mine.map((v) => v.capture)).toEqual(['c-jan', 'c-mar']);
    expect(mine[0]?.extent).toEqual(mine[1]?.extent);
    const [e0, , e1] = mine[0]?.extent ?? [0, 0, 0, 0];
    expect(e0).toBeLessThan(500_184);
    expect(e1).toBeGreaterThan(500_208);
  });

  it('takes the photo of a pile with the measurements’ own outlines off, and puts them back', async () => {
    const { stage, shots, state } = fakeStage();
    await run(stage);
    for (const s of shots) {
      const pilePhoto = s.w === 800 && s.camera instanceof OrthographicCamera;
      expect(s.outlines, s.label).toBe(!pilePhoto);
    }
    expect(state.outlines).toBe(true);
  });

  it('pins each pile on the latest date for its 3D picture, also a pile filed under an earlier date', async () => {
    const filed = {
      id: 'm-b',
      points: ring(500_200, 2_000_150, 8, 50),
      scope: { kind: 'survey', capture: 'c-jan' },
    };
    const { stage, calls, shots } = fakeStage();
    const { frame } = await run(stage, { ...REQ, piles: [REQ.piles[0], filed] as never });
    const opens = calls.filter((c) => c.op === 'open').map((c) => c.arg);
    expect(opens).toEqual([
      ['m-a', 'c-mar'],
      [null, null],
      ['m-b', 'c-mar'],
      [null, null],
    ]);
    const threeD = shots.filter((s) => s.w === 800 && s.camera instanceof PerspectiveCamera);
    expect(threeD.map((s) => [s.pinned, s.date])).toEqual([
      ['m-a', 'c-mar'],
      ['m-b', 'c-mar'],
    ]);
    // no other shot has a pile pinned
    expect(shots.filter((s) => s.pinned !== null)).toHaveLength(2);
    expect(frame?.views.filter((v) => v.kind === 'pile-3d').map((v) => v.capture)).toEqual([
      'c-mar',
      'c-mar',
    ]);
  });

  it('lets the pile go when its 3D shot throws', async () => {
    const { stage, calls, state } = fakeStage();
    const shoot = stage.shoot.bind(stage);
    stage.shoot = (...a) =>
      state.pinned !== null ? Promise.reject(new Error('context lost')) : shoot(...a);
    const save = vi.fn(() => Promise.resolve({ ok: true }));
    const r = await captureViews(REQ, stage, { save });
    expect(r).toEqual({ ok: false, error: 'context lost' });
    expect(save).not.toHaveBeenCalled();
    expect(calls.filter((c) => c.op === 'open').map((c) => c.arg)).toEqual([
      ['m-a', 'c-mar'],
      [null, null],
    ]);
    expect(calls.at(-1)?.op).toBe('restore');
    expect(state).toEqual(HOME);
  });

  it('puts the outlines back when the photo of a pile throws', async () => {
    const { stage, state } = fakeStage();
    const shoot = stage.shoot.bind(stage);
    stage.shoot = (...a) =>
      state.outlines ? shoot(...a) : Promise.reject(new Error('context lost'));
    const r = await captureViews(REQ, stage, { save: () => Promise.resolve({ ok: true }) });
    expect(r).toEqual({ ok: false, error: 'context lost' });
    expect(state).toEqual(HOME);
  });

  it('skips the 3D picture of a pile whose box does not come, without failing the run', async () => {
    const { stage, state, shots } = fakeStage();
    stage.openPile = (id) => {
      state.pinned = id === 'm-a' ? null : id;
      return Promise.resolve(id !== 'm-a');
    };
    const seen: [number, number][] = [];
    let frame: ReportViewsFrame | null = null;
    const r = await captureViews(REQ, stage, {
      save: (f) => {
        frame = f;
        return Promise.resolve({ ok: true });
      },
      onProgress: (done, total) => seen.push([done, total]),
    });
    expect(r.ok).toBe(true);
    const f = frame as unknown as ReportViewsFrame;
    expect(f.views.filter((v) => v.kind === 'pile-3d').map((v) => v.pile)).toEqual(['m-b']);
    expect(f.views.filter((v) => v.kind === 'pile-photo')).toHaveLength(4);
    expect(shots).toHaveLength(10 + PILE_SHOTS - 1);
    expect(seen.at(-1)).toEqual([10 + PILE_SHOTS, 10 + PILE_SHOTS]);
    expect(f.views.map((v) => v.file)).not.toContain('pile-1-3d.jpg');
  });

  it('a stop asked during a pile shot saves nothing and puts the view back', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let reached: () => void = () => undefined;
    const atPile = new Promise<void>((r) => {
      reached = r;
    });
    const { stage, calls, state } = fakeStage({
      settle: (_ms, what) => {
        if (what !== 'pile') return Promise.resolve();
        reached();
        return gate;
      },
    });
    const save = vi.fn(() => Promise.resolve({ ok: true }));
    const going = captureViews(REQ, stage, { save });
    await atPile;
    expect(state.outlines).toBe(false);
    stopPictures();
    release();
    const r = await going;
    expect(r).toEqual({ ok: false, error: picturesStopped() });
    expect(save).not.toHaveBeenCalled();
    // the shot under way is finished, no further one is taken
    expect(calls.filter((c) => c.op === 'shoot')).toHaveLength(6);
    expect(calls.at(-1)?.op).toBe('restore');
    expect(state).toEqual(HOME);
    expect(pictureRun.getState()).toMatchObject({ running: false, stopping: false });
  });

  it('waits for a pile picture more briefly than for a site picture', async () => {
    const { stage, calls } = fakeStage();
    await captureViews(REQ, stage, {
      save: () => Promise.resolve({ ok: true }),
      tileTimeoutMs: 9000,
      pileTimeoutMs: 2000,
    });
    const settles = calls.filter((c) => c.op === 'settle').map((c) => c.arg as [string, number]);
    expect(settles.filter(([what]) => what === 'pile')).toHaveLength(PILE_SHOTS);
    for (const [what, ms] of settles) if (what === 'pile') expect(ms).toBe(2000);
    expect(settles.filter(([what]) => what === 'tiles')).toHaveLength(10);
  });

  it('says what is being pictured', async () => {
    const { stage, shots } = fakeStage();
    await run(stage, {
      ...REQ,
      dateLabels: { 'c-jan': '12 Jan 2026', 'c-feb': '12 Feb 2026', 'c-mar': '12 Mar 2026' },
      piles: [{ ...REQ.piles[0], label: 'Pile A' }, REQ.piles[1]] as never,
    });
    expect(shots[0]?.label).toBe('Site, 12 Jan 2026');
    expect(shots.find((s) => s.w === 800)?.label).toBe('Pile 1 of 2: Pile A');
    expect(shots.at(-1)?.label).toBe('Cut and fill between the surveys');
    expect(pictureRun.getState().label).toBe('');
  });

  it('pictures the piles that fit in 512 views and returns the ids of the rest', async () => {
    const piles = Array.from({ length: 200 }, (_, i) => ({
      id: `m-${String(i)}`,
      points: ring(500_000 + i * 30, 2_000_000, 10),
    }));
    const { stage } = fakeStage();
    const { r, frame } = await run(stage, {
      ...REQ,
      dates: ['c-feb', 'c-mar'],
      piles,
    });
    expect(r.ok).toBe(true);
    if (!r.ok || !frame) throw new Error('not saved');
    expect(r.unpictured).toHaveLength(32);
    expect(r.unpictured[0]).toBe('m-168');
    expect(frame.views.length).toBe(7 + 168 * 3);
    expect(frame.views.length).toBeLessThanOrEqual(512);
    expect(ReportViewsFrame.safeParse(frame).success).toBe(true);
    // the site pictures still show every pile
    expect(Object.keys(frame.markers3d['c-mar'] ?? {})).toHaveLength(200);
  });
});
