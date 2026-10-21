/**
 * Attacks on the HTTP layer (security review 2026-10-21): bodies before authentication, blobs
 * outside one's projects, forwarded addresses, replays across a restart and unsigned headers.
 */
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, utimesSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Role } from '@aio/schema';
import {
  createHttpClient,
  createHttpTransport,
  enrolDevice,
  signRequest,
  type HttpTransport,
} from '@aio/sync/http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeInvite } from './auth/enrol';
import { createFsBlobStore } from './blobs/fs';
import { BlobQuotaError } from './blobs/blobStore';
import { readConfig, ConfigError } from './config';
import { ephemeralIdentity } from './identity';
import { defaultRateLimits, type RateLimit } from './rateLimit';
import { buildServer } from './server';
import { createMemoryStore } from './store/memory';
import {
  ChainWriter,
  memberAdd,
  startLoopbackServer,
  TEST_TEAM,
  testPeople,
  type LoopbackServer,
  type Person,
} from './testkit';

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const ORIGIN = 'https://team.example.com';

async function* parts(data: Buffer, size: number) {
  for (let i = 0; i < data.length; i += size)
    yield await Promise.resolve(data.subarray(i, i + size));
}

/** A server on `app.inject` with one enrolled owner. */
function injected(options: Partial<Parameters<typeof buildServer>[0]> = {}) {
  const store = options.store ?? createMemoryStore();
  const identity = options.identity ?? ephemeralIdentity();
  const app = buildServer({
    store,
    blobs: createFsBlobStore(mkdtempSync(join(tmpdir(), 'aio-sec-blobs-'))),
    identity,
    version: '0.1.0-test',
    publicUrl: ORIGIN,
    ...options,
  });
  return { app, store, identity };
}

async function enrolInjected(
  app: ReturnType<typeof buildServer>,
  store: ReturnType<typeof createMemoryStore>,
  p: Person,
  role: Role,
) {
  const { code, invite } = makeInvite(role, null, new Date());
  await store.addInvite(invite);
  const body = JSON.stringify({ code, device: p.record });
  const r = await app.inject({
    method: 'POST',
    url: '/v1/enrol',
    headers: {
      'content-type': 'application/json',
      ...signRequest(p.signer, {
        method: 'POST',
        url: `${ORIGIN}/v1/enrol`,
        body,
        headers: { 'content-type': 'application/json' },
      }),
    },
    payload: body,
  });
  expect(r.statusCode).toBe(200);
}

describe('finding 5: bodies are read only for enrolled devices', () => {
  const { rana, lina } = testPeople();
  const ops = `/v1/projects/${TEST_TEAM}/ops`;

  it('refuses an unknown device before it parses the body', async () => {
    const { app } = injected();
    // not JSON at all: a parsed body would answer 400, an early refusal 401
    const body = 'not json {';
    const r = await app.inject({
      method: 'POST',
      url: ops,
      headers: {
        'content-type': 'application/json',
        ...signRequest(lina.signer, { method: 'POST', url: `${ORIGIN}${ops}`, body }),
      },
      payload: body,
    });
    expect(r.statusCode).toBe(401);
    expect(r.json()).toMatchObject({ code: 'signature-unknown-device' });
    const unsigned = await app.inject({
      method: 'POST',
      url: ops,
      headers: { 'content-type': 'application/json' },
      payload: body,
    });
    expect(unsigned.json()).toMatchObject({ code: 'signature-missing' });
    await app.close();
  });

  it('takes at most 8 MB of JSON from an enrolled device', async () => {
    const { app, store } = injected();
    await enrolInjected(app, store, rana, 'owner');
    const body = JSON.stringify({ ops: [{ pad: 'x'.repeat(9 * 1024 * 1024) }] });
    const r = await app.inject({
      method: 'POST',
      url: ops,
      headers: {
        'content-type': 'application/json',
        ...signRequest(rana.signer, { method: 'POST', url: `${ORIGIN}${ops}`, body }),
      },
      payload: body,
    });
    expect(r.statusCode).toBe(413);
    await app.close();
  });
});

