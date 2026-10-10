import type { HeightTiles } from '@aio/schema';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { connectEngine, RunCancelled } from './engineClient';
import type { EngineContext, EnginePort, EngineRequest } from './engineProtocol';
import { serveEngine } from './engineServe';

const DIR = join(
  fileURLToPath(new URL('.', import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  '..',
  'packages',
  'schema',
  'src',
  '__fixtures__',
  'survey',
);
const cone = JSON.parse(
  readFileSync(join(DIR, 'tiles', 'cone', 'tiles.json'), 'utf8'),
) as HeightTiles;
const cases = JSON.parse(readFileSync(join(DIR, 'cases.json'), 'utf8')) as {
  cases: { id: string; expected: { fillM3: number } }[];
};
const ring: [number, number][] = Array.from({ length: 24 }, (_, k) => [
  302010 + 8 * Math.cos((2 * Math.PI * k) / 24),
  2574010 + 8 * Math.sin((2 * Math.PI * k) / 24),
]);

function engine(delayMs = 0) {
  const { port1, port2 } = new MessageChannel();
  const urls: string[] = [];
  serveEngine(port2, async (url) => {
    urls.push(url);
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    const m = /survey\/surfaces\/(cone|flat)\/(.+)$/.exec(url);
    return m?.[2] ? new Uint8Array(readFileSync(join(DIR, 'tiles', 'cone', m[2]))) : null;
  });
  const client = connectEngine(port1);
  const context: EngineContext = {
    base: 'aio://project/p1/',
    surfaces: [
      { ...cone, capture: 'c2' },
      { ...cone, id: 'flat', capture: 'c1', fingerprint: 'fp-flat' },
    ],
    captures: ['c1', 'c2'],
    designs: [],
    site: { verticalDatum: { kind: 'project' } },
  };
  client.setContext(context);
  return {
    client,
    urls,
    close: () => {
      client.dispose();
      port1.close();
      port2.close();
    },
  };
}

describe('the survey engine worker', () => {
  it('runs items over the prepared tiles through aio:// and returns heat grids', async () => {
    const { client, urls, close } = engine();
    try {
      const r = await client.run({
        ring,
        items: [
          {
            id: 'a',
            from: { kind: 'reference', mode: 'level', levelM: 100 },
            to: { kind: 'current' },
            useDeadband: false,
          },
        ],
        heat: 16,
      });
      const want = cases.cases.find((c) => c.id === 'cone-over-flat')?.expected.fillM3 ?? 0;
      expect(r.results[0]?.fillM3).toBeCloseTo(want, 9);
      expect(r.results[0]?.toCapture).toBe('c2');
      expect(r.results[0]?.engine).toBe('ts');
      expect(urls[0]).toBe('aio://project/p1/survey/surfaces/cone/0/0_0.bin');
      const h = r.heat[0];
      expect(h?.nx).toBeLessThanOrEqual(16);
      expect(h && Math.max(...Array.from(h.dz).filter(Number.isFinite))).toBeGreaterThan(3);
      expect(h && Array.from(h.z).some((z) => z > 100)).toBe(true);
      // fingerprints without computing match the result's
      const fp = await client.fingerprints({
        ring,
        items: [
          {
            id: 'a',
            from: { kind: 'reference', mode: 'level', levelM: 100 },
            to: { kind: 'current' },
            useDeadband: false,
          },
        ],
      });
      expect(fp[0]).toBe(r.results[0]?.fingerprint);
      const moved = await client.fingerprints({
        ring,
        items: [
          {
            id: 'a',
            from: { kind: 'reference', mode: 'level', levelM: 100.5 },
            to: { kind: 'current' },
            useDeadband: false,
          },
        ],
      });
      expect(moved[0]).not.toBe(r.results[0]?.fingerprint);
    } finally {
      close();
    }
  });

  it('a newer run with the same key cancels the older one', async () => {
    const { client, close } = engine(30);
    try {
      const item = {
        id: 'a',
        from: { kind: 'previous' } as const,
        to: { kind: 'current' } as const,
        useDeadband: false,
      };
      const first = client.run({ ring, items: [item] }, 'm1');
      const second = client.run({ ring, items: [item] }, 'm1');
      await expect(first).rejects.toBeInstanceOf(RunCancelled);
      const r = await second;
      expect(r.results[0]?.fromCapture).toBe('c1');
      // G3's seam
      const one = await client.runner('c2').run(
        ring.map(([e, n]) => [e, n, 0]),
        item,
      );
      expect(one.fillM3).toBe(r.results[0]?.fillM3);
    } finally {
      close();
    }
  });

  it('the whole-site difference over the overlap of two surfaces', async () => {
    const { client, close } = engine();
    try {
      const s = await client.site({
        from: { kind: 'survey', surface: 'flat' },
        to: { kind: 'survey', surface: 'cone' },
        cellM: 1,
      });
      expect(s.result.status).toBe('ok');
      expect(s.grid?.cellM).toBe(1);
      expect(s.grid?.nx).toBe(20);
      expect(s.grid?.x0).toBe(302000);
    } finally {
      close();
    }
  });

  it('answers with the problem when its answer cannot be sent, so the request does not wait', async () => {
    // a port that refuses the first good answer (as postMessage does for a buffer it cannot move)
    const replies: { id: number; ok: boolean; error?: string }[] = [];
    let refused = false;
    const port: EnginePort = {
      postMessage: (r) => {
        const reply = r as { id: number; ok: boolean; error?: string };
        if (reply.ok && !refused) {
          refused = true;
          throw new Error('DataCloneError: an ArrayBuffer is detached and could not be cloned');
        }
        replies.push(reply);
      },
      onmessage: null,
    };
    serveEngine(port, () => Promise.resolve(null));
    const send = (data: EngineRequest) => port.onmessage?.({ data } as MessageEvent);
    send({
      kind: 'context',
      context: {
        base: 'aio://project/p1/',
        surfaces: [{ ...cone, capture: 'c2' }],
        captures: ['c1', 'c2'],
        designs: [],
        site: { verticalDatum: { kind: 'project' } },
      },
    });
    send({ kind: 'fingerprints', id: 7, req: { ring, items: [] } });
    await vi.waitFor(() => {
      expect(replies).toHaveLength(1);
    });
    expect(replies[0]).toMatchObject({ id: 7, ok: false });
    expect(replies[0]?.error).toMatch(/answer could not be sent.*DataCloneError/);
  });
});
