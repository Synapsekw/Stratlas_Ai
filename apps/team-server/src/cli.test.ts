import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeInvite } from './auth/enrol';
import { runCli, parseArgs } from './cli';
import { ConfigError, readConfig, requireTls } from './config';
import { createCore } from './core';
import { loadOrCreateIdentity } from './identity';
import { createMemoryStore } from './store/memory';
import type { Store } from './store/store';
import { ChainWriter, memberAdd, TEST_TEAM, testPeople, testTls } from './testkit';
import { SERVER_VERSION } from './version';

function cli(store: Store, env: NodeJS.ProcessEnv = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const run = (...argv: string[]) =>
    runCli(argv, {
      env: { AIO_HOST: '127.0.0.1', ...env },
      print: (l) => out.push(l),
      error: (l) => err.push(l),
      store,
    });
  return { run, out, err };
}

/** A store with a shared project: Rana (owner) and Omar (reviewer), five ops, their receipts. */
async function populated(keyFile: string) {
  const { rana, omar } = testPeople();
  const store = createMemoryStore();
  const core = createCore({
    store,
    identity: loadOrCreateIdentity(keyFile),
    name: 'Test',
    version: SERVER_VERSION,
    fingerprint: '0'.repeat(64),
  });
  const devices = [];
  for (const [p, role] of [
    [rana, 'owner'],
    [omar, 'reviewer'],
  ] as const) {
    const { code, invite } = makeInvite(role, null, new Date());
    await store.addInvite(invite);
    await core.enrol({ code, device: p.record }, p.signer.device);
    devices.push(await store.device(p.signer.device));
  }
  const R = new ChainWriter(rana);
  const O = new ChainWriter(omar, Date.parse('2026-10-01T12:00:00.000Z'));
  const issue = { rec: 'issue', id: 'i_f01' };
  const [ranaDevice, omarDevice] = devices;
  if (!ranaDevice || !omarDevice) throw new Error('not enrolled');
  await core.push(ranaDevice, TEST_TEAM, [
    R.next(
      'project.share',
      { rec: 'project', id: TEST_TEAM },
      { teamProjectId: TEST_TEAM, name: 'Demo' },
    ),
    R.next('member.add', { rec: 'member', id: rana.actor }, memberAdd(rana, 'owner')),
    R.next('issue.create', issue, { record: { id: 'i_f01', code: 'F01' } }),
  ]);
  // Omar was invited to the server, not yet added by Rana: his ops count by the invite's role
  await core.push(omarDevice, TEST_TEAM, [
    O.next('issue.patch', issue, { set: { severity: 4 } }),
    O.next('issue.patch', issue, { set: { severity: 5 } }),
  ]);
  return store;
}