describe('finding 8: forwarded addresses count only from the configured proxy', () => {
  it('keeps the socket address when a client that is not the proxy forwards one', async () => {
    const seen: string[] = [];
    const spy = (inner: RateLimit): RateLimit => ({
      take(key, nowMs) {
        seen.push(key);
        return inner.take(key, nowMs);
      },
    });
    const d = defaultRateLimits();
    const { app } = injected({
      trustProxy: ['10.0.0.5'],
      limits: { ...d, address: spy(d.address) },
    });
    await app.inject({
      method: 'GET',
      url: `/v1/projects/${TEST_TEAM}/heads`,
      headers: { 'x-forwarded-for': '203.0.113.9' },
    });
    expect(seen).toEqual(['127.0.0.1']);
    await app.close();
  });

  it('binds to this computer and trusts only it behind a proxy, unless told otherwise', () => {
    const proxy = { AIO_BEHIND_TLS_PROXY: '1', AIO_PUBLIC_URL: 'https://team.example.com' };
    expect(readConfig(proxy)).toMatchObject({
      host: '127.0.0.1',
      trustedProxies: ['127.0.0.1', '::1'],
    });
    expect(
      readConfig({ ...proxy, AIO_HOST: '0.0.0.0', AIO_TRUSTED_PROXIES: '172.18.0.0/16' }),
    ).toMatchObject({ host: '0.0.0.0', trustedProxies: ['172.18.0.0/16'] });
    expect(() => readConfig({ ...proxy, AIO_TRUSTED_PROXIES: '0.0.0.0/0' })).toThrow(ConfigError);
    expect(() => readConfig({ ...proxy, AIO_TRUSTED_PROXIES: 'true' })).toThrow(ConfigError);
    expect(readConfig({}).trustedProxies).toEqual([]);
  });
});

describe('finding 9: replays across a restart, and signed headers', () => {
  const { rana } = testPeople();
  const heads = `/v1/projects/${TEST_TEAM}/heads`;

  it('refuses a replay after the server restarts on the same store', async () => {
    const first = injected();
    await enrolInjected(first.app, first.store, rana, 'owner');
    const headers = signRequest(rana.signer, { method: 'GET', url: `${ORIGIN}${heads}` });
    expect((await first.app.inject({ method: 'GET', url: heads, headers })).statusCode).toBe(404);
    await first.app.close();
    const restarted = injected({ store: first.store, identity: first.identity });
    const again = await restarted.app.inject({ method: 'GET', url: heads, headers });
    expect(again.statusCode).toBe(401);
    expect(again.json()).toMatchObject({ code: 'signature-replay' });
    await restarted.app.close();
  });

  it('checks a covered content type, and can require it', async () => {
    const { app, store } = injected({ requireSignedHeaders: true });
    await enrolInjected(app, store, rana, 'owner');
    const body = JSON.stringify({ ops: [{ v: 2 }] });
    const ops = `/v1/projects/${TEST_TEAM}/ops`;
    const sign = (headers?: Record<string, string>) =>
      signRequest(rana.signer, { method: 'POST', url: `${ORIGIN}${ops}`, body, headers });
    const covered = sign({ 'content-type': 'application/json' });
    const ok = await app.inject({
      method: 'POST',
      url: ops,
      headers: { 'content-type': 'application/json', ...covered },
      payload: body,
    });
    expect(ok.statusCode).not.toBe(401);
    const swapped = await app.inject({
      method: 'POST',
      url: ops,
      headers: {
        'content-type': 'application/json; charset=latin1',
        ...sign({ 'content-type': 'application/json' }),
      },
      payload: body,
    });
    expect(swapped.json()).toMatchObject({ code: 'signature-signature' });
    const uncovered = await app.inject({
      method: 'POST',
      url: ops,
      headers: { 'content-type': 'application/json', ...sign() },
      payload: body,
    });
    expect(uncovered.json()).toMatchObject({ code: 'signature-components' });
    await app.close();
  });
});

