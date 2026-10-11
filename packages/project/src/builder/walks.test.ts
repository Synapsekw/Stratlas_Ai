import { WalkFile } from '@aio/schema';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FfmpegCheck } from '../import/stitch';
import { importWalk, listWalks, sweepStaging, walkIdFor, type WalkTools } from './walks';
import type { WalkTrack } from './walkSource';

let dir: string;
let root: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'aio-walks-'));
  root = join(dir, 'project');
  await mkdir(root);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const vide = (w: number, h: number, codec = 'hvc1', fps = 59.94): WalkTrack => ({
  handler: 'vide',
  width: w,
  height: h,
  codec,
  fps,
  durationMs: 4000,
  spherical: null,
});
const soun: WalkTrack = {
  handler: 'soun',
  width: 0,
  height: 0,
  codec: 'mp4a',
  fps: 46.9,
  durationMs: 4000,
};

const GOOD: FfmpegCheck = { ok: true, v360: true, version: '8.1' };

/** Fake tools: tracks by file name, a copy that writes a few bytes, calls recorded. */
function tools(over: Partial<WalkTools> & { tracksBy?: Record<string, WalkTrack[]> } = {}) {
  const calls: string[] = [];
  const t: WalkTools = {
    tracks: (file) => {
      const name = file.split(/[\\/]/).pop() ?? '';
      const hit = over.tracksBy?.[name];
      if (!hit) return Promise.reject(new Error('Not an MP4 or MOV file: no movie index found.'));
      return Promise.resolve(hit);
    },
    trailer: () => Promise.resolve(true),
    check: () => Promise.resolve(GOOD),
    copy: async (out, o) => {
      calls.push(`copy:${o.layout}`);
      o.onProgress?.(0.5);
      await writeFile(out, 'video');
      return { width: 3840, height: 1920, fps: 29.97, encoder: 'libx264', filter: 'v360=test' };
    },
    poster: async (_video, _at, out) => {
      calls.push('poster');
      await writeFile(out, 'jpeg');
    },
    ...over,
  };
  return { t, calls };
}

const src = async (name: string, body = 'source') => {
  const p = join(dir, name);
  await writeFile(p, body);
  return p;
};

const CLIP = 'VID_20260101_120000_00_001.insv';
const PROXY = 'LRV_20260101_120000_01_001.lrv';

