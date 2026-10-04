import { describe, expect, it } from 'vitest';
import {
  mapLimited,
  parseRate,
  pickEncoder,
  posterArgs,
  proxyArgs,
  proxyRate,
  type ProxyEncoder,
} from './proxy';

const after = (args: string[], flag: string) => args[args.indexOf(flag) + 1];

describe('frame rates', () => {
  it('parses ffprobe rates and plain numbers', () => {
    expect(parseRate('30000/1001')).toEqual({ num: 30000, den: 1001 });
    expect(parseRate('50/1')).toEqual({ num: 50, den: 1 });
    expect(parseRate('25')).toEqual({ num: 25, den: 1 });
    expect(parseRate(29.97)).toEqual({ num: 30000, den: 1001 });
    expect(() => parseRate('0/0')).toThrow();
    expect(() => parseRate('abc')).toThrow();
  });

  it('halves rates above 30 and keeps the rest', () => {
    expect(proxyRate(parseRate('50/1'))).toEqual({ num: 25, den: 1 });
    expect(proxyRate(parseRate('60000/1001'))).toEqual({ num: 30000, den: 1001 });
    expect(proxyRate(parseRate('30000/1001'))).toEqual({ num: 30000, den: 1001 });
    expect(proxyRate(parseRate('30/1'))).toEqual({ num: 30, den: 1 });
    expect(proxyRate(parseRate('120/1'))).toEqual({ num: 30, den: 1 });
    expect(proxyRate(parseRate('50/1'), 60)).toEqual({ num: 50, den: 1 });
  });
});

describe('proxyArgs', () => {
  const base = { out: 'out.mp4.part', srcFps: '30000/1001' } as const;

  it('makes a 1920 px H.264 yuv420p faststart MP4 without audio, one keyframe a second', () => {
    const a = proxyArgs({ ...base, inputs: ['in.MOV'], encoder: 'libx264' });
    expect(a.slice(-3)).toEqual(['-f', 'mp4', 'out.mp4.part']);
    expect(after(a, '-i')).toBe('in.MOV');
    expect(after(a, '-filter_complex')).toBe(
      "[0:v:0]scale='min(1920,iw)':-2:flags=lanczos:out_range=tv,format=yuv420p[v]",
    );
    expect(after(a, '-map')).toBe('[v]');
    expect(a).toContain('-an');
    expect(after(a, '-pix_fmt')).toBe('yuv420p');
    expect(after(a, '-movflags')).toBe('+faststart');
    expect(after(a, '-c:v')).toBe('libx264');
    expect(after(a, '-preset')).toBe('faster');
    expect(after(a, '-crf')).toBe('24');
    expect(after(a, '-maxrate')).toBe('8000k');
    expect(after(a, '-g')).toBe('30');
    expect(after(a, '-keyint_min')).toBe('30');
    expect(after(a, '-sc_threshold')).toBe('0');
    expect(after(a, '-force_key_frames')).toBe('expr:gte(t,n_forced*1)');
    expect(a).not.toContain('-hwaccel');
  });

  it('joins camera chapters into one continuous clip', () => {
    const a = proxyArgs({ ...base, inputs: ['a.MOV', 'b.MOV'], encoder: 'libx264' });
    expect(a.filter((x) => x === '-i')).toHaveLength(2);
    expect(after(a, '-filter_complex')).toMatch(/^\[0:v:0\]\[1:v:0\]concat=n=2:v=1:a=0,scale=/);
  });

  it('drops frames (not time) for 50 fps sources and sets the GOP from the output rate', () => {
    const a = proxyArgs({ ...base, srcFps: '50/1', inputs: ['x.MP4'], encoder: 'libx264' });
    expect(after(a, '-filter_complex')).toMatch(/^\[0:v:0\]fps=25,scale=/);
    expect(after(a, '-g')).toBe('25');
    const b = proxyArgs({ ...base, srcFps: '60000/1001', inputs: ['x'], encoder: 'libx264' });
    expect(after(b, '-filter_complex')).toContain('fps=30000/1001,');
  });

  it('uses the hardware encoders with GPU decoding by default', () => {
    const n = proxyArgs({ ...base, inputs: ['a', 'b'], encoder: 'h264_nvenc' });
    expect(after(n, '-c:v')).toBe('h264_nvenc');
    expect(after(n, '-cq')).toBe('24');
    expect(after(n, '-no-scenecut')).toBe('1');
    expect(n.filter((x) => x === 'cuda')).toHaveLength(2);
    const q = proxyArgs({ ...base, inputs: ['a'], encoder: 'h264_qsv' });
    expect(after(q, '-c:v')).toBe('h264_qsv');
    expect(after(q, '-hwaccel')).toBe('auto');
    const x = proxyArgs({ ...base, inputs: ['a'], encoder: 'libx264', hwDecode: 'cuda' });
    expect(after(x, '-hwaccel')).toBe('cuda');
    expect(x.indexOf('-hwaccel')).toBeLessThan(x.indexOf('-i'));
  });

  it('takes width, quality, bitrate and keyframe spacing', () => {
    const a = proxyArgs({
      ...base,
      inputs: ['a'],
      encoder: 'libx264',
      width: 1280,
      quality: 20,
      maxKbps: 5000,
      keyframeS: 2,
    });
    expect(after(a, '-filter_complex')).toContain("scale='min(1280,iw)'");
    expect(after(a, '-crf')).toBe('20');
    expect(after(a, '-bufsize')).toBe('10000k');
    expect(after(a, '-g')).toBe('60');
    expect(after(a, '-force_key_frames')).toBe('expr:gte(t,n_forced*2)');
  });

  it('refuses no input', () => {
    expect(() => proxyArgs({ ...base, inputs: [], encoder: 'libx264' })).toThrow();
  });
});

describe('posterArgs', () => {
  it('takes one frame at a time, scaled down only', () => {
    const a = posterArgs('v.mp4', 1, 'p.jpg');
    expect(after(a, '-ss')).toBe('1.000');
    expect(after(a, '-frames:v')).toBe('1');
    expect(after(a, '-vf')).toBe("scale='min(960,iw)':-2");
    expect(a.at(-1)).toBe('p.jpg');
  });
});

describe('pickEncoder', () => {
  const listed = ' V....D h264_nvenc  NVIDIA\n V..... h264_qsv  QSV\n V....D libx264  x264\n';
  it('takes the first listed hardware encoder that works', async () => {
    const tried: ProxyEncoder[] = [];
    const e = await pickEncoder(listed, (x) => {
      tried.push(x);
      return Promise.resolve(x === 'h264_qsv');
    });
    expect(e).toBe('h264_qsv');
    expect(tried).toEqual(['h264_nvenc', 'h264_qsv']);
  });
  it('falls back to libx264 when none works or none is listed', async () => {
    expect(await pickEncoder(listed, () => Promise.resolve(false))).toBe('libx264');
    expect(await pickEncoder(' V....D libx264 x\n', () => Promise.resolve(true))).toBe('libx264');
  });
});

describe('mapLimited', () => {
  it('keeps order and never runs more than the limit', async () => {
    let running = 0;
    let peak = 0;
    const r = await mapLimited([5, 1, 3, 2, 4], 2, async (x) => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((ok) => setTimeout(ok, x));
      running--;
      return x * 10;
    });
    expect(r).toEqual([50, 10, 30, 20, 40]);
    expect(peak).toBe(2);
  });
});
