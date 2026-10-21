import { createHash, generateKeyPairSync, X509Certificate } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { contentHash, signerFromKey, type Signer } from '@aio/journal';
import { RECEIPT_SCHEMA, type Op, type Receipt, type ServerKey } from '@aio/schema';
import { serverIdFromKey } from '@aio/sync/http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDeviceKeys, createIdentityService, createIdentityStore } from './identity';
import { deviceSource } from './identityPorts';
import type { KeyEntry } from './keys';
import { collectHandlers } from './notYet';
import { registerTeamServerIpc, SERVERS_FILE, teamServers } from './teamServer';

const fixtures = fileURLToPath(
  new URL('../../../../packages/sync/src/http/__fixtures__/', import.meta.url),
);
const cert = readFileSync(join(fixtures, 'loopback-test-only.crt'));
const key = readFileSync(join(fixtures, 'loopback-test-only.key'));
const fingerprint = new X509Certificate(cert).fingerprint256.replace(/:/g, '').toLowerCase();

function memoryVault() {
  const values = new Map<string, string>();
  const vault = (service: string, account: string): KeyEntry => ({
    getPassword: () => values.get(`${service}/${account}`) ?? null,
    setPassword: (v) => {
      values.set(`${service}/${account}`, v);
    },
  });
  return { values, vault };
}

/** T2's identity service as the device source (one device key per profile, M9 integration). */
function identityDevice(userData: string, vault: ReturnType<typeof memoryVault>['vault']) {
  const service = createIdentityService({
    store: createIdentityStore(join(userData, 'identity.json'), { osUser: () => 'Rana Example' }),
    keys: createDeviceKeys('svc', vault),
    journal: {
      ops: () => Promise.resolve([]),
      append: () => Promise.reject(new Error('not used')),
      publishDevice: () => Promise.resolve(),
    },
    projectRoot: () => undefined,
    isPackage: () => false,
    chooseCardPath: () => Promise.resolve(null),
    app: { name: 'Quadrion AI', version: '0.9.0' },
  });
  return deviceSource(service, { name: 'Quadrion AI', version: '0.9.0' });
}

/** A team server signing key, its id made as the team server makes it. */
function serverKey(): { signer: Signer; key: ServerKey } {
  const signer = signerFromKey(generateKeyPairSync('ed25519').privateKey);
  return { signer, key: { id: serverIdFromKey(signer.publicKey), publicKey: signer.publicKey } };
}

interface FakeOptions {
  /** The server's signing key: its id names the server, it signs certificates and receipts. */
  signer?: Signer;
  /** Name the key in the enrol answer (a server from 2026-10-21). */
  enrolKey?: boolean;
  /** What health names as the server key (a server from 2026-10-21); none for an older one. */
  healthKey?: () => ServerKey | undefined;
  /** Who signs the device certificate (default: `signer`). */
  certSigner?: Signer;
  /** Who signs push receipts (default: `signer`). */
  receiptSigner?: () => Signer | undefined;
}