describe('finding 6: blobs belong to the projects that name them', () => {
  const { rana, sami, lina } = testPeople();
  let server: LoopbackServer;
  const data = randomBytes(3000);
  const ref = {
    sha256: sha(data),
    size: data.length,
    path: 'models/site.glb',
    role: 'source' as const,
  };

  const transport = (p: Person): HttpTransport =>
    createHttpTransport({
      client: createHttpClient({
        baseUrl: server.origin,
        fingerprint: server.fingerprint,
        signer: p.signer,
      }),
      teamProjectId: TEST_TEAM,
      partBytes: 1024,
    });

  beforeAll(async () => {
    server = await startLoopbackServer();
    const enrol = async (p: Person, role: Role, project: string | null) =>
      enrolDevice(
        createHttpClient({
          baseUrl: server.origin,
          fingerprint: server.fingerprint,
          signer: p.signer,
        }),
        await server.invite(role, project),
        p.record,
      );
    await enrol(rana, 'owner', null);
    await enrol(sami, 'viewer', TEST_TEAM);
    // a reviewer of another project
    await enrol(lina, 'reviewer', 't_bbbbbbbbbbbbbbbbbbbbbbbbbb');
    const R = new ChainWriter(rana);
    const r = await transport(rana).pushOps([
      R.next(
        'project.share',
        { rec: 'project', id: TEST_TEAM },
        { teamProjectId: TEST_TEAM, name: 'Demo' },
      ),
      R.next('member.add', { rec: 'member', id: rana.actor }, memberAdd(rana, 'owner')),
      R.next('member.add', { rec: 'member', id: sami.actor }, memberAdd(sami, 'viewer')),
    ]);
    expect(r.refused).toEqual([]);
    await transport(rana).putBlob(ref, parts(data, 1024));
    // the blob is named by the project only now
    expect(await transport(sami).hasBlobs([ref.sha256])).toEqual(new Set());
    const add = R.next('blob.add', { rec: 'blob', id: ref.sha256 }, ref);
    expect((await transport(rana).pushOps([add])).accepted).toEqual([add.id]);
  });
  afterAll(() => server.close());

  it('lets members of a project that names a blob read it', async () => {
    expect(await transport(rana).hasBlobs([ref.sha256])).toEqual(new Set([ref.sha256]));
    expect(await transport(sami).hasBlobs([ref.sha256])).toEqual(new Set([ref.sha256]));
  });

  it('keeps a blob from someone outside its projects until they send every byte', async () => {
    expect(await transport(lina).hasBlobs([ref.sha256])).toEqual(new Set());
    expect(await transport(lina).getBlob(ref.sha256)).toBeNull();
    await transport(lina).putBlob(ref, parts(data, 1024));
    expect(await transport(lina).hasBlobs([ref.sha256])).toEqual(new Set([ref.sha256]));
  });

  it('refuses an upload from a viewer', async () => {
    const other = randomBytes(10);
    await expect(
      transport(sami).putBlob(
        { ...ref, sha256: sha(other), size: other.length },
        parts(other, 1024),
      ),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });

  it("keeps each device's unfinished upload to itself", async () => {
    const big = randomBytes(4096);
    const r = { ...ref, sha256: sha(big), size: big.length };
    async function* firstPart() {
      yield await Promise.resolve(big.subarray(0, 1024));
      throw new Error('connection lost');
    }
    await expect(transport(rana).putBlob(r, firstPart())).rejects.toThrow('connection lost');
    expect(await transport(rana).blobReceived(r.sha256)).toBe(1024);
    expect(await transport(lina).blobReceived(r.sha256)).toBe(0);
    // Lina cannot add her bytes to Rana's upload
    await expect(
      transport(lina).putBlob(r, parts(randomBytes(3072), 1024), 1024),
    ).rejects.toMatchObject({ code: 'conflict' });
    expect(await transport(rana).blobReceived(r.sha256)).toBe(1024);
  });
});

describe('finding 6: unfinished uploads have a quota and expire', () => {
  const device = testPeople().rana.signer.device;

  it('refuses an upload past the quota and deletes old unfinished ones', async () => {
    let now = Date.parse('2026-10-21T09:00:00.000Z');
    const root = mkdtempSync(join(tmpdir(), 'aio-sec-quota-'));
    const store = createFsBlobStore(root, {
      partialQuotaBytes: 2000,
      partialTtlMs: 1000,
      now: () => now,
    });
    const a = randomBytes(1500);
    await store.write(sha(a), 0, a.length, a.subarray(0, 1000), device);
    const b = randomBytes(1500);
    await expect(
      store.write(sha(b), 0, b.length, b.subarray(0, 1000), device),
    ).rejects.toBeInstanceOf(BlobQuotaError);
    const dir = join(root, 'partial', device);
    const old = new Date(now - 5000);
    for (const f of readdirSync(dir)) utimesSync(join(dir, f), old, old);
    now += 10;
    expect(await store.sweep()).toBe(1);
    expect(await store.received(sha(a), device)).toBe(0);
    await store.write(sha(b), 0, b.length, b.subarray(0, 1000), device);
    expect(await store.received(sha(b), device)).toBe(1000);
  });
});
