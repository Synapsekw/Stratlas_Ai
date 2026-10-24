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

function engine(delayMs = 0, extra: Partial<EngineContext> = {}) {
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
    ...extra,
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

describe('the survey engine worker with a lined-up date', () => {
  const item = {
    id: 'a',
    from: { kind: 'reference' as const, mode: 'level' as const, levelM: 100 },
    to: { kind: 'current' as const },
    useDeadband: false,
  };
  // the cone's date was prepared lined up by 2 m east, 1 m south; the date is lined up again since
  const lined: Partial<EngineContext> = {
    surfaces: [
      { ...cone, capture: 'c2', dateShiftM: { eastM: 2, northM: -1 } },
      { ...cone, id: 'flat', capture: 'c1', fingerprint: 'fp-flat' },
    ],
    shifts: { c2: [3.5, 0.5] },
  };
  // a survey's own ring is stored 2 m west and 1 m north of where its prepared surface sits
  const stored: [number, number][] = ring.map(([e, n]) => [e - 2, n + 1]);

  it('adds the prepared shift to a survey-scoped ring and fingerprints the shift now', async () => {
    const { client, close } = engine(0, lined);
    try {
      const r = await client.run({ ring: stored, items: [item], capture: 'c2' });
      const want = cases.cases.find((c) => c.id === 'cone-over-flat')?.expected.fillM3 ?? 0;
      expect(r.results[0]?.fillM3).toBeCloseTo(want, 9);
      const [fp] = await client.fingerprints({ ring: stored, items: [item], capture: 'c2' });
      expect(fp).toBe(r.results[0]?.fingerprint);
      // the same ring as a site-wide one is not moved: it samples another place
      const site = await client.run({ ring: stored, items: [item] });
      expect(site.results[0]?.fillM3).not.toBeCloseTo(want, 3);
    } finally {
      close();
    }
  });

  it('reads stale after a turned line-up, even one with the same shift', async () => {
    const turn = { rotationDeg: 0.5, scale: 1, pivotE: 500000, pivotN: 3200000 };
    const a = engine(0, lined);
    const b = engine(0, { ...lined, turns: { c2: turn } });
    try {
      const req = { ring: stored, items: [item], capture: 'c2' };
      const fa = (await a.client.run(req)).results[0];
      const fb = (await b.client.run(req)).results[0];
      expect(fb?.fingerprint).not.toBe(fa?.fingerprint);
      const [fp] = await b.client.fingerprints(req);
      expect(fp).toBe(fb?.fingerprint);
    } finally {
      a.close();
      b.close();
    }
  });

  it('reads stale after a line-up the surface was not prepared with', async () => {
    const a = engine(0, lined);
    const b = engine(0, { ...lined, shifts: { c2: [4, 0] } });
    try {
      const req = { ring: stored, items: [item], capture: 'c2' };
      const fa = (await a.client.run(req)).results[0];
      const fb = (await b.client.run(req)).results[0];
      expect(fb?.fillM3).toBeCloseTo(fa?.fillM3 ?? 0, 9);
      expect(fb?.fingerprint).not.toBe(fa?.fingerprint);
    } finally {
      a.close();
      b.close();
    }
  });
});

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

  it('the whole-site difference leaves out changes under the deadband it is given', async () => {
    const { client, close } = engine();
    try {
      const req = {
        from: { kind: 'reference' as const, mode: 'level' as const, levelM: 100 },
        to: { kind: 'survey' as const, surface: 'cone' },
        cellM: 1,
        ring,
      };
      const all = await client.site(req);
      const some = await client.site({ ...req, deadbandM: 1 });
      const none = await client.site({ ...req, deadbandM: 0 });
      expect(all.result.usedDeadband).toBe(false);
      expect(some.result.usedDeadband).toBe(true);
      expect(some.result.deadbandM).toBe(1);
      expect(some.result.fillM3 + some.result.cutM3).toBeLessThan(
        all.result.fillM3 + all.result.cutM3,
      );
      expect(none.result.fillM3).toBe(all.result.fillM3);
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

describe('per-date runs and the spread across bases', () => {
  const item = {
    id: 'a',
    from: { kind: 'reference' as const, mode: 'level' as const, levelM: 100 },
    to: { kind: 'current' as const },
    useDeadband: false,
  };

  it('serve answers a series request with one result per capture', async () => {
    const { client, close } = engine();
    try {
      const rows = await client.series({ ring, item, captures: ['c1', 'c2'] });
      expect(rows.map((r) => r.toCapture)).toEqual(['c1', 'c2']);
      expect(rows.every((r) => r.item === 'a' && r.engine === 'ts')).toBe(true);
      // each date's fingerprint, without computing, matches its result
      const prints = await client.seriesFingerprints({ ring, item, captures: ['c1', 'c2'] });
      expect(prints).toEqual(rows.map((r) => r.fingerprint));
      // the latest date is the run viewed on it
      const now = await client.run({ ring, items: [item], capture: 'c2' });
      expect(rows[1]?.fingerprint).toBe(now.results[0]?.fingerprint);
      // no current side: no series
      const fixed = { ...item, to: { kind: 'survey' as const, surface: 'cone' } };
      expect(await client.series({ ring, item: fixed, captures: ['c1', 'c2'] })).toEqual([]);
    } finally {
      close();
    }
  });

  it('serve answers a spread request over the spread bases', async () => {
    const { client, close } = engine();
    try {
      const s = await client.spread({ ring, item: { ...item, from: { kind: 'smart' } } });
      expect(s?.nets.length).toBeGreaterThanOrEqual(2);
      expect(Number.isFinite(s?.pct)).toBe(true);
      // a surface on the from side has no spread
      const surf = { ...item, from: { kind: 'survey' as const, surface: 'flat' } };
      expect(await client.spread({ ring, item: surf })).toBeNull();
    } finally {
      close();
    }
  });
});
