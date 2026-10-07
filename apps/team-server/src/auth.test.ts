import { readFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { signerFromSeed } from '@aio/journal';
import { chainKey as clientChainKey, encodeSince, signRequest } from '@aio/sync/http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inviteHash, makeInvite, newInviteCode } from './auth/enrol';
import { NonceCache, signatureBase, verifyRequest } from './auth/signatures';
import { createFsBlobStore } from './blobs/fs';
import { ephemeralIdentity } from './identity';
import { buildServer } from './server';
import { chainKey, decodeSince } from './since';
import { createMemoryStore } from './store/memory';
import { testPeople } from './testkit';

const vector = JSON.parse(
  readFileSync(
    new URL(
      '../../../packages/sync/src/http/__fixtures__/request-signature-vector.json',
      import.meta.url,
    ),
    'utf8',
  ),
) as {
  seed: string;
  nowMs: number;
  request: { method: string; url: string; body: string };
  base: string;
  headers: Record<string, string>;
};

describe('request signatures, server side', () => {
  const key = signerFromSeed(vector.seed).publicKey;
  const req = {
    method: vector.request.method,
    url: vector.request.url,
    headers: vector.headers,
    body: Buffer.from(vector.request.body),
  };

  it('verify the pinned client vector', () => {
    expect(
      signatureBase({
        method: 'POST',
        url: req.url,
        digest: vector.headers['content-digest'] ?? '',
        device: vector.headers['x-aio-device'] ?? '',
        nonce: vector.headers['x-aio-nonce'] ?? '',
        created: vector.nowMs / 1000,
      }),
    ).toBe(vector.base);
    expect(verifyRequest(req, () => key, new NonceCache(), vector.nowMs)).toEqual({
      ok: true,
      device: vector.headers['x-aio-device'],
    });
  });

  it('refuse a replay, an edited body, another target, an old request and a forgery', () => {
    const nonces = new NonceCache();
    expect(verifyRequest(req, () => key, nonces, vector.nowMs).ok).toBe(true);
    expect(verifyRequest(req, () => key, nonces, vector.nowMs + 1000)).toEqual({
      ok: false,
      why: 'replay',
    });
    const fresh = () => new NonceCache();
    expect(
      verifyRequest({ ...req, body: Buffer.from('{"ops":[1]}') }, () => key, fresh(), vector.nowMs),
    ).toEqual({ ok: false, why: 'digest' });
    expect(
      verifyRequest({ ...req, url: `${req.url}?x=1` }, () => key, fresh(), vector.nowMs),
    ).toEqual({ ok: false, why: 'signature' });
    expect(verifyRequest({ ...req, method: 'PUT' }, () => key, fresh(), vector.nowMs)).toEqual({
      ok: false,
      why: 'signature',
    });
    expect(verifyRequest(req, () => key, fresh(), vector.nowMs + 301_000)).toEqual({
      ok: false,
      why: 'expired',
    });
    const other = testPeople().omar.signer.publicKey;
    expect(verifyRequest(req, () => other, fresh(), vector.nowMs)).toEqual({
      ok: false,
      why: 'signature',
    });
    expect(verifyRequest(req, () => null, fresh(), vector.nowMs)).toEqual({
      ok: false,
      why: 'unknown-device',
    });
    const unsigned = { ...vector.headers };
    delete unsigned.signature;
    expect(verifyRequest({ ...req, headers: unsigned }, () => key, fresh(), vector.nowMs)).toEqual({
      ok: false,
      why: 'missing',
    });
  });
});

describe('since tokens', () => {
  it('name chains the same way as the client', () => {
    const chain = testPeople().rana.chain;
    expect(chainKey(chain)).toBe(clientChainKey(chain));
    const token = encodeSince({ [chain]: { seq: 9, id: 'a'.repeat(64) } });
    expect(decodeSince(token)).toEqual(new Map([[chainKey(chain), 9]]));
  });
});

describe('invite codes', () => {
  it('are 80 random bits in four groups, matched without case or dashes', () => {
    const code = newInviteCode();
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){3}$/);
    expect(inviteHash(code.toLowerCase().replace(/-/g, ' '))).toBe(inviteHash(code));
    expect(newInviteCode()).not.toBe(code);
    const { invite } = makeInvite('viewer', null, new Date('2026-10-07T00:00:00Z'));
    expect(invite.expiresAt).toBe('2026-10-14T00:00:00.000Z');
  });
});

describe('signed routes over HTTP', () => {
  const people = testPeople();
  const store = createMemoryStore();
  const app = buildServer({
    store,
    blobs: createFsBlobStore(mkdtempSync(join(tmpdir(), 'aio-auth-blobs-'))),
    identity: ephemeralIdentity(),
    version: '0.1.0-test',
    publicUrl: 'https://team.example.com',
  });
  const url = (path: string) => `https://team.example.com${path}`;
  const heads = '/v1/projects/t_vm6cv3mws7bgecezd4hkxj6qqt/heads';

  beforeAll(async () => {
    const { code, invite } = makeInvite('owner', null, new Date());
    await store.addInvite(invite);
    const body = JSON.stringify({ code, device: people.rana.record });
    const r = await app.inject({
      method: 'POST',
      url: '/v1/enrol',
      headers: {
        'content-type': 'application/json',
        ...signRequest(people.rana.signer, { method: 'POST', url: url('/v1/enrol'), body }),
      },
      payload: body,
    });
    expect(r.statusCode).toBe(200);
  });
  afterAll(() => app.close());

  it('refuse an unsigned request', async () => {
    const r = await app.inject({ method: 'GET', url: heads });
    expect(r.statusCode).toBe(401);
    expect(r.json()).toMatchObject({ code: 'signature-missing' });
  });

  it('refuse the same signed request twice', async () => {
    const headers = signRequest(people.rana.signer, { method: 'GET', url: url(heads) });
    expect((await app.inject({ method: 'GET', url: heads, headers })).statusCode).toBe(404);
    const again = await app.inject({ method: 'GET', url: heads, headers });
    expect(again.statusCode).toBe(401);
    expect(again.json()).toMatchObject({ code: 'signature-replay' });
  });

  it('refuse a device that is not enrolled, or revoked', async () => {
    const r = await app.inject({
      method: 'GET',
      url: heads,
      headers: signRequest(people.lina.signer, { method: 'GET', url: url(heads) }),
    });
    expect(r.json()).toMatchObject({ code: 'signature-unknown-device' });
    await store.revokeDevice(people.rana.signer.device, new Date().toISOString(), 'lost laptop');
    const after = await app.inject({
      method: 'GET',
      url: heads,
      headers: signRequest(people.rana.signer, { method: 'GET', url: url(heads) }),
    });
    expect(after.statusCode).toBe(401);
  });
});
