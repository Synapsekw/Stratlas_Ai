import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testFfmpeg, writeMarkerVideo } from './fixtures/walkVideo';
import {
  decodeFrame,
  ffmpegProblem,
  frameArgs,
  parseVideoSize,
  runFfmpeg,
  scaledHeight,
  videoSize,
} from './frames';

describe('frame decode arguments', () => {
  it('seeks before the input with two decoder threads and writes one scaled RGBA frame', () => {
    expect(frameArgs('C:/p/walks/w/playback.mp4', 2.5, 640, 320)).toEqual([
      '-nostdin',
      '-hide_banner',
      '-loglevel',
      'error',
      '-threads',
      '2',
      '-ss',
      '2.500',
      '-i',
      'C:/p/walks/w/playback.mp4',
      '-frames:v',
      '1',
      '-an',
      '-vf',
      'scale=640:320:flags=area',
      '-f',
      'rawvideo',
      '-pix_fmt',
      'rgba',
      'pipe:1',
    ]);
  });

  it('keeps the aspect ratio of the source', () => {
    expect(scaledHeight(640, { width: 3840, height: 1920 })).toBe(320);
    expect(scaledHeight(1000, { width: 5760, height: 2880 })).toBe(500);
    expect(scaledHeight(1, { width: 3840, height: 100 })).toBe(1);
  });

  it('reads the picture size from ffmpeg’s description of the input', () => {
    const stderr = [
      "Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'playback.mp4':",
      '  Duration: 00:00:04.00, start: 0.000000, bitrate: 60 kb/s',
      '  Stream #0:0[0x1](und): Video: h264 (High) (avc1 / 0x31637661), yuv420p(tv, bt709, progressive), 3840x1920 [SAR 1:1 DAR 2:1], 55 kb/s, 5 fps',
      'At least one output file must be specified',
    ].join('\n');
    expect(parseVideoSize(stderr)).toEqual({ width: 3840, height: 1920 });
    expect(parseVideoSize('Stream #0:1: Audio: aac, 48000 Hz')).toBeNull();
  });

  it('says why when the program refuses the arguments', async () => {
    // Node stands in for ffmpeg here: it refuses ffmpeg's options with a non-zero exit
    await expect(
      decodeFrame({ ffmpeg: process.execPath, file: 'x.mp4', t: 0, width: 4, height: 2 }),
    ).rejects.toThrow(/could not decode the frame at 0\.000 s \(exit \d+\)/);
    await expect(
      decodeFrame({
        ffmpeg: join(tmpdir(), 'no-such-ffmpeg.exe'),
        file: 'x',
        t: 0,
        width: 4,
        height: 2,
      }),
    ).rejects.toThrow(/ffmpeg could not be started/);
  });
});

describe('stopping and starting ffmpeg', () => {
  it('kills a running child as soon as the run stops', async () => {
    // Node stands in for a long ffmpeg decode: it would run for 30 s
    const ac = new AbortController();
    const started = Date.now();
    setTimeout(() => {
      ac.abort();
    }, 150);
    const r = await runFfmpeg(
      process.execPath,
      ['-e', 'setTimeout(() => {}, 30000)'],
      60_000,
      ac.signal,
    );
    expect(r.aborted).toBe(true);
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it('does not start a decode for a run already stopped, and says it was stopped', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(
      decodeFrame({
        ffmpeg: join(tmpdir(), 'no-such-ffmpeg.exe'),
        file: 'x',
        t: 1,
        width: 4,
        height: 2,
        signal: ac.signal,
      }),
    ).rejects.toThrow('The frame decode at 1.000 s was stopped.');
  });

  it('says why ffmpeg cannot be started, once, before any frame', async () => {
    const missing = join(tmpdir(), 'no-such-ffmpeg.exe');
    expect(await ffmpegProblem(missing)).toMatch(
      /^Walk frames are read with ffmpeg, and it could not be started \(.*no-such-ffmpeg\.exe\): .+ Install the pipeline pack, or put ffmpeg on the PATH\.$/,
    );
  });

  it.skipIf(!testFfmpeg)('finds nothing wrong with a working ffmpeg', async () => {
    expect(await ffmpegProblem(testFfmpeg ?? 'ffmpeg')).toBeNull();
  });
});

describe.skipIf(!testFfmpeg)('decoding a synthetic walk video with ffmpeg', () => {
  let dir: string;
  let video: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'aio-frames-'));
    video = join(dir, 'playback.mp4');
    // second 0: magenta block on the left; second 1: cyan block on the right
    await writeMarkerVideo(testFfmpeg ?? 'ffmpeg', video, 640, 320, [
      [{ cls: 'marker', box: [40, 100, 120, 180] }],
      [{ cls: 'cyan-marker', box: [480, 100, 560, 180] }],
    ]);
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const px = (img: { width: number; rgba: Uint8Array }, x: number, y: number) => [
    ...img.rgba.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 3),
  ];
  const near = (a: number[], b: number[]) => a.every((v, i) => Math.abs(v - (b[i] ?? 0)) <= 24);

  it('decodes the frame at t, scaled, as RGBA', async () => {
    const ffmpeg = testFfmpeg ?? 'ffmpeg';
    const first = await decodeFrame({ ffmpeg, file: video, t: 0.4, width: 320, height: 160 });
    expect(first.width).toBe(320);
    expect(first.height).toBe(160);
    expect(first.rgba.length).toBe(320 * 160 * 4);
    expect(near(px(first, 40, 70), [255, 0, 255])).toBe(true);
    expect(near(px(first, 260, 70), [255, 0, 255])).toBe(false);
    const second = await decodeFrame({ ffmpeg, file: video, t: 1.4, width: 320, height: 160 });
    expect(near(px(second, 260, 70), [0, 255, 255])).toBe(true);
    expect(near(px(second, 40, 70), [255, 0, 255])).toBe(false);
  });

  it('gives the same pixels as ffmpeg with its default threads', async () => {
    const ffmpeg = testFfmpeg ?? 'ffmpeg';
    for (const t of [0.4, 1.13]) {
      const ours = await decodeFrame({ ffmpeg, file: video, t, width: 320, height: 160 });
      const args = frameArgs(video, t, 320, 160);
      const at = args.indexOf('-threads');
      args.splice(at, 2);
      const theirs = execFileSync(ffmpeg, args, { maxBuffer: 1 << 24 });
      expect(Buffer.from(ours.rgba).equals(theirs)).toBe(true);
    }
  });

  it('reads the size of the video', async () => {
    expect(await videoSize(testFfmpeg ?? 'ffmpeg', video)).toEqual({ width: 640, height: 320 });
  });

  it('says so when there is no frame at t', async () => {
    await expect(
      decodeFrame({ ffmpeg: testFfmpeg ?? 'ffmpeg', file: video, t: 60, width: 32, height: 16 }),
    ).rejects.toThrow(/no frame at 60\.000 s/);
  });

  it('stops ffmpeg at the timeout', async () => {
    await expect(
      decodeFrame({
        ffmpeg: testFfmpeg ?? 'ffmpeg',
        file: video,
        t: 0,
        width: 32,
        height: 16,
        timeoutMs: 1,
      }),
    ).rejects.toThrow(/took longer than/);
  });
});
