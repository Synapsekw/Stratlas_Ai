import { describe, expect, it } from 'vitest';
import {
  equirectCopyArgs,
  ffmpegMissingMessage,
  hasV360,
  progressSeconds,
  stitchArgs,
  v360Filter,
  walkSize,
} from './stitch';

const after = (args: string[], flag: string) => args[args.indexOf(flag) + 1];

describe('walkSize', () => {
  it('two lens streams give twice the lens width, capped at 3840, half as high', () => {
    expect(walkSize('insv-dual-stream', 2880, 2880)).toEqual({ width: 3840, height: 1920 });
    expect(walkSize('insv-dual-stream', 128, 128)).toEqual({ width: 256, height: 128 });
  });

  it('one frame with both lenses keeps its own size', () => {
    expect(walkSize('dual-fisheye', 1664, 832)).toEqual({ width: 1664, height: 832 });
  });

  it('never upscales and always comes out even, the width a multiple of four', () => {
    expect(walkSize('insv-dual-stream', 1001, 1001)).toEqual({ width: 2000, height: 1000 });
    expect(walkSize('dual-fisheye', 7680, 3840)).toEqual({ width: 3840, height: 1920 });
    expect(walkSize('dual-fisheye', 7680, 3840, 2048)).toEqual({ width: 2048, height: 1024 });
  });

  it('a stitched video keeps its own shape', () => {
    expect(walkSize('equirect', 5760, 2880)).toEqual({ width: 3840, height: 1920 });
    expect(walkSize('equirect', 3840, 2160)).toEqual({ width: 3840, height: 2160 });
    expect(walkSize('equirect', 1920, 960)).toEqual({ width: 1920, height: 960 });
  });
});

describe('stitchArgs', () => {
  const two = {
    input: 'VID.insv',
    out: 'playback.mp4.part',
    layout: 'insv-dual-stream',
    lens: { width: 2880, height: 2880 },
    srcFps: '60000/1001',
    encoder: 'libx264',
    audio: true,
  } as const;

  it('halves 59.94 fps per lens, stacks the two streams and unwraps them to 3840 x 1920', () => {
    const a = stitchArgs(two);
    expect(a.filter((x) => x === '-i')).toHaveLength(1);
    expect(after(a, '-i')).toBe('VID.insv');
    expect(after(a, '-filter_complex')).toBe(
      '[0:v:0]fps=30000/1001[l];[0:v:1]fps=30000/1001[r];[l][r]hstack=inputs=2,' +
        'v360=input=dfisheye:output=e:ih_fov=195:iv_fov=195:w=3840:h=1920,' +
        'scale=out_range=tv,format=yuv420p[v]',
    );
    expect(a.slice(-3)).toEqual(['-f', 'mp4', 'playback.mp4.part']);
  });

  it('writes H.264 with a keyframe every half second and a rate Chromium plays', () => {
    const a = stitchArgs(two);
    expect(after(a, '-c:v')).toBe('libx264');
    expect(after(a, '-maxrate')).toBe('16000k');
    expect(after(a, '-g')).toBe('15');
    expect(after(a, '-force_key_frames')).toBe('expr:gte(t,n_forced*0.5)');
    expect(after(a, '-pix_fmt')).toBe('yuv420p');
    expect(after(a, '-movflags')).toBe('+faststart');
    expect(a).not.toContain('-hwaccel');
  });

  it('keeps the sound as stereo AAC, and maps it so a file without sound still stitches', () => {
    const a = stitchArgs(two);
    const maps = a.flatMap((x, i) => (x === '-map' ? [a[i + 1]] : []));
    expect(maps).toEqual(['[v]', '0:a:0?']);
    expect(after(a, '-c:a')).toBe('aac');
    expect(after(a, '-ac')).toBe('2');
    expect(a).not.toContain('-an');
    const silent = stitchArgs({ ...two, audio: false });
    expect(silent).toContain('-an');
    expect(silent).not.toContain('-c:a');
  });

  it('does not stack a file that already holds both lenses in one frame', () => {
    const a = stitchArgs({
      ...two,
      input: 'LRV.lrv',
      layout: 'dual-fisheye',
      lens: { width: 1664, height: 832 },
      srcFps: '30000/1001',
    });
    expect(after(a, '-filter_complex')).toBe(
      '[0:v:0]v360=input=dfisheye:output=e:ih_fov=195:iv_fov=195:w=1664:h=832,' +
        'scale=out_range=tv,format=yuv420p[v]',
    );
    expect(after(a, '-g')).toBe('15');
  });

  it('takes another field of view, a hardware encoder and a time limit', () => {
    const a = stitchArgs({ ...two, fovDeg: 200, encoder: 'h264_nvenc', limitS: 5 });
    expect(after(a, '-filter_complex')).toContain('ih_fov=200:iv_fov=200');
    expect(after(a, '-c:v')).toBe('h264_nvenc');
    expect(after(a, '-t')).toBe('5');
    expect(a.indexOf('-t')).toBeLessThan(a.indexOf('-i'));
  });

  it('refuses a layout that needs no stitch', () => {
    expect(() => stitchArgs({ ...two, layout: 'equirect' as never })).toThrow(/stitch/i);
  });
});

