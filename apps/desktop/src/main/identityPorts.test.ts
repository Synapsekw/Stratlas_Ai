import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createDeviceKeys,
  createIdentityService,
  createIdentityStore,
  profileVaultService,
  type IdentityService,
} from './identity';
import {
  collabIdentity,
  deviceSource,
  devicePort,
  journalIdentity,
  teamJournal,
} from './identityPorts';
import { createJournalService, type JournalService } from './journal';
import type { KeyEntry } from './keys';
import { createTestVault, TEST_VAULT_FILE, useTestVault } from './testVault';

const APP = { name: 'Stratlas', version: '0.9.0' };

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'aio-ports-'));
});
/** Journal services a test made: their kept segments are closed after it. */
const journals: JournalService[] = [];
afterEach(async () => {
  await Promise.all(journals.splice(0).map((j) => j.closeAll()));
  await rm(dir, { recursive: true, force: true });
});

/** Every vault account any code asked for, with its service. */
function recordingVault() {
  const values = new Map<string, string>();
  const asked = new Set<string>();
  const entry = (service: string, account: string): KeyEntry => {
    asked.add(`${service}/${account}`);
    return {
      getPassword: () => values.get(`${service}/${account}`) ?? null,
      setPassword: (v) => {
        values.set(`${service}/${account}`, v);
      },
    };
  };
  return { values, asked, entry };
}

/** One profile's whole M9 stack: identity, journal, sync, server and review workflow. */
function profileStack(profile: string | null, vault: ReturnType<typeof recordingVault>) {
  const service = profileVaultService('com.example.stratlas.isolated', profile);
  const userData = join(dir, profile ?? 'default');
  const project = join(dir, 'project');
  mkdirSync(userData, { recursive: true });
  // eslint-disable-next-line prefer-const -- the journal signs with the identity made below
  let identity: IdentityService;
  const journal = createJournalService({
    userData,
    projects: { root: () => project, package: () => undefined },
    identity: () => journalIdentity(identity, APP)(),
  });
  journals.push(journal);
  identity = createIdentityService({
    store: createIdentityStore(join(userData, 'identity.json'), {
      osUser: () => profile ?? 'Rana Example',
    }),
    keys: createDeviceKeys(service, vault.entry),
    journal: teamJournal(() => journal),
    projectRoot: () => project,
    isPackage: () => false,
    chooseCardPath: () => Promise.resolve(null),
    app: APP,
  });
  return { service, identity, journal, project, userData };
}

describe('one device key per profile (M9 integration)', () => {
  it('journal, sync, team server and review workflow all use the one vault account', async () => {
    const vault = recordingVault();
    const s = profileStack(null, vault);
    await mkdir(s.project, { recursive: true });
    await writeFile(join(s.project, 'manifest.json'), '{}');

    const fromJournal = await journalIdentity(s.identity, APP)();
    const sync = devicePort(s.identity, APP);
    const server = await deviceSource(s.identity, APP)();
    const signer = await sync.signer();
    const record = await sync.record();
    const me = await collabIdentity(s.identity).me();
    // the journal writes an op: same device, same actor
    const [op] = await s.journal.append(s.project, [
      { kind: 'project.share', target: { rec: 'project', id: 't' }, payload: { name: 'Site' } },
    ]);

    const device = fromJournal.device.id;
    expect(signer?.device).toBe(device);
    expect(record?.id).toBe(device);
    expect(server?.signer.device).toBe(device);
    expect(server?.record.id).toBe(device);
    expect(op?.dev).toBe(device);
    expect(op?.act).toBe(me?.actor);
    expect(record?.actor).toBe(me?.actor);
    // exactly one vault account was ever asked for or written: device-signing of this service
    expect([...vault.asked]).toEqual([`${s.service}/device-signing`]);
    expect([...vault.values.keys()]).toEqual([`${s.service}/device-signing`]);
  });

  it('a second profile has its own service and so its own single key', async () => {
    const vault = recordingVault();
    const a = profileStack(null, vault);
    const b = profileStack('reviewer-b', vault);
    const da = (await devicePort(a.identity, APP).signer())?.device;
    const db = (await devicePort(b.identity, APP).signer())?.device;
    expect(da).toMatch(/^d_/);
    expect(db).toMatch(/^d_/);
    expect(da).not.toBe(db);
    expect([...vault.values.keys()].sort()).toEqual(
      [`${a.service}/device-signing`, `${b.service}/device-signing`].sort(),
    );
    expect(b.service).toBe('com.example.stratlas.isolated.profile.reviewer-b');
  });

  it('the TEST-ONLY vault of automated runs stays in the throwaway userData', () => {
    expect(useTestVault({ STRATLAS_TEST_VAULT: '1', STRATLAS_USER_DATA: dir })).toBe(true);
    expect(useTestVault({ STRATLAS_TEST_VAULT: '1' })).toBe(false);
    expect(useTestVault({ STRATLAS_USER_DATA: dir })).toBe(false);
    const entry = createTestVault(dir);
    const keys = createDeviceKeys('svc', entry);
    const first = keys.get();
    expect(first.stored).toBe(true);
    // a restart of the same profile reads the same key back
    expect(createDeviceKeys('svc', createTestVault(dir)).get().signer.device).toBe(
      first.signer.device,
    );
    expect(entry('svc', 'device-signing').getPassword()).toBeTruthy();
    expect(TEST_VAULT_FILE).toMatch(/^TEST-ONLY/);
  });
});
