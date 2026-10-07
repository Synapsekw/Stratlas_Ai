import { cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { collectHandlers } from '../notYet';
import { registerSyncIpc } from './index';
import { interimDevice, interimEngine } from './interim';
import { createJournalStore } from './journalStore';
import { createSyncService } from './service';

let base: string;
beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'aio-sync-'));
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

interface Issue {
  id: string;
  code: string;
  title: string;
  severity: number;
  updatedAt?: string;
}
const issue = (id: string, code: string, severity = 1): Issue => ({
  id,
  code,
  title: `Finding ${code}`,
  severity,
});

async function writeProject(dir: string, issues: Issue[]) {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'manifest.json'), JSON.stringify({ name: 'Pipe rack review' }));
  await writeFile(join(dir, 'issues.json'), JSON.stringify({ schema: 'aio.issues/1', issues }));
}
const readIssues = async (dir: string) =>
  (JSON.parse(await readFile(join(dir, 'issues.json'), 'utf8')) as { issues: Issue[] }).issues;
const editIssue = async (dir: string, id: string, patch: Partial<Issue>) => {
  const issues = await readIssues(dir);
  await writeFile(
    join(dir, 'issues.json'),
    JSON.stringify({
      schema: 'aio.issues/1',
      issues: issues.map((i) => (i.id === id ? { ...i, ...patch } : i)),
    }),
  );
};

/** One "machine": its own userData, vault and identity, with a project open as `p`. */
async function machine(name: string, initials: string, root: string, opts: { pkg?: boolean } = {}) {
  const userData = join(base, `user-${initials}`);
  await mkdir(userData, { recursive: true });
  await writeFile(
    join(userData, 'identity.json'),
    JSON.stringify({
      schema: 'aio.identity/1',
      actor: `a_${initials.toLowerCase().padEnd(26, 'a')}`,
      name,
      initials,
      createdAt: '2026-10-07T08:00:00.000Z',
    }),
  );
  const secrets = new Map<string, string>();
  const app = { name: 'test-app', version: '0.9.0' };
  const device = interimDevice({
    userData,
    vault: () => ({
      getPassword: () => secrets.get('k') ?? null,
      setPassword: (v: string) => void secrets.set('k', v),
    }),
    app,
  });
  const store = createJournalStore();
  const engine = interimEngine({ store, device });
  const events: { event: string; payload: unknown }[] = [];
  let saveTo: string | null = null;
  const service = createSyncService({
    userData,
    projectRoot: (id) => (id === 'p' && !opts.pkg ? root : undefined),
    isPackage: () => opts.pkg ?? false,
    teamSettings: () => Promise.resolve(undefined),
    device,
    journal: engine.journal,
    merge: engine.merge,
    store,
    app,
    emit: (event: string, payload: unknown) => {
      events.push({ event, payload });
    },
    saveDialog: () => Promise.resolve(saveTo),
  });
  const ipc = collectHandlers((handle) => {
    registerSyncIpc({ handle, service });
  });
  return { ipc, root, userData, events, saveAs: (p: string | null) => (saveTo = p), device };
}

