import { createHash, generateKeyPairSync } from 'node:crypto';
import { base32, contentHash, signerFromKey, signerFromSeed, type Signer } from '@aio/journal';
import {
  RECEIPT_SCHEMA,
  type DeviceCert,
  type DeviceRecord,
  type Op,
  type Receipt,
  type ServerKey,
} from '@aio/schema';
import { describe, expect, it } from 'vitest';
import type { BufferedResponse, HttpClient, RequestOptions } from './client';
import {
  createHttpTransport,
  enrolDevice,
  PUSH_BATCH,
  PUSH_BATCH_BYTES,
  serverHealth,
  serverIdFromKey,
  TeamServerError,
} from './index';

/** A team server key as `apps/team-server/src/identity.ts` makes it. */
function serverKey(): { signer: Signer; key: ServerKey } {
  const signer = signerFromKey(generateKeyPairSync('ed25519').privateKey);
  const raw = Buffer.from(signer.publicKey, 'base64url');
  const id = `srv_${base32(createHash('sha256').update(raw).digest()).slice(0, 26)}`;
  return { signer, key: { id, publicKey: signer.publicKey } };
}

/** A receipt as `apps/team-server/src/receipts.ts` makes it. */
function receipt(signer: Signer, server: string, prev: Receipt | null, op: string): Receipt {
  const body = {
    schema: RECEIPT_SCHEMA,
    server,
    seq: (prev?.seq ?? 0) + 1,
    op,
    prev: prev?.id ?? null,
    at: '2026-10-21T10:00:00.000Z',
  };
  const id = contentHash(body);
  return { ...body, id, sig: signer.sign('aio.receipt/1', id) };
}

const opId = (n: number) => createHash('sha256').update(`op ${n}`).digest('hex');
/** Only `id` (and some bulk) matter to the transport: it never reads an op. */
const op = (n: number, payload = ''): Op => ({ id: opId(n), payload }) as unknown as Op;

const reply = (status: number, body: unknown): BufferedResponse => ({
  status,
  headers: {},
  body: Buffer.from(JSON.stringify(body)),
});

type Handler = (method: string, path: string, opts: RequestOptions) => BufferedResponse;

function fakeClient(handler: Handler) {
  const sent: { method: string; path: string; body: string }[] = [];
  const client: HttpClient = {
    origin: 'https://team.example.com',
    request(method, path, opts = {}) {
      const body = typeof opts.body === 'string' ? opts.body : '';
      sent.push({ method, path, body });
      return Promise.resolve(handler(method, path, opts));
    },
    stream() {
      return Promise.reject(new Error('not used'));
    },
  };
  return { client, sent };
}

/** A server that accepts every op it is sent, with a running receipt chain. */
function acceptingServer(signer: Signer, serverId: string) {
  let last: Receipt | null = null;
  return (_method: string, _path: string, opts: RequestOptions) => {
    const { ops } = JSON.parse(String(opts.body)) as { ops: { id: string }[] };
    const receipts = ops.map((o) => (last = receipt(signer, serverId, last, o.id)));
    return reply(200, {
      accepted: ops.map((o) => o.id),
      duplicates: [],
      refused: [],
      receipts,
    });
  };
}

const PROJECT = 't_vm6cv3mws7bgecezd4hkxj6qqt';

describe('server signing key', () => {
  it('names a server by the hash of its key, as the team server does', () => {
    const { key } = serverKey();
    expect(serverIdFromKey(key.publicKey)).toBe(key.id);
    expect(key.id).toMatch(/^srv_[a-z2-7]{26}$/);
  });
});

