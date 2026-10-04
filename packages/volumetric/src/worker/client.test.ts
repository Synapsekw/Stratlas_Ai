import { describe, expect, it } from 'vitest';
import { syntheticPile } from '../testing';
import { connectVolumeService } from './client';
import { serveVolumes } from './serve';

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
  it('recomputes a pile in the worker and returns the volumes', async () => {
    const { svc, close } = connect({ 'p/P01.js': syntheticPile().text });
    try {
      const r = await svc.recompute('P01');
      expect(r.e2?.tin.net).toBeCloseTo(0.8, 6);
    } finally {
      close();
    }
  });

  it('rejects with the worker error', async () => {
    const { svc, close } = connect({});
    try {
      await expect(svc.recompute('P02')).rejects.toThrow(/P02/);
    } finally {
      close();
    }
  });
});
