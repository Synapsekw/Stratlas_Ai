import { describe, expect, it } from 'vitest';
import { encodeBits, encodeDeltaI16 } from '../testing';
import { connectVolumeService } from './client';
import { serveVolumes } from './serve';

/** A flat site DSM 0.4 m over the synthetic pile. */
function site() {
  const w = 10;
  const h = 5;
  return `window.VS_DSM=window.VS_DSM||{};window.VS_DSM["e2"]=${JSON.stringify({
    res: 0.4,
    w,
    h,
    x0: 999.6,
    y1: 2000.4,
    zoff: 50,
    z: encodeDeltaI16(new Array<number>(w * h).fill(100), w, h),
    valid: encodeBits(new Array<number>(w * h).fill(1)),
  })};`;
}

/** A worker stand-in: the service runs on the other end of a MessageChannel in this thread. */
function connect(files: Record<string, string>) {
  const ch = new MessageChannel();
  serveVolumes(ch.port2, (url) =>
    files[url] === undefined
      ? Promise.reject(new Error(`404 ${url}`))
      : Promise.resolve(files[url] ?? ''),
  );
  const svc = connectVolumeService(ch.port1, {
    patterns: { pile: 'p/{id}.js', dsm: 'd/{epoch}.js', coarse: 'v.js' },
    epochs: ['e1', 'e2'],
    deadband: 0.1,
  });
  return {
    svc,
    close: () => {
      svc.dispose();
      ch.port2.close();
    },
  };
}

describe('volume service over a message port', () => {
  it('paints the height change between two surveys in the worker', async () => {
    const { svc, close } = connect({ 'd/e2.js': site() });
    try {
      const r = await svc.changeRaster('e2', 'e2');
      expect([r.width, r.height]).toEqual([10, 5]);
    } finally {
      close();
    }
  });

  it('rejects with the worker error', async () => {
    const { svc, close } = connect({});
    try {
      await expect(svc.changeRaster('e1', 'e2')).rejects.toThrow(/e1/);
    } finally {
      close();
    }
  });
});