describe('push receipts', () => {
  it('are verified against the pinned server key', async () => {
    const { signer, key } = serverKey();
    const { client } = fakeClient(acceptingServer(signer, key.id));
    const t = createHttpTransport({ client, teamProjectId: PROJECT, server: key });
    const r = await t.pushOps([op(1), op(2), op(3)]);
    expect(r.accepted).toEqual([opId(1), opId(2), opId(3)]);
    expect(r.receipts.map((x) => x.seq)).toEqual([1, 2, 3]);
  });

  it('are not checked without a pinned key (an enrolment from an older server)', async () => {
    const { key } = serverKey();
    const other = serverKey();
    const { client } = fakeClient(acceptingServer(other.signer, key.id));
    const t = createHttpTransport({ client, teamProjectId: PROJECT });
    expect((await t.pushOps([op(1)])).accepted).toEqual([opId(1)]);
  });

  const tampered: [string, (r: Receipt[]) => unknown][] = [
    ['signed by another key', (r) => r],
    ['for another server', (r) => r.map((x) => ({ ...x, server: 'srv_other' }))],
    [
      'with an edited body',
      (r) => r.map((x, i) => (i === 1 ? { ...x, at: '2026-10-22T10:00:00.000Z' } : x)),
    ],
    ['with a broken link', (r) => r.map((x, i) => (i === 1 ? { ...x, prev: 'f'.repeat(64) } : x))],
    ['out of order', (r) => [r[1], r[0], r[2]]],
    ['missing one', (r) => r.slice(0, 2)],
  ];

  it.each(tampered)('refuse a receipt %s', async (what, edit) => {
    const { signer, key } = serverKey();
    const other = serverKey();
    const by = what === 'signed by another key' ? other.signer : signer;
    const accept = acceptingServer(by, key.id);
    const { client } = fakeClient((m, p, o) => {
      const res = accept(m, p, o);
      const body = JSON.parse(res.body.toString('utf8')) as {
        accepted: string[];
        receipts: Receipt[];
      };
      // an edit to the body without a new signature fails the hash
      return reply(200, { ...body, receipts: edit(body.receipts) });
    });
    const t = createHttpTransport({ client, teamProjectId: PROJECT, server: key });
    const err = await t.pushOps([op(1), op(2), op(3)]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TeamServerError);
    expect(err).toMatchObject({ code: 'protocol' });
    expect((err as Error).message).toMatch(/^The team server sent a receipt that does not verify/);
  });

  it('refuse a receipt for an op this batch did not send', async () => {
    const { signer, key } = serverKey();
    const { client } = fakeClient(() =>
      reply(200, {
        accepted: [opId(9)],
        duplicates: [],
        refused: [],
        receipts: [receipt(signer, key.id, null, opId(9))],
      }),
    );
    const t = createHttpTransport({ client, teamProjectId: PROJECT, server: key });
    await expect(t.pushOps([op(1)])).rejects.toMatchObject({ code: 'protocol' });
  });

  it('refuse an accepted list that is not the receipts', async () => {
    const { signer, key } = serverKey();
    const { client } = fakeClient(() =>
      reply(200, {
        accepted: [opId(2), opId(1)],
        duplicates: [],
        refused: [],
        receipts: [receipt(signer, key.id, null, opId(1))].flatMap((a) => [
          a,
          receipt(signer, key.id, a, opId(2)),
        ]),
      }),
    );
    const t = createHttpTransport({ client, teamProjectId: PROJECT, server: key });
    await expect(t.pushOps([op(1), op(2)])).rejects.toMatchObject({ code: 'protocol' });
  });

  it('are verified in a partial refusal (403) too', async () => {
    const { key } = serverKey();
    const other = serverKey();
    const { client } = fakeClient(() =>
      reply(403, {
        accepted: [opId(1)],
        duplicates: [],
        refused: [{ id: opId(2), code: 'role', message: 'A viewer cannot change this.' }],
        receipts: [receipt(other.signer, key.id, null, opId(1))],
      }),
    );
    const t = createHttpTransport({ client, teamProjectId: PROJECT, server: key });
    await expect(t.pushOps([op(1), op(2)])).rejects.toMatchObject({ code: 'protocol' });
  });

  it('chain across batches without being checked across them', async () => {
    const { signer, key } = serverKey();
    const { client, sent } = fakeClient(acceptingServer(signer, key.id));
    const t = createHttpTransport({ client, teamProjectId: PROJECT, server: key });
    const ops = Array.from({ length: PUSH_BATCH + 5 }, (_, i) => op(i));
    const r = await t.pushOps(ops);
    expect(sent.length).toBe(2);
    expect(r.accepted.length).toBe(PUSH_BATCH + 5);
  });
});

describe('push batches', () => {
  it('stay under the body size as well as the op count', async () => {
    expect(PUSH_BATCH_BYTES).toBe(6 * 1024 * 1024);
    const { signer, key } = serverKey();
    const { client, sent } = fakeClient(acceptingServer(signer, key.id));
    const t = createHttpTransport({
      client,
      teamProjectId: PROJECT,
      server: key,
      pushBatchBytes: 1000,
    });
    // ~300 bytes each: three fit in 1000 bytes, a fourth does not
    const ops = Array.from({ length: 7 }, (_, i) => op(i, 'x'.repeat(200)));
    const big = op(99, 'y'.repeat(5000));
    const r = await t.pushOps([...ops.slice(0, 4), big, ...ops.slice(4)]);
    expect(r.accepted).toEqual([...ops.slice(0, 4), big, ...ops.slice(4)].map((o) => o.id));
    for (const s of sent) {
      const count = (JSON.parse(s.body) as { ops: unknown[] }).ops.length;
      if (count > 1) expect(Buffer.byteLength(s.body)).toBeLessThanOrEqual(1000);
    }
    // the op larger than a batch went alone
    const counts = sent.map((s) => (JSON.parse(s.body) as { ops: { id: string }[] }).ops);
    expect(counts.find((b) => b.some((o) => o.id === big.id))?.length).toBe(1);
    expect(sent.length).toBeGreaterThanOrEqual(4);
  });

  it('send real-sized batches under 6 MB', async () => {
    const { signer, key } = serverKey();
    const { client, sent } = fakeClient(acceptingServer(signer, key.id));
    const t = createHttpTransport({ client, teamProjectId: PROJECT, server: key });
    // 40 ops of ~200 kB: 8 MB in all, more than one request though far under 1000 ops
    const ops = Array.from({ length: 40 }, (_, i) => op(i, 'z'.repeat(200_000)));
    await t.pushOps(ops);
    expect(sent.length).toBe(2);
    for (const s of sent) expect(Buffer.byteLength(s.body)).toBeLessThanOrEqual(PUSH_BATCH_BYTES);
  });
});

