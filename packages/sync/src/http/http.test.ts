import { createHash, X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import { signerFromSeed, verifySignature } from '@aio/journal';
import type { Heads } from '@aio/schema';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  certFingerprint,
  chainKey,
  createHttpClient,
  decodeSince,
  encodeSince,
  probeFingerprint,
  serverOrigin,
  signatureBase,
  signatureParams,
  signRequest,
  TeamServerError,
} from './index';

const fixture = (name: string) => readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url));
const vector = JSON.parse(fixture('request-signature-vector.json').toString('utf8')) as {
  seed: string;
  nowMs: number;
  request: { method: string; url: string; body: string };
  base: string;
  headers: Record<string, string>;
};

describe('request signatures (RFC 9421)', () => {
  it('match the pinned test vector', () => {
    const signer = signerFromSeed(vector.seed);
    const headers = signRequest(signer, vector.request, {
      now: vector.nowMs,
      nonce: vector.headers['x-aio-nonce'] ?? '',
    });
    expect(headers).toEqual(vector.headers);
    expect(
      signatureBase({
        method: vector.request.method,
        url: vector.request.url,
        digest: headers['content-digest'] ?? '',
        device: signer.device,
        nonce: headers['x-aio-nonce'] ?? '',
        created: Math.floor(vector.nowMs / 1000),
      }),
    ).toBe(vector.base);
  });

  it('without content headers stay byte-identical to the pinned vector', () => {
    const signer = signerFromSeed(vector.seed);
    const headers = signRequest(
      signer,
      { ...vector.request, headers: { accept: 'application/json', host: 'team.example.com' } },
      { now: vector.nowMs, nonce: vector.headers['x-aio-nonce'] ?? '' },
    );
    expect(headers).toEqual(vector.headers);
  });

  it('also cover content-type and content-range when the request carries them', () => {
    const signer = signerFromSeed(vector.seed);
    const created = Math.floor(vector.nowMs / 1000);
    const nonce = vector.headers['x-aio-nonce'] ?? '';
    const headers = signRequest(
      signer,
      {
        ...vector.request,
        // names in any case, values trimmed, listed in the protocol order whatever the order here
        headers: { 'Content-Range': ' bytes 0-9/10 ', 'Content-Type': 'application/json' },
      },
      { now: vector.nowMs, nonce },
    );
    const params = `("@method" "@target-uri" "content-digest" "x-aio-device" "x-aio-nonce" "content-type" "content-range");created=${created};keyid="${signer.device}";alg="ed25519"`;
    expect(headers['signature-input']).toBe(`aio=${params}`);
    expect(signatureParams(signer.device, created, ['content-range', 'content-type'])).toBe(params);
    const base = signatureBase({
      method: vector.request.method,
      url: vector.request.url,
      digest: headers['content-digest'] ?? '',
      device: signer.device,
      nonce,
      created,
      optional: { 'content-type': 'application/json', 'content-range': 'bytes 0-9/10' },
    });
    const lines = base.split('\n');
    expect(lines.slice(5)).toEqual([
      '"content-type": application/json',
      '"content-range": bytes 0-9/10',
      `"@signature-params": ${params}`,
    ]);
    expect(lines.slice(0, 5)).toEqual(vector.base.split('\n').slice(0, 5));
    // the signature is over this extended base
    const hash = createHash('sha256').update(base, 'utf8').digest('hex');
    const sig = Buffer.from(
      (headers.signature ?? '').replace(/^aio=:/, '').replace(/:$/, ''),
      'base64',
    ).toString('base64url');
    expect(verifySignature(signer.publicKey, 'aio.request/1', hash, sig)).toBe(true);

    // only content-type: only it is added
    const onlyType = signRequest(
      signer,
      { ...vector.request, headers: { 'content-type': 'application/json' } },
      { now: vector.nowMs, nonce },
    );
    expect(onlyType['signature-input']).toContain('"x-aio-nonce" "content-type");created=');
  });

  it('use a fresh nonce on every request', () => {
    const signer = signerFromSeed(vector.seed);
    const a = signRequest(signer, vector.request);
    const b = signRequest(signer, vector.request);
    expect(a['x-aio-nonce']).not.toBe(b['x-aio-nonce']);
    expect(a.signature).not.toBe(b.signature);
  });
});

describe('since tokens', () => {
  const chain = (n: number) =>
    `d_${'a'.repeat(51)}${'abcdefgh'[n % 8] ?? 'a'}.r_${String(n).padStart(16, 'a').replace(/\d/g, 'b')}`;

  it('round-trip heads by chain key', () => {
    const heads: Heads = {
      [chain(1)]: { seq: 4, id: 'a'.repeat(64) },
      [chain(2)]: { seq: 17, id: 'b'.repeat(64) },
    };
    const decoded = decodeSince(encodeSince(heads));
    expect(decoded).toEqual(
      new Map([
        [chainKey(chain(1)), 4],
        [chainKey(chain(2)), 17],
      ]),
    );
    expect(decodeSince(encodeSince({}))).toEqual(new Map());
  });

  it('stay under 4096 characters by dropping the shortest chains first', () => {
    const heads: Heads = {};
    for (let i = 0; i < 400; i++) {
      const id = `d_${'a'.repeat(40)}${String(i)
        .padStart(12, '0')
        .replace(/\d/g, (d) => 'abcdefghij'[Number(d)] ?? 'a')}.r_aaaaaaaaaaaaaaaa`;
      heads[id] = { seq: i + 1, id: 'c'.repeat(64) };
    }
    const token = encodeSince(heads);
    expect(token.length).toBeLessThanOrEqual(4096);
    const kept = decodeSince(token);
    expect(kept?.size).toBeGreaterThan(200);
    expect([...(kept?.values() ?? [])]).toContain(400);
    expect([...(kept?.values() ?? [])]).not.toContain(1);
  });

  it('refuse what is not a token', () => {
    for (const bad of ['', 'v2', 'v1x', 'v1~abc.1', `v1~${'a'.repeat(12)}.0`, 'v1~AAAAAAAAAAAA.1'])
      expect(decodeSince(bad)).toBeNull();
  });
});