describe('admin command line', () => {
  it('reads commands and flags', () => {
    expect(parseArgs(['invite', '--role', 'viewer', '--x', '--days', '3', 'pos'])).toEqual({
      command: 'invite',
      positional: ['pos'],
      flags: new Map<string, string | true>([
        ['role', 'viewer'],
        ['x', true],
        ['days', '3'],
      ]),
    });
    expect(parseArgs([]).command).toBe('serve');
  });

  it('names the server and prints invites that enrol', async () => {
    const store = createMemoryStore();
    const { run, out, err } = cli(store);
    expect(await run('version')).toBe(0);
    expect(out.at(-1)).toMatch(/^Team Server \(preview\) \d/);
    expect(await run('create-team', '--name', 'Survey team (synthetic)')).toBe(0);
    expect(await store.meta('name')).toBe('Survey team (synthetic)');
    expect(out.at(-1)).toMatch(/Owner invite code .*: [0-9A-Z]{4}-/);
    expect(await run('invite', '--role', 'reviewer', '--project', TEST_TEAM)).toBe(0);
    expect(out.at(-1)).toMatch(new RegExp(`reviewer of ${TEST_TEAM}`));
    const invites = await store.invites();
    expect(invites.map((i) => [i.role, i.project])).toEqual([
      ['owner', null],
      ['reviewer', TEST_TEAM],
    ]);
    expect(await run('invite', '--role', 'boss')).toBe(2);
    expect(err.at(-1)).toMatch(/owner, reviewer, viewer or client/);
    expect(await run('nonsense')).toBe(2);
  });

  it('lists and revokes devices', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aio-cli-'));
    const store = await populated(join(dir, 'server-key.pem'));
    const { run, out } = cli(store, { AIO_DATA_DIR: dir });
    const { omar } = testPeople();
    expect(await run('devices')).toBe(0);
    expect(out.join('\n')).toContain('Omar Sample (OS)  reviewer');
    expect(await run('revoke-device', omar.signer.device, '--reason', 'lost laptop')).toBe(0);
    expect((await store.device(omar.signer.device))?.revokedAt).not.toBeNull();
    expect(await run('revoke-device', 'd_nothing')).toBe(2);
  });

  it('exports the audit of a project and verifies it, and finds an edit', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aio-cli-'));
    const store = await populated(join(dir, 'server-key.pem'));
    const { run, out } = cli(store, { AIO_DATA_DIR: dir });
    const exported = join(dir, 'audit');
    expect(await run('export-audit', '--project', TEST_TEAM, '--out', exported)).toBe(0);
    expect(await run('verify', exported)).toBe(0);
    expect(out.at(-1)).toBe('Verified: no problems.');
    expect(out.at(-2)).toBe('5 ops in 2 chains, 5 countersigned.');
    // edit one op on disk: the export no longer verifies
    const { omar } = testPeople();
    const seg = join(exported, 'journal', 'ops', omar.chain, '000001.jsonl');
    writeFileSync(seg, readFileSync(seg, 'utf8').replace('"severity":5', '"severity":1'));
    expect(await run('verify', exported)).toBe(1);
    expect(out.join('\n')).toMatch(/payload does not match its hash/);
  });

  it('backs up and restores a server, refusing a damaged backup', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aio-cli-'));
    const store = await populated(join(dir, 'server-key.pem'));
    const file = join(dir, 'backup.jsonl');
    expect(await cli(store, { AIO_DATA_DIR: dir }).run('backup', '--out', file)).toBe(0);

    const restored = createMemoryStore();
    const r = cli(restored, { AIO_DATA_DIR: dir });
    expect(await r.run('restore', '--in', file)).toBe(0);
    expect(await restored.heads(TEST_TEAM)).toEqual(await store.heads(TEST_TEAM));
    expect(await restored.receipts(0, 100)).toEqual(await store.receipts(0, 100));
    expect(await restored.devices()).toEqual(await store.devices());
    expect(await r.run('restore', '--in', file)).toBe(1);
    expect(r.err.at(-1)).toBe('Restore needs an empty database.');

    const damaged = join(dir, 'damaged.jsonl');
    const lines = readFileSync(file, 'utf8').split('\n');
    const i = lines.findIndex((l) => l.startsWith('{"t":"receipt"'));
    lines[i] = (lines[i] ?? '').replace(/"seq":1/, '"seq":7');
    writeFileSync(damaged, lines.join('\n'));
    const empty = createMemoryStore();
    const d = cli(empty, { AIO_DATA_DIR: dir });
    expect(await d.run('restore', '--in', damaged)).toBe(1);
    expect(d.err.at(-1)).toMatch(/receipt chain .* does not verify/);
    expect(await empty.projects()).toEqual([]);
    appendFileSync(file, '{"t":"op","project":"x","op":{}}\n');
    expect(await d.run('restore', '--in', file)).toBe(1);
    expect(d.err.at(-1)).toMatch(/after its end/);
  });
});

describe('server settings', () => {
  it('require TLS unless the server only listens on this computer', () => {
    expect(() => {
      requireTls(readConfig({ AIO_HOST: '0.0.0.0' }));
    }).toThrow(/TLS is required/);
    expect(() => {
      requireTls(readConfig({ AIO_HOST: '127.0.0.1' }));
    }).not.toThrow();
    expect(() => {
      requireTls(
        readConfig({ AIO_BEHIND_TLS_PROXY: '1', AIO_PUBLIC_URL: 'https://team.example.com' }),
      );
    }).not.toThrow();
    expect(() => readConfig({ AIO_BEHIND_TLS_PROXY: '1' })).toThrow(ConfigError);
    expect(() => readConfig({ AIO_TLS_CERT_FILE: 'x.pem' })).toThrow(/both/);
    expect(() => readConfig({ AIO_PUBLIC_URL: 'http://team.example.com' })).toThrow(/https origin/);
  });

  it('read the certificate and its fingerprint', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aio-cfg-'));
    const tls = testTls();
    writeFileSync(join(dir, 'c.pem'), tls.cert);
    writeFileSync(join(dir, 'k.pem'), tls.key);
    const c = readConfig({
      AIO_TLS_CERT_FILE: join(dir, 'c.pem'),
      AIO_TLS_KEY_FILE: join(dir, 'k.pem'),
    });
    expect(c.fingerprint).toBe(tls.fingerprint);
    expect(() => {
      requireTls(c);
    }).not.toThrow();
  });

  it('keep the version equal to the package', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      version: string;
    };
    expect(SERVER_VERSION).toBe(pkg.version);
  });
});