/** A stand-in team server: health and enrolment, recording what it was sent. */
async function fakeServer(opts: FakeOptions = {}) {
  const serverId = opts.signer ? serverIdFromKey(opts.signer.publicKey) : 'srv_test';
  let last: Receipt | null = null;
  const seen: { url: string; device: string | undefined; body: string }[] = [];
  const server: Server = createServer({ cert, key }, (req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString()));
    req.on('end', () => {
      const device = req.headers['x-aio-device'];
      seen.push({
        url: req.url ?? '',
        device: typeof device === 'string' ? device : undefined,
        body,
      });
      res.setHeader('content-type', 'application/json');
      if (req.url === '/v1/health') {
        const key = opts.healthKey?.();
        res.end(
          JSON.stringify({
            ok: true,
            version: '0.1.0',
            protocol: { min: 1, max: 1 },
            ...(key ? { server: key } : {}),
          }),
        );
        return;
      }
      if (req.method === 'POST' && /^\/v1\/projects\/[^/]+\/ops$/.test(req.url ?? '')) {
        const { ops } = JSON.parse(body) as { ops: { id: string }[] };
        const by = opts.receiptSigner?.() ?? opts.signer;
        const receipts = by
          ? ops.map((o) => {
              const r = {
                schema: RECEIPT_SCHEMA,
                server: serverId,
                seq: (last?.seq ?? 0) + 1,
                op: o.id,
                prev: last?.id ?? null,
                at: '2026-10-21T10:00:00.000Z',
              };
              const id = contentHash(r);
              last = { ...r, id, sig: by.sign('aio.receipt/1', id) };
              return last;
            })
          : [];
        res.end(
          JSON.stringify({ accepted: ops.map((o) => o.id), duplicates: [], refused: [], receipts }),
        );
        return;
      }
      if (req.url === '/v1/enrol') {
        const parsed = JSON.parse(body) as { code: string; device: { id: string; actor: string } };
        if (parsed.code !== 'GOOD-CODE-1234') {
          res.statusCode = 403;
          res.end(JSON.stringify({ error: 'This invite code is not valid.', code: 'invite' }));
          return;
        }
        const cert = {
          level: 'server',
          issuer: { device: serverId },
          actor: parsed.device.actor,
          device: parsed.device.id,
          issuedAt: '2026-10-07T10:00:00.000Z',
        };
        res.end(
          JSON.stringify({
            server: {
              id: serverId,
              name: 'Test team server',
              version: '0.1.0',
              fingerprint,
              ...(opts.signer && opts.enrolKey ? { publicKey: opts.signer.publicKey } : {}),
            },
            cert: {
              ...cert,
              sig:
                (opts.certSigner ?? opts.signer)?.sign('aio.cert/1', contentHash(cert)) ??
                'A'.repeat(86),
            },
            role: 'reviewer',
            projects: [],
          }),
        );
        return;
      }
      res.statusCode = 404;
      res.end('{}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    server,
    seen,
    serverId,
    origin: `https://127.0.0.1:${(server.address() as AddressInfo).port}`,
  };
}

const PROJECT = 't_vm6cv3mws7bgecezd4hkxj6qqt';
const opId = (n: number) => createHash('sha256').update(`op ${n}`).digest('hex');
/** The transport only sends an op's JSON and reads its id. */
const op = (n: number): Op => ({ id: opId(n) }) as unknown as Op;

const savedServers = (userData: string) =>
  JSON.parse(readFileSync(join(userData, SERVERS_FILE), 'utf8')) as {
    servers: { id: string; publicKey?: string }[];
  };

describe('team server client (main)', () => {
  let fake: Awaited<ReturnType<typeof fakeServer>>;
  beforeAll(async () => {
    fake = await fakeServer();
  });
  afterAll(() => {
    fake.server.close();
  });

  const setup = (offline = false) => {
    const userData = mkdtempSync(join(tmpdir(), 'aio-ts-'));
    const { vault, values } = memoryVault();
    const device = identityDevice(userData, vault);
    const ipc = collectHandlers((handle) => {
      registerTeamServerIpc({
        handle,
        userData: () => userData,
        offlineOnly: () => offline,
        device,
        now: () => new Date('2026-10-07T10:00:00.000Z'),
      });
    });
    return { userData, ipc, values, device };
  };

  it('shows the fingerprint first, then enrols pinned to it', async () => {
    const { ipc, userData } = setup();
    const first = await ipc.call('server:enrol', {
      url: `${fake.origin}/`,
      code: 'GOOD-CODE-1234',
    });
    expect(first).toMatchObject({ ok: false, fingerprint });
    expect(fake.seen).toEqual([]);

    const r = await ipc.call('server:enrol', {
      url: fake.origin,
      code: 'GOOD-CODE-1234',
      fingerprint,
    });
    expect(r).toEqual({
      ok: true,
      server: {
        id: 'srv_test',
        url: fake.origin,
        name: 'Test team server',
        fingerprint,
        version: '0.1.0',
        enrolledAt: '2026-10-07T10:00:00.000Z',
        role: 'reviewer',
      },
    });
    // every request but health is signed by the device key
    expect(fake.seen.map((s) => s.url)).toEqual(['/v1/health', '/v1/enrol']);
    expect(fake.seen[1]?.device).toMatch(/^d_[a-z2-7]{52}$/);
    expect(await ipc.call('server:list', {})).toEqual({ servers: [r.ok ? r.server : null] });
    // the server's certificate for this device is kept; no key ever is
    const saved = readFileSync(join(userData, SERVERS_FILE), 'utf8');
    expect(saved).toContain('"level": "server"');
    expect(saved).not.toMatch(/pkcs8|PRIVATE/);
  });

  it('refuses a server whose certificate is not the accepted one, before sending anything', async () => {
    const { ipc } = setup();
    const before = fake.seen.length;
    const r = await ipc.call('server:enrol', {
      url: fake.origin,
      code: 'GOOD-CODE-1234',
      fingerprint: 'a'.repeat(64),
    });
    expect(r.ok).toBe(false);
    expect(r.ok ? '' : r.error).toMatch(/different certificate/);
    expect(fake.seen.length).toBe(before);
  });

  it("passes on the server's refusal of an invite code", async () => {
    const { ipc } = setup();
    const r = await ipc.call('server:enrol', {
      url: fake.origin,
      code: 'WRONG-CODE-99',
      fingerprint,
    });
    expect(r).toEqual({ ok: false, error: 'This invite code is not valid.', code: 'forbidden' });
  });

  it('makes no connection when offline only is on', async () => {
    const { ipc } = setup(true);
    const before = fake.seen.length;
    const r = await ipc.call('server:enrol', { url: fake.origin, code: 'GOOD-CODE-1234' });
    expect(r).toMatchObject({ ok: false, code: 'offline-only' });
    expect(fake.seen.length).toBe(before);
  });

  it('forgets a server', async () => {
    const { ipc } = setup();
    await ipc.call('server:enrol', { url: fake.origin, code: 'GOOD-CODE-1234', fingerprint });
    expect(await ipc.call('server:forget', { id: 'srv_test' })).toEqual({ ok: true });
    expect(await ipc.call('server:list', {})).toEqual({ servers: [] });
    expect(await ipc.call('server:forget', { id: 'srv_test' })).toMatchObject({ ok: false });
  });

  it('gives a server-mode project a transport pinned to the server', async () => {
    const { userData, device } = setup();
    const servers = teamServers({ userData: () => userData, offlineOnly: () => false, device });
    await servers.enrol({ url: fake.origin, code: 'GOOD-CODE-1234', fingerprint });
    const t = await servers.transport('srv_test', 't_vm6cv3mws7bgecezd4hkxj6qqt');
    expect(t.kind).toBe('server');
    await expect(servers.transport('srv_other', 't_vm6cv3mws7bgecezd4hkxj6qqt')).rejects.toThrow(
      /not connected/,
    );
  });
});

describe('team server signing key (main)', () => {
  const opened: Awaited<ReturnType<typeof fakeServer>>[] = [];
  afterAll(() => {
    for (const f of opened) f.server.close();
  });
  const start = async (opts: FakeOptions) => {
    const f = await fakeServer(opts);
    opened.push(f);
    return f;
  };
  const servers = () => {
    const userData = mkdtempSync(join(tmpdir(), 'aio-ts-'));
    const device = identityDevice(userData, memoryVault().vault);
    return {
      userData,
      servers: teamServers({ userData: () => userData, offlineOnly: () => false, device }),
    };
  };

  it('pins the key a server names at enrolment and checks receipts with it', async () => {
    const { signer, key } = serverKey();
    let receiptSigner: Signer = signer;
    const f = await start({
      signer,
      enrolKey: true,
      healthKey: () => key,
      receiptSigner: () => receiptSigner,
    });
    const { userData, servers: s } = servers();
    const r = await s.enrol({ url: f.origin, code: 'GOOD-CODE-1234', fingerprint });
    expect(r).toMatchObject({ ok: true, server: { id: key.id } });
    // the key is kept, the public shape does not change
    expect(r.ok ? Object.keys(r.server) : []).not.toContain('publicKey');
    expect(s.list()[0]).not.toHaveProperty('publicKey');
    expect(savedServers(userData).servers[0]?.publicKey).toBe(key.publicKey);

    const t = await s.transport(key.id, PROJECT);
    expect((await t.pushOps([op(1), op(2)])).accepted).toEqual([opId(1), opId(2)]);
    receiptSigner = serverKey().signer;
    await expect(t.pushOps([op(3)])).rejects.toMatchObject({
      code: 'protocol',
      message: expect.stringMatching(/receipt that does not verify/) as unknown,
    });
  });

  it('pins the key from health when the enrol answer does not name it', async () => {
    const { signer, key } = serverKey();
    const f = await start({ signer, healthKey: () => key });
    const { userData, servers: s } = servers();
    expect(await s.enrol({ url: f.origin, code: 'GOOD-CODE-1234', fingerprint })).toMatchObject({
      ok: true,
    });
    expect(savedServers(userData).servers[0]?.publicKey).toBe(key.publicKey);
  });

  it('refuses an enrolment whose health and enrol answers name different keys', async () => {
    const { signer } = serverKey();
    const other = serverKey().key;
    const f = await start({ signer, enrolKey: true, healthKey: () => other });
    const { userData, servers: s } = servers();
    const r = await s.enrol({ url: f.origin, code: 'GOOD-CODE-1234', fingerprint });
    expect(r.ok).toBe(false);
    expect(s.list()).toEqual([]);
    expect(() => readFileSync(join(userData, SERVERS_FILE))).toThrow();
  });

  it('refuses a device certificate the named key did not sign', async () => {
    const { signer, key } = serverKey();
    // health names the key; the enrol answer (no key) carries a certificate another key signed
    const f = await start({ signer, healthKey: () => key, certSigner: serverKey().signer });
    const r = await servers().servers.enrol({ url: f.origin, code: 'GOOD-CODE-1234', fingerprint });
    expect(r.ok).toBe(false);
  });

  it('pins the key on the next contact for an enrolment from before keys, then holds to it', async () => {
    const { signer, key } = serverKey();
    let named: ServerKey | undefined;
    const f = await start({ signer, healthKey: () => named });
    const { userData, servers: s } = servers();
    await s.enrol({ url: f.origin, code: 'GOOD-CODE-1234', fingerprint });
    expect(savedServers(userData).servers[0]?.publicKey).toBeUndefined();
    // the server is updated: health names its key, the next check pins it
    named = key;
    expect(await s.check(key.id)).toMatchObject({ ok: true, server: { reachable: true } });
    expect(savedServers(userData).servers[0]?.publicKey).toBe(key.publicKey);

    // a different key afterwards is refused
    named = serverKey().key;
    expect(await s.check(key.id)).toMatchObject({ ok: true, server: { reachable: false } });
    await expect(s.transport(key.id, PROJECT)).rejects.toMatchObject({
      code: 'fingerprint',
      message: expect.stringMatching(/signing key changed/) as unknown,
    });
    expect(savedServers(userData).servers[0]?.publicKey).toBe(key.publicKey);
  });

  it('pins the key through the transport too, and reads an old servers file', async () => {
    const { signer, key } = serverKey();
    const f = await start({ signer, healthKey: () => key });
    const { userData, servers: s } = servers();
    // a servers file written before keys were pinned
    mkdirSync(join(userData, 'team'), { recursive: true });
    writeFileSync(
      join(userData, SERVERS_FILE),
      JSON.stringify({
        schema: 'aio.team-servers/1',
        servers: [
          {
            id: key.id,
            url: f.origin,
            name: 'Test team server',
            fingerprint,
            version: '0.1.0',
            enrolledAt: '2026-10-07T10:00:00.000Z',
            role: 'reviewer',
            cert: {
              level: 'server',
              issuer: { device: key.id },
              actor: 'a_aaaaaaaaaaaaaaaaaaaaaaaaaa',
              device: `d_${'a'.repeat(52)}`,
              issuedAt: '2026-10-07T10:00:00.000Z',
              sig: 'A'.repeat(86),
            },
          },
        ],
      }),
    );
    expect(s.list().map((x) => x.id)).toEqual([key.id]);
    const t = await s.transport(key.id, PROJECT);
    expect(savedServers(userData).servers[0]?.publicKey).toBe(key.publicKey);
    expect((await t.pushOps([op(7)])).receipts).toHaveLength(1);
  });

  it('refuses a server that names another server id on the next contact', async () => {
    const { signer, key } = serverKey();
    const named: { key?: ServerKey } = {};
    const f = await start({ signer, healthKey: () => named.key });
    const { userData, servers: s } = servers();
    await s.enrol({ url: f.origin, code: 'GOOD-CODE-1234', fingerprint });
    named.key = serverKey().key;
    await expect(s.transport(key.id, PROJECT)).rejects.toMatchObject({ code: 'fingerprint' });
    expect(savedServers(userData).servers[0]?.publicKey).toBeUndefined();
  });
});