describe('server addresses', () => {
  it('need https except on this computer', () => {
    expect(serverOrigin('https://team.example.com/some/path')).toBe('https://team.example.com');
    expect(serverOrigin('http://127.0.0.1:8080')).toBe('http://127.0.0.1:8080');
    expect(() => serverOrigin('http://team.example.com')).toThrow(/secure address/);
    expect(() => serverOrigin('ftp://team.example.com')).toThrow(TeamServerError);
    expect(() => serverOrigin('not an address')).toThrow(TeamServerError);
  });
});

describe('pinned TLS', () => {
  const cert = fixture('loopback-test-only.crt');
  const key = fixture('loopback-test-only.key');
  const other = new X509Certificate(fixture('other-test-only.crt'));
  const expected = certFingerprint(new X509Certificate(cert).raw);
  const seen: string[] = [];
  const inputs: string[] = [];
  let server: Server;
  let origin = '';

  beforeAll(async () => {
    server = createServer({ cert, key }, (req, res) => {
      seen.push(
        `${req.method ?? ''} ${req.url ?? ''} ${String(req.headers['x-aio-device'] ?? '-')}`,
      );
      inputs.push(String(req.headers['signature-input'] ?? ''));
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `https://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => {
    server.close();
  });

  it('reads the certificate fingerprint on first contact', async () => {
    expect(await probeFingerprint(origin)).toBe(expected);
    expect(expected).toBe(new X509Certificate(cert).fingerprint256.replace(/:/g, '').toLowerCase());
  });

  it('sends signed requests only to the pinned certificate', async () => {
    const signer = signerFromSeed(vector.seed);
    const client = createHttpClient({ baseUrl: origin, fingerprint: expected, signer });
    const res = await client.request('GET', '/v1/health');
    expect(res.status).toBe(200);
    expect(seen.at(-1)).toBe(`GET /v1/health ${signer.device}`);

    const before = seen.length;
    const wrong = createHttpClient({
      baseUrl: origin,
      fingerprint: certFingerprint(other.raw),
      signer,
    });
    await expect(wrong.request('POST', '/v1/enrol', { body: '{}' })).rejects.toMatchObject({
      code: 'fingerprint',
    });
    // a self-signed certificate is not trusted by any CA either
    const caOnly = createHttpClient({
      baseUrl: origin,
      fingerprint: certFingerprint(other.raw),
      trustCaOnChange: true,
      signer,
    });
    await expect(caOnly.request('GET', '/v1/health')).rejects.toMatchObject({
      code: 'fingerprint',
    });
    const noPin = createHttpClient({
      baseUrl: origin,
      fingerprint: null,
      trustCaOnChange: true,
      signer,
    });
    await expect(noPin.request('GET', '/v1/health')).rejects.toMatchObject({
      code: 'fingerprint',
    });
    expect(seen.length).toBe(before);
  });

  it('signs the content type and range it sends, to a server that speaks it', async () => {
    const signer = signerFromSeed(vector.seed);
    const older = createHttpClient({ baseUrl: origin, fingerprint: expected, signer });
    await older.request('PUT', '/v1/blobs/x', {
      body: 'abc',
      headers: { 'content-type': 'application/octet-stream', 'content-range': 'bytes 0-2/3' },
    });
    expect(inputs.at(-1)).toMatch(/"x-aio-nonce"\);created=/);
    const client = createHttpClient({
      baseUrl: origin,
      fingerprint: expected,
      signer,
      coverHeaders: true,
    });
    await client.request('PUT', '/v1/blobs/x', {
      body: 'abc',
      headers: { 'content-type': 'application/octet-stream', 'content-range': 'bytes 0-2/3' },
    });
    expect(inputs.at(-1)).toMatch(/"x-aio-nonce" "content-type" "content-range"\);created=/);
    await client.request('GET', '/v1/health');
    expect(inputs.at(-1)).toMatch(/"x-aio-nonce"\);created=/);
  });

  it('names an address that does not answer', async () => {
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const port = (closed.address() as AddressInfo).port;
    await new Promise<void>((resolve) =>
      closed.close(() => {
        resolve();
      }),
    );
    await expect(probeFingerprint(`https://127.0.0.1:${port}`, 2000)).rejects.toMatchObject({
      code: 'unreachable',
    });
  });
});
