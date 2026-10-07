import { checkOp, deviceIdFromKey } from '@aio/journal';
import { Identity, IdentityCard } from '@aio/schema';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  checkCard,
  createDeviceKeys,
  createFileTeamJournal,
  createIdentityService,
  createIdentityStore,
  makeCard,
  profileFromArgv,
  profileUserData,
  profileVaultService,
  registerIdentityIpc,
} from './identity';
import type { KeyEntry } from './keys';
import { collectHandlers } from './notYet';

const APP = { name: 'Stratlas', version: '0.9.0' };
const AT = new Date('2026-10-07T10:00:00.000Z');

/** In-memory stand-in for the OS credential vault. */
function memoryVault() {
  const store = new Map<string, string>();
  const entry = (service: string, account: string): KeyEntry => ({
    setPassword: (p) => {
      store.set(`${service}/${account}`, p);
    },
    getPassword: () => store.get(`${service}/${account}`) ?? null,
  });
  return { store, entry };
}

const brokenVault = (): KeyEntry => ({
  setPassword: () => {
    throw new Error('vault locked');
  },
  getPassword: () => {
    throw new Error('vault locked');
  },
});

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'aio-identity-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('--profile', () => {
  it('reads a valid profile name from the command line', () => {
    expect(profileFromArgv(['electron', 'main.js', '--profile=reviewer-b'])).toBe('reviewer-b');
    expect(profileFromArgv(['electron', 'main.js'])).toBeNull();
    expect(profileFromArgv(['x', '--profile=../evil'])).toBeNull();
    expect(profileFromArgv(['x', '--profile='])).toBeNull();
  });

  it('keeps userData and the vault service apart per profile', () => {
    expect(profileUserData(join('u', 'Stratlas'), 'b')).toBe(
      join('u', 'Stratlas', 'profiles', 'b'),
    );
    expect(profileVaultService('ai.synapse.stratlas', 'b')).toBe('ai.synapse.stratlas.profile.b');
    expect(profileVaultService('ai.synapse.stratlas.isolated', null)).toBe(
      'ai.synapse.stratlas.isolated',
    );
  });
});

describe('identity file', () => {
  const file = () => join(dir, 'identity.json');

  it('starts from the OS account with initials and a permanent actor id', async () => {
    const store = createIdentityStore(file(), { osUser: () => 'Rana Example', now: () => AT });
    const me = await store.get();
    expect(me).toMatchObject({
      schema: 'aio.identity/1',
      name: 'Rana Example',
      initials: 'RE',
      migratedFrom: 'os-account',
      createdAt: AT.toISOString(),
    });
    expect(me.actor).toMatch(/^a_[a-z2-7]{26}$/);
    const again = createIdentityStore(file(), { osUser: () => 'Someone Else' });
    expect((await again.get()).actor).toBe(me.actor);
    expect(Identity.parse(JSON.parse(await readFile(file(), 'utf8')))).toEqual(me);
  });

  it('moves the old "Your name on issues" over once, so nobody loses their name', async () => {
    const store = createIdentityStore(file(), { osUser: () => 'rana' });
    const me = await store.set({ migrateFrom: 'Rana Example' });
    expect(me).toMatchObject({
      name: 'Rana Example',
      initials: 'RE',
      migratedFrom: 'author-setting',
    });
    // a second migration (another window, a later start) changes nothing
    expect((await store.set({ migrateFrom: 'Old Name' })).name).toBe('Rana Example');
  });

  it('takes the old name even when the OS default was made first', async () => {
    const store = createIdentityStore(file(), { osUser: () => 'rana' });
    const first = await store.get();
    expect(first.name).toBe('rana');
    const me = await store.set({ migrateFrom: 'Rana Example' });
    expect(me).toMatchObject({
      actor: first.actor,
      name: 'Rana Example',
      migratedFrom: 'author-setting',
    });
  });

  it('never replaces a name the person typed with the old setting', async () => {
    const store = createIdentityStore(file(), { osUser: () => 'rana' });
    await store.set({ name: 'Rana Example' });
    expect((await store.set({ migrateFrom: 'Old Name' })).name).toBe('Rana Example');
  });

  it('keeps initials following the name until the person sets their own', async () => {
    const store = createIdentityStore(file(), { osUser: () => 'Rana Example' });
    expect((await store.set({ name: 'Omar Sample' })).initials).toBe('OS');
    expect((await store.set({ initials: 'DR' })).initials).toBe('DR');
    expect((await store.set({ name: 'Lina Example' })).initials).toBe('DR');
    expect((await store.set({ email: 'lina@example.com' })).email).toBe('lina@example.com');
    expect((await store.set({ email: '' })).email).toBeUndefined();
  });

  it('never overwrites a damaged identity file', async () => {
    await writeFile(file(), '{ not json');
    const store = createIdentityStore(file(), { osUser: () => 'rana' });
    await expect(store.get()).rejects.toThrow(/could not be read/);
    expect(await readFile(file(), 'utf8')).toBe('{ not json');
  });
});

