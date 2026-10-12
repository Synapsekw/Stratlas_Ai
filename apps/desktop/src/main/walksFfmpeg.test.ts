import type * as Builder from '@aio/project/builder';
import type { WalkCopyRequest } from '@aio/project/builder';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ffmpegImportTools } from './builder';
import { walkToolsFor } from './walks';

// the builder library's ffmpeg calls are watched: which program each one is handed
const calls = vi.hoisted(() => ({
  check: [] as unknown[],
  detect: [] as unknown[],
  copy: [] as unknown[],
  proxy: [] as unknown[],
}));
vi.mock('@aio/project/builder', async (importOriginal) => {
  const actual = await importOriginal<typeof Builder>();
  return {
    ...actual,
    checkFfmpeg: (bin?: unknown) => {
      calls.check.push(bin);
      return Promise.resolve({ ok: true, v360: true, version: 'test' });
    },
    detectProxyEncoder: (bin?: unknown) => {
      calls.detect.push(bin);
      return Promise.resolve('libx264');
    },
    makeWalkCopy: (_out: string, o: { bin?: unknown }) => {
      calls.copy.push(o.bin);
      return Promise.resolve({ width: 256, height: 128, fps: 30, encoder: 'libx264' });
    },
    makeProxy: (_out: string, o: { bin?: unknown }) => {
      calls.proxy.push(o.bin);
      return Promise.resolve({ encoder: 'libx264', seconds: 0, source: {} });
    },
  };
});

afterEach(() => {
  for (const list of Object.values(calls)) list.length = 0;
});

const request: WalkCopyRequest = {
  input: 'walk.mp4',
  layout: 'equirect',
  lens: { width: 256, height: 128 },
  srcFps: 30,
  audio: false,
  durationS: 1,
};

describe('the walk import with the pack ffmpeg', () => {
  it('checks and stitches with the found ffmpeg', async () => {
    const bin = { ffmpeg: 'C:/pack/tools/ffmpeg/Library/bin/ffmpeg.exe' };
    const tools = walkToolsFor(bin);
    expect(await tools.check()).toMatchObject({ ok: true });
    await tools.copy('out.mp4', request);
    expect(calls.check).toEqual([bin]);
    expect(calls.detect).toEqual([bin]);
    expect(calls.copy).toEqual([bin]);
  });

  it('leaves it to the PATH without one', async () => {
    const tools = walkToolsFor();
    await tools.check();
    await tools.copy('out.mp4', request);
    expect(calls.check).toEqual([undefined]);
    expect(calls.copy).toEqual([undefined]);
  });

  it('hands the found ffmpeg to the review copy, the walk and the poster', async () => {
    const bin = { ffmpeg: process.execPath };
    const deps = ffmpegImportTools(bin);
    await deps.proxy?.('in.mp4', 'out.mp4');
    expect(calls.proxy).toEqual([bin]);
    await deps.walk?.check();
    expect(calls.check).toEqual([bin]);
    // the poster runs the program it was given (here Node, which refuses ffmpeg's arguments)
    await expect(deps.poster?.('in.mp4', 0, 'out.jpg')).rejects.toThrow(process.execPath);
    await expect(deps.walk?.poster?.('in.mp4', 0, 'out.jpg')).rejects.toThrow(process.execPath);
    await ffmpegImportTools(null).walk?.check();
    expect(calls.check).toEqual([bin, undefined]);
  });
});