describe('sync IPC', () => {
  it('registers the team, sync and exchange channels', async () => {
    const a = await machine('Rana Example', 'RE', join(base, 'a'));
    expect(a.ipc.channels()).toEqual([
      'exchange:export',
      'exchange:import',
      'exchange:plan',
      'exchange:preview',
      'exchange:reply',
      'sync:conflicts',
      'sync:now',
      'sync:quarantine',
      'sync:release',
      'sync:resolve',
      'team:leave',
      'team:share',
      'team:status',
    ]);
    expect(await a.ipc.call('sync:conflicts', { projectId: 'p' })).toMatchObject({
      code: 'not-implemented',
    });
  });

  it('a project alone stays unshared: status off, nothing written to it', async () => {
    const dir = join(base, 'alone');
    await writeProject(dir, [issue('i1', 'F01')]);
    const a = await machine('Rana Example', 'RE', dir);
    expect(await a.ipc.call('team:status', { projectId: 'p' })).toMatchObject({
      ok: true,
      status: { mode: 'off', pending: 0, conflicts: 0 },
    });
    await expect(readFile(join(dir, 'team.json'))).rejects.toThrow();
    // no replica, no device key, nothing in userData for a private project
    await expect(readFile(join(a.userData, 'team', 'projects.json'))).rejects.toThrow();
    await expect(readFile(join(a.userData, 'journal-cache'))).rejects.toThrow();
  });

  it('refuses to share a read-only package', async () => {
    const a = await machine('Rana Example', 'RE', join(base, 'pkg'), { pkg: true });
    const r = await a.ipc.call('team:share', { projectId: 'p', mode: 'exchange' });
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/read-only/) as unknown });
  });

  it('makes a project a team project for exchange files (team.json, a project.share op)', async () => {
    const dir = join(base, 'a');
    await writeProject(dir, [issue('i1', 'F01')]);
    const a = await machine('Rana Example', 'RE', dir);
    const r = await a.ipc.call('team:share', { projectId: 'p', mode: 'exchange' });
    expect(r).toMatchObject({ ok: true, status: { mode: 'exchange', name: 'Pipe rack review' } });
    const team = JSON.parse(await readFile(join(dir, 'team.json'), 'utf8')) as {
      teamProjectId: string;
    };
    expect(team.teamProjectId).toMatch(/^t_[a-z2-7]{26}$/);
  });
});

describe('hub folder sync between two copies', () => {
  async function pair() {
    const hub = join(base, 'hub');
    await mkdir(hub);
    const aDir = join(base, 'a');
    await writeProject(aDir, [issue('i1', 'F01'), issue('i2', 'F02')]);
    const a = await machine('Rana Example', 'RE', aDir);
    expect(
      await a.ipc.call('team:share', { projectId: 'p', mode: 'hub', hubPath: hub }),
    ).toMatchObject({ ok: true });
    // Omar gets a copy of the project folder (USB or the NAS) and joins through the hub
    const bDir = join(base, 'b');
    await cp(aDir, bDir, { recursive: true });
    const b = await machine('Omar Sample', 'OS', bDir);
    expect(
      await b.ipc.call('team:share', { projectId: 'p', mode: 'hub', hubPath: hub }),
    ).toMatchObject({
      ok: true,
      status: { mode: 'hub' },
    });
    return { hub, a, b, aDir, bDir };
  }

  it('A edits, A syncs, B syncs and has the edit', async () => {
    const { a, b, bDir, aDir } = await pair();
    await editIssue(aDir, 'i1', { severity: 4 });
    expect(await a.ipc.call('sync:now', { projectId: 'p' })).toMatchObject({ ok: true, pushed: 1 });
    expect(await b.ipc.call('sync:now', { projectId: 'p' })).toMatchObject({
      ok: true,
      pulled: 1,
      conflicts: 0,
    });
    expect((await readIssues(bDir)).find((i) => i.id === 'i1')?.severity).toBe(4);
    expect(b.events.some((e) => e.event === 'journal:changed')).toBe(true);
    expect(await b.ipc.call('team:status', { projectId: 'p' })).toMatchObject({
      status: { mode: 'hub', pending: 0, reachable: true },
    });
  });

  it('an edit made while the hub is unreachable stays local and syncs when it is back', async () => {
    const { hub, a, b, aDir, bDir } = await pair();
    await rename(hub, `${hub}-away`);
    await editIssue(aDir, 'i2', { title: 'Corroded flange' });
    const offline = await a.ipc.call('sync:now', { projectId: 'p' });
    expect(offline).toMatchObject({
      ok: false,
      error: expect.stringMatching(/cannot be reached/) as unknown,
    });
    expect(await a.ipc.call('team:status', { projectId: 'p' })).toMatchObject({
      status: { reachable: false, pending: 1 },
    });
    expect((await readIssues(aDir)).find((i) => i.id === 'i2')?.title).toBe('Corroded flange');
    await rename(`${hub}-away`, hub);
    expect(await a.ipc.call('sync:now', { projectId: 'p' })).toMatchObject({ ok: true, pushed: 1 });
    await b.ipc.call('sync:now', { projectId: 'p' });
    expect((await readIssues(bDir)).find((i) => i.id === 'i2')?.title).toBe('Corroded flange');
  });

  it('concurrent edits of one field give a conflict in both copies; other fields merge', async () => {
    const { a, b, aDir, bDir } = await pair();
    // both edits also move updatedAt: bookkeeping, never a conflict of its own
    await editIssue(aDir, 'i1', { severity: 3, updatedAt: '2026-10-07T09:00:00.000Z' });
    await editIssue(bDir, 'i1', {
      severity: 4,
      title: 'Omar title',
      updatedAt: '2026-10-07T09:01:00.000Z',
    });
    await a.ipc.call('sync:now', { projectId: 'p' });
    expect(await b.ipc.call('sync:now', { projectId: 'p' })).toMatchObject({
      ok: true,
      conflicts: 1,
    });
    expect(await a.ipc.call('sync:now', { projectId: 'p' })).toMatchObject({
      ok: true,
      conflicts: 1,
    });
    const left = (await readIssues(aDir)).find((i) => i.id === 'i1');
    const right = (await readIssues(bDir)).find((i) => i.id === 'i1');
    expect(left).toEqual(right);
    expect(left?.title).toBe('Omar title');
    for (const m of [a, b]) {
      expect(await m.ipc.call('team:status', { projectId: 'p' })).toMatchObject({
        status: { conflicts: 1 },
      });
    }
  });

  it('leaving stops syncing this copy and keeps the data', async () => {
    const { b, bDir } = await pair();
    expect(await b.ipc.call('team:leave', { projectId: 'p' })).toEqual({ ok: true });
    expect(await b.ipc.call('sync:now', { projectId: 'p' })).toMatchObject({ ok: false });
    expect(await readIssues(bDir)).toHaveLength(2);
  });
});

