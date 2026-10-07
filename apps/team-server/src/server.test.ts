import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HealthResponse, Op, SyncErrorBody } from '@aio/schema';
import { afterAll, describe, expect, it } from 'vitest';
import { buildServer, createMemoryStore } from './index';

const valid = fileURLToPath(
  new URL('../../../packages/schema/src/__fixtures__/journal/valid/journal/ops/', import.meta.url),
);
const fixtureOps = readdirSync(valid).flatMap((chain) =>
  readdirSync(join(valid, chain)).flatMap((f) =>
    readFileSync(join(valid, chain, f), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => Op.parse(JSON.parse(l))),
  ),
);

describe('team server skeleton (T0)', () => {
  const store = createMemoryStore();
  const app = buildServer({ store, version: '0.1.0' });
  afterAll(() => app.close());

  it('answers health with its version and protocol range', async () => {
    const r = await app.inject({ method: 'GET', url: '/v1/health' });
    expect(r.statusCode).toBe(200);
    expect(HealthResponse.parse(r.json())).toEqual({
      ok: true,
      version: '0.1.0',
      protocol: { min: 1, max: 1 },
    });
  });

  it('answers 501 not-implemented on the routes T7 fills', async () => {
    for (const [method, url] of [
      ['GET', '/v1/projects/t_x/heads'],
      ['POST', '/v1/enrol'],
      ['HEAD', `/v1/blobs/${'a'.repeat(64)}`],
    ] as const) {
      const r = await app.inject({ method, url });
      expect(r.statusCode).toBe(501);
      if (method !== 'HEAD') expect(SyncErrorBody.parse(r.json()).code).toBe('not-implemented');
    }
  });

  it('the memory store appends ops once and serves them after heads', async () => {
    const team = `t_${'a'.repeat(26)}`;
    const first = await store.appendOps(team, fixtureOps);
    expect(first.stored).toHaveLength(fixtureOps.length);
    expect((await store.appendOps(team, fixtureOps)).duplicates).toHaveLength(fixtureOps.length);
    const heads = await store.heads(team);
    expect((await store.opsSince(team, heads, 100)).ops).toEqual([]);
    const page = await store.opsSince(team, {}, 5);
    expect(page).toMatchObject({ more: true });
    expect(page.ops).toHaveLength(5);
  });
});