describe('enrolment', () => {
  const device = signerFromSeed('7466f8930987ea9099cfed858bf6af173852764f3532c7d3a2d9f0a25e4ec2bf');
  const record = {
    id: device.device,
    actor: 'a_aaaaaaaaaaaaaaaaaaaaaaaaaa',
  } as unknown as DeviceRecord;

  function certBy(signer: Signer, issuer: string, over: Partial<DeviceCert> = {}): DeviceCert {
    const cert = {
      level: 'server' as const,
      issuer: { device: issuer },
      actor: record.actor,
      device: record.id,
      issuedAt: '2026-10-21T10:00:00.000Z',
      ...over,
    };
    return { ...cert, sig: signer.sign('aio.cert/1', contentHash(cert)) };
  }

  const answer = (server: Record<string, unknown>, cert: DeviceCert) =>
    fakeClient(() =>
      reply(200, {
        server: {
          name: 'Team',
          version: '0.2.0',
          fingerprint: 'a'.repeat(64),
          ...server,
        },
        cert,
        role: 'reviewer',
        projects: [],
      }),
    ).client;

  it('checks the device certificate against the server key', async () => {
    const { signer, key } = serverKey();
    const r = await enrolDevice(
      answer({ id: key.id, publicKey: key.publicKey }, certBy(signer, key.id)),
      'CODE',
      record,
    );
    expect(r.server.publicKey).toBe(key.publicKey);
  });

  it('accepts an older server that does not send its key', async () => {
    const r = await enrolDevice(
      answer(
        { id: 'srv_test' },
        { ...certBy(serverKey().signer, 'srv_test'), sig: 'A'.repeat(86) },
      ),
      'CODE',
      record,
    );
    expect(r.server.id).toBe('srv_test');
  });

  const bad: [string, () => HttpClient][] = [
    [
      'a server id that is not its key',
      () => {
        const { signer, key } = serverKey();
        return answer(
          { id: 'srv_aaaaaaaaaaaaaaaaaaaaaaaaaa', publicKey: key.publicKey },
          certBy(signer, key.id),
        );
      },
    ],
    [
      'a certificate signed by another key',
      () => {
        const { key } = serverKey();
        return answer({ id: key.id, publicKey: key.publicKey }, certBy(serverKey().signer, key.id));
      },
    ],
    [
      'a certificate for another device',
      () => {
        const { signer, key } = serverKey();
        return answer(
          { id: key.id, publicKey: key.publicKey },
          certBy(signer, key.id, { device: `d_${'a'.repeat(52)}` }),
        );
      },
    ],
    [
      'a certificate for another person',
      () => {
        const { signer, key } = serverKey();
        return answer(
          { id: key.id, publicKey: key.publicKey },
          certBy(signer, key.id, { actor: 'a_bbbbbbbbbbbbbbbbbbbbbbbbbb' }),
        );
      },
    ],
    [
      'a certificate from another issuer',
      () => {
        const { signer, key } = serverKey();
        return answer({ id: key.id, publicKey: key.publicKey }, certBy(signer, 'srv_other'));
      },
    ],
  ];

  it.each(bad)('refuses %s', async (_what, client) => {
    await expect(enrolDevice(client(), 'CODE', record)).rejects.toMatchObject({
      code: 'protocol',
    });
  });
});

describe('health', () => {
  const health = (server?: ServerKey) =>
    fakeClient(() =>
      reply(200, {
        ok: true,
        version: '0.2.0',
        protocol: { min: 1, max: 1 },
        ...(server ? { server } : {}),
      }),
    ).client;

  it('gives the server key when the server names one that matches', async () => {
    const { key } = serverKey();
    expect((await serverHealth(health(key))).server).toEqual(key);
    expect((await serverHealth(health())).server).toBeUndefined();
  });

  it('refuses a server id that is not its key', async () => {
    const { key } = serverKey();
    await expect(
      serverHealth(health({ id: 'srv_aaaaaaaaaaaaaaaaaaaaaaaaaa', publicKey: key.publicKey })),
    ).rejects.toMatchObject({ code: 'protocol' });
  });
});
