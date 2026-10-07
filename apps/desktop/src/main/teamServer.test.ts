import { X509Certificate } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { contentHash, verifySignature } from '@aio/journal';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { collectHandlers } from './notYet';
import {
  initialsOf,
  interimDeviceSource,
  registerTeamServerIpc,
  SERVERS_FILE,
  teamServers,
  type VaultEntry,
} from './teamServer';

const fixtures = fileURLToPath(
  new URL('../../../../packages/sync/src/http/__fixtures__/', import.meta.url),
);
const cert = readFileSync(join(fixtures, 'loopback-test-only.crt'));
const key = readFileSync(join(fixtures, 'loopback-test-only.key'));
const fingerprint = new X509Certificate(cert).fingerprint256.replace(/:/g, '').toLowerCase();

function memoryVault() {
  const values = new Map<string, string>();
  const vault = (account: string): VaultEntry => ({
    getPassword: () => values.get(account) ?? null,
    setPassword: (v) => {
      values.set(account, v);
    },
  });
  return { values, vault };
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
    const device = interimDeviceSource({
      userData: () => userData,
      vault,
      app: { name: 'Stratlas', version: '0.9.0' },
    });
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

describe('interim device key', () => {
  it('lives in the vault, signs its own record and is stable', async () => {
    const userData = mkdtempSync(join(tmpdir(), 'aio-ts-'));
    const { vault, values } = memoryVault();
    const source = () =>
      interimDeviceSource({
        userData: () => userData,
        vault,
        app: { name: 'Stratlas', version: '0.9.0' },
      });
    const a = await source()();
    const b = await source()();
    expect(a?.record.id).toBe(b?.record.id);
    expect(values.size).toBe(1);
    const rec = a?.record;
    if (!rec) throw new Error('no device');
    const { sig, ...signed } = rec;
    expect(verifySignature(rec.key, 'aio.device/1', contentHash(signed), sig)).toBe(true);
    expect(existsSync(join(userData, 'team'))).toBe(false);
  });

  it("takes the person's name from identity.json when T2 wrote one", async () => {
    const userData = mkdtempSync(join(tmpdir(), 'aio-ts-'));
    writeFileSync(
      join(userData, 'identity.json'),
      JSON.stringify({
        schema: 'aio.identity/1',
        actor: 'a_k7jjnlwiekmnw7rmq52c2m7zz6',
        name: 'Rana Example',
        initials: 'RE',
        createdAt: '2026-10-01T08:00:00.000Z',
      }),
    );
    const d = await interimDeviceSource({
      userData: () => userData,
      vault: memoryVault().vault,
      app: { name: 'Stratlas', version: '0.9.0' },
    })();
    expect(d?.record).toMatchObject({
      actor: 'a_k7jjnlwiekmnw7rmq52c2m7zz6',
      name: 'Rana Example',
      initials: 'RE',
    });
  });

  it('gives no device when the vault fails', async () => {
    const d = await interimDeviceSource({
      userData: () => tmpdir(),
      vault: () => {
        throw new Error('no vault');
      },
      app: { name: 'Stratlas', version: '0.9.0' },
    })();
    expect(d).toBeNull();
  });

  it('derives initials in any script', () => {
    expect(initialsOf('Rana Example')).toBe('RE');
    expect(initialsOf('omar.sample')).toBe('OS');
    expect(initialsOf('رنا مثال')).toBe('رم');
    expect(initialsOf('42')).toBe('U');
  });
});