describe('device key in the vault', () => {
  it('makes the key on first need, stores it and derives the device id from it', () => {
    const vault = memoryVault();
    const keys = createDeviceKeys('svc', vault.entry);
    expect(keys.peek()).toEqual({ device: null, unsigned: false });
    const key = keys.get();
    expect(key.stored).toBe(true);
    expect(vault.store.has('svc/device-signing')).toBe(true);
    expect(key.signer.device).toBe(deviceIdFromKey(Buffer.from(key.signer.publicKey, 'base64url')));
    // a new run reads the same key back
    const again = createDeviceKeys('svc', vault.entry);
    expect(again.peek().device).toBe(key.signer.device);
    expect(again.get().signer.publicKey).toBe(key.signer.publicKey);
  });

  it('works unsigned for this run when the vault fails, and never logs the key', () => {
    const logs: string[] = [];
    const secrets: string[] = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => {
      logs.push(a.map(String).join(' '));
    });
    const keys = createDeviceKeys('svc', brokenVault, (s) => secrets.push(s));
    const key = keys.get();
    expect(key.stored).toBe(false);
    expect(keys.peek()).toEqual({ device: key.signer.device, unsigned: true });
    expect(logs.join('\n')).toMatch(/vault locked/);
    warn.mockRestore();

    // and with a working vault the key text goes to the redaction list, never to a log
    const vault = memoryVault();
    const logged: string[] = [];
    const spy = vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => {
      logged.push(a.map(String).join(' '));
    });
    createDeviceKeys('svc', vault.entry, (s) => secrets.push(s)).get();
    spy.mockRestore();
    const stored = vault.store.get('svc/device-signing') ?? '';
    expect(secrets).toContain(stored);
    expect(logged.join('\n')).not.toContain(stored);
  });
});

describe('identity cards', () => {
  const me = Identity.parse({
    schema: 'aio.identity/1',
    actor: `a_${'b'.repeat(26)}`,
    name: 'Omar Sample',
    initials: 'OS',
    email: 'omar@example.com',
    createdAt: AT.toISOString(),
  });

  it('round-trips a self-signed card', () => {
    const key = createDeviceKeys('svc', memoryVault().entry).get();
    const card = makeCard(me, key.signer, APP, AT);
    expect(IdentityCard.parse(card).device.id).toBe(key.signer.device);
    const r = checkCard(JSON.stringify(card));
    expect(r).toEqual({ ok: true, card });
  });

  it('refuses a changed card, a wrong device and something else', () => {
    const key = createDeviceKeys('svc', memoryVault().entry).get();
    const card = makeCard(me, key.signer, APP, AT);
    expect(checkCard(JSON.stringify({ ...card, name: 'Rana Example' }))).toEqual({
      ok: false,
      error:
        'The signature on this identity card does not match. It was changed after it was made.',
    });
    const other = createDeviceKeys('svc', memoryVault().entry).get();
    expect(
      checkCard(JSON.stringify({ ...card, device: { ...card.device, id: other.signer.device } })),
    ).toMatchObject({
      ok: false,
      error: 'The device on this identity card does not match its key.',
    });
    expect(checkCard('hello')).toEqual({ ok: false, error: 'This file is not an identity card.' });
    expect(checkCard('{"schema":"aio.idcard/1"}')).toMatchObject({ ok: false });
  });
});