describe('equirectCopyArgs', () => {
  it('scales a stitched video down for playback without any projection filter', () => {
    const a = equirectCopyArgs({
      input: 'tour.mp4',
      out: 'playback.mp4.part',
      width: 3840,
      height: 1920,
      srcFps: '30/1',
      encoder: 'libx264',
      audio: true,
    });
    const graph = after(a, '-filter_complex') ?? '';
    expect(graph).toBe('[0:v:0]scale=3840:1920:flags=lanczos:out_range=tv,format=yuv420p[v]');
    expect(graph).not.toContain('v360');
    expect(after(a, '-c:v')).toBe('libx264');
    expect(after(a, '-c:a')).toBe('aac');
  });
});

describe('v360Filter', () => {
  it('is the dual fisheye to equirectangular projection with its output size', () => {
    expect(v360Filter(195, 3840, 1920)).toBe(
      'v360=input=dfisheye:output=e:ih_fov=195:iv_fov=195:w=3840:h=1920',
    );
  });
});

describe('hasV360', () => {
  const full = [
    'Filters:',
    '  T.. = Timeline support',
    ' .S hstack            N->V       Stack video inputs horizontally.',
    ' .S v360              V->V       Convert 360 projection of video.',
    ' ... vflip             V->V       Flip the input video vertically.',
  ].join('\n');
  it('finds the filter in the list ffmpeg prints', () => {
    expect(hasV360(full)).toBe(true);
  });
  it('is false for a build without it, and not fooled by other names', () => {
    expect(hasV360(full.replace(' v360 ', ' v361 '))).toBe(false);
    expect(hasV360(' .. myv360x          V->V       Something else.')).toBe(false);
    expect(hasV360('')).toBe(false);
  });
});

describe('progressSeconds', () => {
  it('reads the latest output time from a chunk of -progress output', () => {
    const chunk =
      'frame=30\nfps=12.1\nout_time_us=1001000\nout_time=00:00:01.001000\nprogress=continue\n' +
      'frame=60\nout_time_us=2002000\nprogress=continue\n';
    expect(progressSeconds(chunk)).toBeCloseTo(2.002, 6);
  });
  it('is null when the chunk has no time yet', () => {
    expect(progressSeconds('frame=0\nout_time_us=N/A\nprogress=continue\n')).toBeNull();
    expect(progressSeconds('')).toBeNull();
  });
});

describe('ffmpegMissingMessage', () => {
  it('says ffmpeg is not installed and what to install', () => {
    const m = ffmpegMissingMessage({ ok: false, reason: 'missing' });
    expect(m).toContain('ffmpeg was not found');
    expect(m).toContain('PATH');
  });
  it('says when the installed ffmpeg has no v360 filter', () => {
    const m = ffmpegMissingMessage({ ok: true, v360: false, version: '4.2' });
    expect(m).toContain('v360');
    expect(m).toContain('4.2');
  });
  it('is null when ffmpeg can stitch', () => {
    expect(ffmpegMissingMessage({ ok: true, v360: true, version: '8.1' })).toBeNull();
  });
});