describe('importWalk', () => {
  it('stitches a two stream camera file into walks/<id>/ with a valid walk.json', async () => {
    const { t, calls } = tools({
      tracksBy: { [CLIP]: [vide(2880, 2880), vide(2880, 2880), soun] },
    });
    const seen: number[] = [];
    const r = await importWalk(root, await src(CLIP), {
      tools: t,
      onProgress: (f) => seen.push(f),
      now: () => new Date('2026-10-11T09:30:00Z'),
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.walk.id).toBe('vid-20260101-120000-00-001');
    expect(calls).toEqual(['copy:insv-dual-stream', 'poster']);
    expect(seen).toContain(0.5);
    const folder = join(root, 'walks', r.walk.id);
    expect((await readdir(folder)).sort()).toEqual(['playback.mp4', 'poster.jpg', 'walk.json']);
    const file = WalkFile.parse(JSON.parse(await readFile(join(folder, 'walk.json'), 'utf8')));
    expect(file).toMatchObject({
      name: 'VID_20260101_120000_00_001',
      createdAt: '2026-10-11T09:30:00.000Z',
      source: {
        file: CLIP,
        bytes: 6,
        layout: 'insv-dual-stream',
        trailer: true,
        capturedAt: '2026-01-01T12:00:00',
      },
      video: {
        src: 'walks/vid-20260101-120000-00-001/playback.mp4',
        width: 3840,
        height: 1920,
        durationS: 4,
        fps: 29.97,
        audio: true,
      },
      poster: 'walks/vid-20260101-120000-00-001/poster.jpg',
      stitch: { tool: 'ffmpeg', filter: 'v360=test', fovDeg: 195, encoder: 'libx264' },
    });
    expect(file.source.streams).toHaveLength(2);
    expect(r.message).toContain('3840 x 1920');
    // nothing but the finished folder is left in walks/
    expect(await readdir(join(root, 'walks'))).toEqual([r.walk.id]);
  });

  it('says exactly that ffmpeg is missing and leaves the project untouched', async () => {
    const { t, calls } = tools({
      tracksBy: { [CLIP]: [vide(2880, 2880), vide(2880, 2880)] },
      check: () => Promise.resolve({ ok: false, reason: 'missing' }),
    });
    const r = await importWalk(root, await src(CLIP), { tools: t });
    expect(r).toMatchObject({ ok: false, status: 'error' });
    if (!r.ok) expect(r.message).toContain('ffmpeg was not found');
    expect(calls).toEqual([]);
    expect(await readdir(root)).toEqual([]);
  });

  it('says when ffmpeg has no v360 filter, and writes nothing', async () => {
    const { t } = tools({
      tracksBy: { [CLIP]: [vide(2880, 2880), vide(2880, 2880)] },
      check: () => Promise.resolve({ ok: true, v360: false, version: '4.2.1' }),
    });
    const r = await importWalk(root, await src(CLIP), { tools: t });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain('no v360 filter');
    expect(await readdir(root)).toEqual([]);
  });

  it('leaves no folder behind when the stitch fails', async () => {
    const { t } = tools({
      tracksBy: { [CLIP]: [vide(2880, 2880), vide(2880, 2880)] },
      copy: async (out) => {
        await writeFile(out, 'half');
        throw new Error('Conversion failed!');
      },
    });
    const r = await importWalk(root, await src(CLIP), { tools: t });
    expect(r).toMatchObject({ ok: false, status: 'error' });
    if (!r.ok) expect(r.message).toContain('Conversion failed!');
    expect(await readdir(join(root, 'walks'))).toEqual([]);
  });

  it('still imports when the poster cannot be made', async () => {
    const { t } = tools({
      tracksBy: { [CLIP]: [vide(2880, 2880), vide(2880, 2880)] },
      poster: () => Promise.reject(new Error('no frame')),
    });
    const r = await importWalk(root, await src(CLIP), { tools: t });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.walk.poster).toBeUndefined();
  });

  it('skips a layout it cannot verify, with the reason, before asking for ffmpeg', async () => {
    let asked = false;
    const { t } = tools({
      tracksBy: { [CLIP]: [vide(2880, 2880)] },
      check: () => {
        asked = true;
        return Promise.resolve(GOOD);
      },
    });
    const r = await importWalk(root, await src(CLIP), { tools: t });
    expect(r).toMatchObject({ ok: false, status: 'skipped' });
    if (!r.ok) expect(r.message).toContain('one video track');
    expect(asked).toBe(false);
  });

  it('reports a file that is not a video at all', async () => {
    const { t } = tools();
    const r = await importWalk(root, await src('broken.insv'), { tools: t });
    expect(r).toMatchObject({ ok: false, status: 'error' });
    if (!r.ok) expect(r.message).toContain('Not an MP4');
  });

  it('imports a proxy on its own at low resolution, naming the full clip when it lies beside it', async () => {
    const { t, calls } = tools({ tracksBy: { [PROXY]: [vide(1664, 832, 'avc1', 29.97), soun] } });
    t.copy = async (out, o) => {
      calls.push(`copy:${o.layout}`);
      await writeFile(out, 'video');
      return { width: 1664, height: 832, fps: 29.97, encoder: 'libx264', filter: 'v360=lrv' };
    };
    await src(CLIP);
    const r = await importWalk(root, await src(PROXY), { tools: t });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(calls[0]).toBe('copy:dual-fisheye');
    expect(r.walk.source).toMatchObject({ layout: 'dual-fisheye', lowRes: true });
    expect(r.message).toContain('low resolution');
    expect(r.message).toContain(CLIP);
  });

  it('gives a second import of the same file its own folder', async () => {
    const { t } = tools({ tracksBy: { [CLIP]: [vide(2880, 2880), vide(2880, 2880)] } });
    const a = await importWalk(root, await src(CLIP), { tools: t });
    const b = await importWalk(root, join(dir, CLIP), { tools: t });
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok)
      expect([a.walk.id, b.walk.id]).toEqual([
        'vid-20260101-120000-00-001',
        'vid-20260101-120000-00-001-2',
      ]);
  });

  it('two imports of one file that finish close together both keep their walk', async () => {
    // while this import stitches, another one of the same file name finishes and takes the id
    const { t } = tools({ tracksBy: { [CLIP]: [vide(2880, 2880), vide(2880, 2880)] } });
    const other = join(root, 'walks', 'vid-20260101-120000-00-001');
    t.copy = async (out) => {
      await mkdir(other);
      await writeFile(join(other, 'walk.json'), 'the other import');
      await writeFile(join(other, 'playback.mp4'), 'the other video');
      await writeFile(out, 'video');
      return { width: 3840, height: 1920, fps: 29.97, encoder: 'libx264', filter: 'v360=test' };
    };
    const r = await importWalk(root, await src(CLIP), { tools: t });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.walk.id).toBe('vid-20260101-120000-00-001-2');
    expect(r.walk.video.src).toBe('walks/vid-20260101-120000-00-001-2/playback.mp4');
    expect(r.walk.poster).toBe('walks/vid-20260101-120000-00-001-2/poster.jpg');
    // the other import's walk is untouched, and no staging folder is left
    expect(await readFile(join(other, 'walk.json'), 'utf8')).toBe('the other import');
    expect(await readFile(join(other, 'playback.mp4'), 'utf8')).toBe('the other video');
    expect((await readdir(join(root, 'walks'))).sort()).toEqual([
      'vid-20260101-120000-00-001',
      'vid-20260101-120000-00-001-2',
    ]);
    const saved = JSON.parse(
      await readFile(join(root, 'walks', r.walk.id, 'walk.json'), 'utf8'),
    ) as { id: string };
    expect(saved.id).toBe(r.walk.id);
  });

  it('two imports running at once never share a staging folder', async () => {
    const { t } = tools({ tracksBy: { [CLIP]: [vide(2880, 2880), vide(2880, 2880)] } });
    const file = await src(CLIP);
    const [a, b] = await Promise.all([
      importWalk(root, file, { tools: t }),
      importWalk(root, file, { tools: t }),
    ]);
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect([a.walk.id, b.walk.id].sort()).toEqual([
      'vid-20260101-120000-00-001',
      'vid-20260101-120000-00-001-2',
    ]);
    expect((await listWalks(root)).map((w) => w.id).sort()).toEqual([a.walk.id, b.walk.id].sort());
  });

  // ---- the move into place when another program holds a file of the folder open (Windows)

  const eperm = () =>
    Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' });
  /** A move that is refused `fails` times as Windows refuses it for an open file, then works. */
  function refusing(fails: number) {
    let n = 0;
    return {
      tries: () => n,
      move: {
        platform: 'win32' as const,
        sleep: () => Promise.resolve(),
        rename: async (from: string, to: string) => {
          n++;
          if (n <= fails) throw eperm();
          const { rename } = await import('node:fs/promises');
          await rename(from, to);
        },
      },
    };
  }

  it('waits for a program that briefly holds the finished folder open, then moves it', async () => {
    const { t, calls } = tools({ tracksBy: { [CLIP]: [vide(2880, 2880), vide(2880, 2880)] } });
    const r3 = refusing(3);
    const r = await importWalk(root, await src(CLIP), { tools: t, move: r3.move });
    expect(r.ok).toBe(true);
    expect(r3.tries()).toBe(4);
    expect(calls.filter((c) => c.startsWith('copy'))).toHaveLength(1);
    expect(await readdir(join(root, 'walks'))).toEqual(['vid-20260101-120000-00-001']);
  });

  it('keeps a finished stitch whose move stays refused, and the next import adds it', async () => {
    const { t, calls } = tools({ tracksBy: { [CLIP]: [vide(2880, 2880), vide(2880, 2880)] } });
    const never = refusing(Infinity);
    const file = await src(CLIP);
    const r = await importWalk(root, file, { tools: t, move: never.move });
    expect(r).toMatchObject({ ok: false, status: 'error' });
    if (!r.ok) {
      expect(r.message).toContain('It was kept');
      expect(r.message).toContain('Import the file again');
      expect(r.message).not.toContain('EPERM');
    }
    // the whole stitch is still there, in its staging folder, and is not listed as a walk
    const left = await readdir(join(root, 'walks'));
    expect(left).toHaveLength(1);
    expect(left[0]).toMatch(/^\.staging-/);
    expect((await readdir(join(root, 'walks', left[0] ?? ''))).sort()).toEqual([
      'playback.mp4',
      'poster.jpg',
      'walk.json',
    ]);
    expect(await listWalks(root)).toEqual([]);

    // importing the file again moves it into place; nothing is stitched a second time
    const again = await importWalk(root, file, { tools: t });
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(calls.filter((c) => c.startsWith('copy'))).toHaveLength(1);
    expect(again.walk.id).toBe('vid-20260101-120000-00-001');
    expect(again.message).toContain('nothing was stitched again');
    expect(await readdir(join(root, 'walks'))).toEqual(['vid-20260101-120000-00-001']);
    const saved = WalkFile.parse(
      JSON.parse(await readFile(join(root, 'walks', again.walk.id, 'walk.json'), 'utf8')),
    );
    expect(saved.video.src).toBe('walks/vid-20260101-120000-00-001/playback.mp4');
    expect(saved.poster).toBe('walks/vid-20260101-120000-00-001/poster.jpg');
    expect((await listWalks(root)).map((w) => w.id)).toEqual([again.walk.id]);
  });

  // ---- what an interrupted import leaves behind

  it('removes the half copy an interrupted import left, before the next import', async () => {
    const stale = join(root, 'walks', '.staging-old-clip-0a1b2c3d');
    await mkdir(stale, { recursive: true });
    await writeFile(join(stale, 'playback.mp4'), 'half a video');
    await writeFile(join(stale, 'playback.mp4.part'), 'half a video');
    const { t } = tools({ tracksBy: { 'tour.mp4': [vide(1920, 960, 'avc1', 30)] } });
    const r = await importWalk(root, await src('tour.mp4'), { tools: t });
    expect(r.ok).toBe(true);
    expect(await readdir(join(root, 'walks'))).toEqual(['tour']);
  });

  it('never touches the staging folder of an import that is still running', async () => {
    let release: () => void = () => undefined;
    const waiting = new Promise<void>((r) => {
      release = r;
    });
    let stagingOfSlow = '';
    const slow = tools({ tracksBy: { [CLIP]: [vide(2880, 2880), vide(2880, 2880)] } });
    slow.t.copy = async (out) => {
      stagingOfSlow = out;
      await writeFile(out, 'being written');
      await waiting;
      return { width: 3840, height: 1920, fps: 29.97, encoder: 'libx264', filter: 'v360=test' };
    };
    const first = importWalk(root, await src(CLIP), { tools: slow.t });
    await expect.poll(() => stagingOfSlow).not.toBe('');
    // a second import starts and finishes while the first is still stitching
    const quick = tools({ tracksBy: { 'tour.mp4': [vide(1920, 960, 'avc1', 30)] } });
    expect((await importWalk(root, await src('tour.mp4'), { tools: quick.t })).ok).toBe(true);
    expect(await readFile(stagingOfSlow, 'utf8')).toBe('being written');
    expect(await sweepStaging(root)).toEqual([]);
    expect(await readFile(stagingOfSlow, 'utf8')).toBe('being written');
    release();
    expect((await first).ok).toBe(true);
    expect((await readdir(join(root, 'walks'))).sort()).toEqual([
      'tour',
      'vid-20260101-120000-00-001',
    ]);
  });

  it('sweeping a project without walks does nothing', async () => {
    expect(await sweepStaging(root)).toEqual([]);
    expect(await readdir(root)).toEqual([]);
  });

  // ---- nothing that can refuse the file waits until after the stitch

  it('caps a very long file name instead of failing after the stitch', async () => {
    const long = 'Site walk north side '.repeat(6).trim();
    expect(long.length).toBeGreaterThan(100);
    const { t, calls } = tools();
    t.tracks = () => Promise.resolve([vide(1920, 960, 'hvc1', 30)]);
    const r = await importWalk(root, await src(`${long}.mp4`), { tools: t });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(calls[0]).toBe('copy:equirect');
    expect(r.walk.id.length).toBeLessThanOrEqual(80);
    expect(r.walk.id).toBe(walkIdFor(long));
    expect(r.walk.name).toBe(long);
    // the id leaves room for a "-2" inside the contract's limit, and is never empty
    expect(walkIdFor('a'.repeat(300))).toHaveLength(80);
    expect(walkIdFor('----')).toBe('walk');
  });

  it('refuses a file whose details cannot be saved before any copy is made', async () => {
    const odd = { ...vide(2880, 2880), fps: Number.NaN };
    const { t, calls } = tools({ tracksBy: { [CLIP]: [odd, odd] } });
    const r = await importWalk(root, await src(CLIP), { tools: t });
    expect(r).toMatchObject({ ok: false, status: 'error' });
    if (!r.ok) expect(r.message).toContain('could not be read well enough');
    expect(calls).toEqual([]);
    expect(await readdir(root)).toEqual([]);
  });

  it('stores a stitched H.264 MP4 as it is, without ffmpeg', async () => {
    let asked = false;
    const { t, calls } = tools({
      tracksBy: { 'Site tour.mp4': [vide(3840, 1920, 'avc1', 30), soun] },
      check: () => {
        asked = true;
        return Promise.resolve({ ok: false, reason: 'missing' });
      },
    });
    const r = await importWalk(root, await src('Site tour.mp4', 'the stitched video'), {
      tools: t,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(asked).toBe(false);
    expect(calls).toEqual(['poster']);
    expect(r.walk).toMatchObject({
      id: 'site-tour',
      source: { layout: 'equirect' },
      video: { width: 3840, height: 1920, fps: 30 },
    });
    expect(r.walk.stitch).toBeUndefined();
    expect(await readFile(join(root, 'walks', 'site-tour', 'playback.mp4'), 'utf8')).toBe(
      'the stitched video',
    );
  });

  it('makes a playback copy of a stitched video Chromium would struggle with', async () => {
    const { t, calls } = tools({ tracksBy: { 'big.mp4': [vide(7680, 3840, 'hvc1', 30)] } });
    const r = await importWalk(root, await src('big.mp4'), { tools: t });
    expect(r.ok).toBe(true);
    expect(calls[0]).toBe('copy:equirect');
    // and without ffmpeg it says what is needed
    const none = tools({
      tracksBy: { 'big.mp4': [vide(7680, 3840, 'hvc1', 30)] },
      check: () => Promise.resolve({ ok: false, reason: 'missing' }),
    });
    const r2 = await importWalk(root, join(dir, 'big.mp4'), { tools: none.t });
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.message).toContain('playback copy');
  });

  it('refuses an ordinary MP4 with the reason', async () => {
    const { t } = tools({ tracksBy: { 'flight-0001.mp4': [vide(3840, 2160, 'avc1', 30)] } });
    const r = await importWalk(root, await src('flight-0001.mp4'), { tools: t });
    expect(r).toMatchObject({ ok: false, status: 'skipped' });
    if (!r.ok) expect(r.message).toContain('3840 x 2160');
  });
});

