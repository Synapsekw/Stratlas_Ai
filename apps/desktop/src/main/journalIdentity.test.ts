import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createLocalIdentity, initialsOf } from './journalIdentity';
import type { KeyEntry } from './keys';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'aio-identity-'));
  dirs.push(d);
  return d;
};

function memoryVault(start: Record<string, string> = {}) {
  const store = new Map(Object.entries(start));
  const entry = (account: string): KeyEntry => ({
    getPassword: () => store.get(account) ?? null,
    setPassword: (v) => {
      store.set(account, v);
    },
  });
  return { store, entry };
}

const app = { name: 'test-app', version: '0.9.0' };

describe('journal identity (until T2)', () => {
  it('derives initials from the first and last words, any script', () => {
    expect(initialsOf('Rana Example')).toBe('RE');
    expect(initialsOf('omar')).toBe('O');
    expect(initialsOf('Lina de la Test')).toBe('LT');
    expect(initialsOf('رنا مثال')).toBe('رم');
  });

  it('keeps one device key in the vault and one actor across starts', async () => {
    const userData = tmp();
    const vault = memoryVault();
    const make = () =>
      createLocalIdentity({ userData, osUser: () => 'Rana Example', entry: vault.entry, app });
    const a = await make()();
    const b = await make()();
    expect(a.signer?.device).toBe(b.signer?.device);
    expect(a.actor).toBe(b.actor);
    expect(a).toMatchObject({ name: 'Rana Example', initials: 'RE' });
    expect(vault.store.get('device-signing')).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('uses the identity T2 wrote when it exists', async () => {
    const userData = tmp();
    writeFileSync(
      join(userData, 'identity.json'),
      JSON.stringify({
        schema: 'aio.identity/1',
        actor: `a_${'k'.repeat(26)}`,
        name: 'Omar Sample',
        initials: 'OS',
        createdAt: '2026-10-01T00:00:00.000Z',
      }),
    );
    const id = await createLocalIdentity({
      userData,
      osUser: () => 'someone',
      entry: memoryVault().entry,
      app,
    })();
    expect(id).toMatchObject({ actor: `a_${'k'.repeat(26)}`, name: 'Omar Sample' });
  });

  it('writes unsigned, never overwriting a vault value it cannot read', async () => {
    const vault = memoryVault({ 'device-signing': 'not a key' });
    const id = await createLocalIdentity({
      userData: tmp(),
      osUser: () => undefined,
      entry: vault.entry,
      app,
    })();
    expect(id.signer).toBeNull();
    expect(id.device.id).toMatch(/^d_[a-z2-7]{52}$/);
    expect(id.name).toBe('Unknown author');
    expect(vault.store.get('device-signing')).toBe('not a key');
  });

  it('writes unsigned when the vault is not there', async () => {
    const id = await createLocalIdentity({
      userData: tmp(),
      osUser: () => 'Lina Test',
      entry: () => {
        throw new Error('no vault');
      },
      app,
    })();
    expect(id.signer).toBeNull();
  });
});