/** One person on one machine against a shared project folder. */
function personAt(root: string, name: string, opts: { packages?: string[] } = {}) {
  const vault = memoryVault();
  const keys = createDeviceKeys('svc', vault.entry);
  const store = createIdentityStore(join(dir, `${name}.json`), { osUser: () => name });
  const saved: string[] = [];
  const service = createIdentityService({
    store,
    keys,
    journal: createFileTeamJournal(),
    projectRoot: (id) => (id === 'p' ? root : undefined),
    isPackage: (id) => (opts.packages ?? []).includes(id),
    chooseCardPath: (defaultName) => {
      const path = join(dir, `${name}-${defaultName}`);
      saved.push(path);
      return Promise.resolve(path);
    },
    app: APP,
  });
  const ipc = collectHandlers((handle) => {
    registerIdentityIpc({ handle, service });
  });
  return { ipc, keys, store, saved };
}

describe('identity IPC', () => {
  it('registers every identity and members channel', () => {
    const { ipc } = personAt(dir, 'Rana Example');
    expect(ipc.channels()).toEqual([
      'identity:exportCard',
      'identity:get',
      'identity:importCard',
      'identity:set',
      'members:add',
      'members:list',
      'members:remove',
      'members:revokeDevice',
      'members:setRole',
    ]);
  });

  it('answers identity:get with the device once the key exists', async () => {
    const { ipc } = personAt(dir, 'Rana Example');
    const first = await ipc.call('identity:get', {});
    expect(first).toMatchObject({ ok: true, device: null, unsigned: false });
    await ipc.call('identity:exportCard', {});
    const after = await ipc.call('identity:get', {});
    expect(after.ok && after.device).toMatch(/^d_/);
  });

  it('exports a card, reads it back, and adds that person as an owner-certified reviewer', async () => {
    const project = join(dir, 'project');
    const rana = personAt(project, 'Rana Example');
    const omar = personAt(project, 'Omar Sample');
    expect(await omar.ipc.call('identity:set', { initials: 'OS' })).toMatchObject({ ok: true });
    const exported = await omar.ipc.call('identity:exportCard', {});
    expect(exported).toMatchObject({ ok: true });
    const path = exported.ok ? (exported.path ?? '') : '';
    expect(path.endsWith('Omar Sample.aioid')).toBe(true);

    const read = await rana.ipc.call('identity:importCard', { path });
    expect(read).toMatchObject({ ok: true, name: 'Omar Sample', initials: 'OS' });

    // the project is not shared yet: no members, no roles
    expect(await rana.ipc.call('members:list', { projectId: 'p' })).toEqual({
      ok: true,
      members: [],
    });
    const added = await rana.ipc.call('members:add', {
      projectId: 'p',
      card: path,
      role: 'reviewer',
      certify: true,
    });
    expect(added).toMatchObject({
      ok: true,
      member: { name: 'Omar Sample', role: 'reviewer', verification: 'owner' },
    });
    const list = await rana.ipc.call('members:list', { projectId: 'p' });
    expect(list.ok && list.members.map((m) => [m.name, m.role, m.verification])).toEqual([
      ['Rana Example', 'owner', 'self'],
      ['Omar Sample', 'reviewer', 'owner'],
    ]);
    expect(list.ok && list.me).toBe('owner');
    const omarList = await omar.ipc.call('members:list', { projectId: 'p' });
    expect(omarList.ok && omarList.me).toBe('reviewer');

    // every op written is chained and signed, and the device record is public
    const journal = createFileTeamJournal();
    const ops = await journal.ops(project);
    expect(ops.map((o) => o.kind)).toEqual(['member.add', 'member.add']);
    expect(ops.map((o) => o.seq)).toEqual([1, 2]);
    expect(ops[1]?.prev).toBe(ops[0]?.id);
    const key = rana.keys.get().signer;
    for (const op of ops) {
      expect(checkOp(op, key.publicKey)).toEqual({ id: true, payload: true, signature: true });
    }
    const device = JSON.parse(
      await readFile(join(project, 'journal', 'devices', `${key.device}.json`), 'utf8'),
    ) as { key: string; name: string };
    expect(device).toMatchObject({ key: key.publicKey, name: 'Rana Example' });
    // no secret in the project
    const vaultText = JSON.stringify([...ops, device]);
    expect(vaultText).not.toMatch(/PRIVATE|pkcs8/i);
  });

  it('explains a refusal: a reviewer cannot change roles, and a team keeps an owner', async () => {
    const project = join(dir, 'project');
    const rana = personAt(project, 'Rana Example');
    const omar = personAt(project, 'Omar Sample');
    const exported = await omar.ipc.call('identity:exportCard', {});
    const card = exported.ok ? (exported.path ?? '') : '';
    await rana.ipc.call('members:add', { projectId: 'p', card, role: 'reviewer', certify: false });
    const ranaId = (await rana.store.get()).actor;
    const omarId = (await omar.store.get()).actor;

    expect(
      await omar.ipc.call('members:setRole', { projectId: 'p', actor: omarId, role: 'owner' }),
    ).toEqual({
      ok: false,
      code: 'forbidden',
      error:
        'Omar Sample is a reviewer in this project. Only an owner can change members, roles, devices and the team policy.',
    });
    expect(
      await rana.ipc.call('members:setRole', { projectId: 'p', actor: ranaId, role: 'viewer' }),
    ).toMatchObject({
      ok: false,
      code: 'forbidden',
      error: expect.stringMatching(/at least one owner/) as unknown,
    });
    expect(
      await rana.ipc.call('members:setRole', { projectId: 'p', actor: omarId, role: 'viewer' }),
    ).toEqual({ ok: true });
    expect(
      await rana.ipc.call('members:add', { projectId: 'p', card, role: 'reviewer', certify: true }),
    ).toMatchObject({
      ok: false,
      error: 'Omar Sample is already a member (viewer). Change the role in the members list.',
    });

    // revoke Omar's device, then remove Omar
    const device = omar.keys.get().signer.device;
    expect(
      await rana.ipc.call('members:revokeDevice', {
        projectId: 'p',
        device,
        reason: 'Laptop lost',
      }),
    ).toEqual({ ok: true });
    let list = await rana.ipc.call('members:list', { projectId: 'p' });
    expect(list.ok && list.members[1]?.devices[0]?.revoked).toBe(true);
    expect(await rana.ipc.call('members:remove', { projectId: 'p', actor: omarId })).toEqual({
      ok: true,
    });
    list = await rana.ipc.call('members:list', { projectId: 'p' });
    expect(list.ok && list.members.map((m) => m.name)).toEqual(['Rana Example']);
    // the journal holds no refused op: refusals are checked before writing
    expect((await createFileTeamJournal().ops(project)).length).toBe(5);
  });

  it('refuses changes in a package and an own card, and lists nothing there', async () => {
    const rana = personAt(dir, 'Rana Example', { packages: ['pkg'] });
    expect(await rana.ipc.call('members:list', { projectId: 'pkg' })).toEqual({
      ok: true,
      members: [],
    });
    expect(
      await rana.ipc.call('members:add', {
        projectId: 'pkg',
        card: '{}',
        role: 'viewer',
        certify: false,
      }),
    ).toMatchObject({ ok: false, code: 'read-only' });
    const own = await rana.ipc.call('identity:exportCard', {});
    expect(
      await rana.ipc.call('members:add', {
        projectId: 'p',
        card: own.ok ? (own.path ?? '') : '',
        role: 'viewer',
        certify: false,
      }),
    ).toMatchObject({
      ok: false,
      error: expect.stringMatching(/your own identity card/) as unknown,
    });
    expect(
      await rana.ipc.call('members:remove', { projectId: 'p', actor: `a_${'c'.repeat(26)}` }),
    ).toMatchObject({
      ok: false,
      error: 'This project is not shared, so it has no members to change.',
    });
  });

  it('refuses team changes when the vault cannot keep the device key', async () => {
    const store = createIdentityStore(join(dir, 'x.json'), { osUser: () => 'Rana Example' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const service = createIdentityService({
      store,
      keys: createDeviceKeys('svc', brokenVault),
      journal: createFileTeamJournal(),
      projectRoot: () => dir,
      isPackage: () => false,
      chooseCardPath: () => Promise.resolve(join(dir, 'card.aioid')),
      app: APP,
    });
    expect(await service.get()).toMatchObject({ ok: true, unsigned: true });
    expect(await service.exportCard()).toMatchObject({
      ok: false,
      error: expect.stringMatching(/credential store/) as unknown,
    });
    warn.mockRestore();
  });
});