describe('listWalks', () => {
  it('is empty without the folder', async () => {
    expect(await listWalks(root)).toEqual([]);
  });

  it('lists every walk that reads, newest first, and skips what does not', async () => {
    const { t } = tools({
      tracksBy: {
        [CLIP]: [vide(2880, 2880), vide(2880, 2880)],
        'tour.mp4': [vide(1920, 960, 'avc1', 30)],
      },
    });
    await importWalk(root, await src(CLIP), {
      tools: t,
      now: () => new Date('2026-10-10T08:00:00Z'),
    });
    await importWalk(root, await src('tour.mp4'), {
      tools: t,
      now: () => new Date('2026-10-11T08:00:00Z'),
    });
    await mkdir(join(root, 'walks', 'broken'), { recursive: true });
    await writeFile(join(root, 'walks', 'broken', 'walk.json'), '{ not json');
    await mkdir(join(root, 'walks', 'newer'), { recursive: true });
    await writeFile(
      join(root, 'walks', 'newer', 'walk.json'),
      JSON.stringify({ schema: 'aio.walk/2', id: 'newer' }),
    );
    await mkdir(join(root, 'walks', '.staging-x'), { recursive: true });
    // a walk.json far larger than any real one is not read at all
    await mkdir(join(root, 'walks', 'huge'), { recursive: true });
    await writeFile(
      join(root, 'walks', 'huge', 'walk.json'),
      JSON.stringify({ schema: 'aio.walk/1', id: 'huge', pad: 'x'.repeat(300 * 1024) }),
    );
    await mkdir(join(root, 'walks', 'empty'), { recursive: true });
    const list = await listWalks(root);
    expect(list.map((w) => w.id)).toEqual(['tour', 'vid-20260101-120000-00-001']);
    // a walk whose folder was renamed by hand is listed under its folder name
    const { rename } = await import('node:fs/promises');
    await rename(join(root, 'walks', 'tour'), join(root, 'walks', 'tour-moved'));
    expect((await listWalks(root)).map((w) => w.id)).not.toContain('tour');
    expect(await stat(join(root, 'walks', 'tour-moved', 'walk.json'))).toBeTruthy();
  });
});
