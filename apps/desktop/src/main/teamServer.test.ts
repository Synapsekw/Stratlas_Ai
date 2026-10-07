import { X509Certificate } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
    app: { name: 'Stratlas', version: '0.9.0' },
  });
  return deviceSource(service, { name: 'Stratlas', version: '0.9.0' });
}

/** A stand-in team server: health and enrolment, recording what it was sent. */
async function fakeServer() {
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
        res.end(JSON.stringify({ ok: true, version: '0.1.0', protocol: { min: 1, max: 1 } }));
        return;
      }
      if (req.url === '/v1/enrol') {
        const parsed = JSON.parse(body) as { code: string; device: { id: string; actor: string } };
        if (parsed.code !== 'GOOD-CODE-1234') {
          res.statusCode = 403;
          res.end(JSON.stringify({ error: 'This invite code is not valid.', code: 'invite' }));
          return;
        }
        res.end(
          JSON.stringify({
            server: { id: 'srv_test', name: 'Test team server', version: '0.1.0', fingerprint },
            cert: {
              level: 'server',
              issuer: { device: 'srv_test' },
              actor: parsed.device.actor,
              device: parsed.device.id,
              issuedAt: '2026-10-07T10:00:00.000Z',
              sig: 'A'.repeat(86),
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
  return { server, seen, origin: `https://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

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