describe('exchange files between two copies', () => {
  async function pair() {
    const aDir = join(base, 'a');
    await writeProject(aDir, [issue('i1', 'F01')]);
    const a = await machine('Rana Example', 'RE', aDir);
    await a.ipc.call('team:share', { projectId: 'p', mode: 'exchange' });
    const bDir = join(base, 'b');
    await cp(aDir, bDir, { recursive: true });
    const b = await machine('Omar Sample', 'OS', bDir);
    return { a, b, aDir, bDir };
  }

  it('A exports a patch, B previews and applies it; a second import says already applied', async () => {
    const { a, b, aDir, bDir } = await pair();
    await editIssue(aDir, 'i1', { severity: 5 });
    const file = join(base, 'for-omar.aiosync');
    a.saveAs(file);
    const plan = await a.ipc.call('exchange:plan', { projectId: 'p', kind: 'patch' });
    expect(plan).toMatchObject({ ok: true });
    const out = await a.ipc.call('exchange:export', { jobId: 'j1', projectId: 'p', kind: 'patch' });
    expect(out).toMatchObject({ ok: true, path: file });
    const preview = await b.ipc.call('exchange:preview', { projectId: 'p', path: file });
    expect(preview).toMatchObject({
      ok: true,
      preview: { signature: 'valid', sender: { name: 'Rana Example' }, alreadyApplied: false },
    });
    if (!preview.ok) throw new Error('no preview');
    expect(preview.preview.byKind['issue.patch']).toBe(1);
    const imported = await b.ipc.call('exchange:import', {
      jobId: 'j2',
      projectId: 'p',
      path: file,
    });
    expect(imported).toMatchObject({ ok: true, held: 0, conflicts: 0 });
    expect((await readIssues(bDir))[0]?.severity).toBe(5);
    expect(await b.ipc.call('exchange:preview', { projectId: 'p', path: file })).toMatchObject({
      ok: true,
      preview: { alreadyApplied: true, newOps: 0 },
    });
    expect(
      await b.ipc.call('exchange:import', { jobId: 'j3', projectId: 'p', path: file }),
    ).toMatchObject({
      ok: true,
      applied: 0,
    });
  });

  it('a patch for a peer carries only what that peer has not been sent', async () => {
    const { a, b, aDir } = await pair();
    const peer = (await b.device.signer())?.device ?? '';
    await editIssue(aDir, 'i1', { severity: 2 });
    a.saveAs(join(base, 'one.aiosync'));
    await a.ipc.call('exchange:export', { jobId: 'j', projectId: 'p', kind: 'patch', peer });
    await editIssue(aDir, 'i1', { severity: 3 });
    expect(
      await a.ipc.call('exchange:plan', { projectId: 'p', kind: 'patch', peer }),
    ).toMatchObject({ ops: 1 });
  });

  it('an encrypted file asks for its passphrase and opens with it', async () => {
    const { a, b, aDir } = await pair();
    await editIssue(aDir, 'i1', { severity: 2 });
    const file = join(base, 'locked.aiosync');
    a.saveAs(file);
    await a.ipc.call('exchange:export', {
      jobId: 'j',
      projectId: 'p',
      kind: 'patch',
      passphrase: 'long enough phrase',
    });
    expect(await b.ipc.call('exchange:preview', { projectId: 'p', path: file })).toMatchObject({
      ok: false,
      needsPassphrase: true,
    });
    expect(
      await b.ipc.call('exchange:preview', {
        projectId: 'p',
        path: file,
        passphrase: 'long enough phrase',
      }),
    ).toMatchObject({ ok: true, preview: { header: { encrypted: true } } });
  }, 20_000);

  it('refuses a file for another team project', async () => {
    const { a, aDir } = await pair();
    const otherDir = join(base, 'other');
    await writeProject(otherDir, [issue('x', 'F09')]);
    const other = await machine('Lina Test', 'LT', otherDir);
    await other.ipc.call('team:share', { projectId: 'p', mode: 'exchange' });
    await editIssue(otherDir, 'x', { severity: 2 });
    const file = join(base, 'other.aiosync');
    other.saveAs(file);
    await other.ipc.call('exchange:export', { jobId: 'j', projectId: 'p', kind: 'patch' });
    expect(aDir).toBeTruthy();
    expect(await a.ipc.call('exchange:preview', { projectId: 'p', path: file })).toMatchObject({
      ok: false,
      error: expect.stringMatching(/another team project/) as unknown,
    });
  });

  it('a copy without team.json joins the team project by importing a file', async () => {
    const aDir = join(base, 'a');
    await writeProject(aDir, [issue('i1', 'F01')]);
    const bDir = join(base, 'b');
    await cp(aDir, bDir, { recursive: true });
    const a = await machine('Rana Example', 'RE', aDir);
    await a.ipc.call('team:share', { projectId: 'p', mode: 'exchange' });
    await editIssue(aDir, 'i1', { severity: 4 });
    const file = join(base, 'join.aiosync');
    a.saveAs(file);
    await a.ipc.call('exchange:export', { jobId: 'j', projectId: 'p', kind: 'bundle' });
    const b = await machine('Omar Sample', 'OS', bDir);
    const preview = await b.ipc.call('exchange:preview', { projectId: 'p', path: file });
    expect(preview.ok && preview.preview.problems.join(' ')).toMatch(
      /part of the team project "Pipe rack review"/,
    );
    await b.ipc.call('exchange:import', { jobId: 'j', projectId: 'p', path: file });
    expect(await b.ipc.call('team:status', { projectId: 'p' })).toMatchObject({
      status: { mode: 'exchange', name: 'Pipe rack review' },
    });
  });
});
