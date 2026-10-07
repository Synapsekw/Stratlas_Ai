import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { signerFromKey, verifyJournal } from '@aio/journal';
import type { Issue, IpcChannel, JobRecord } from '@aio/schema';
import { afterEach, describe, expect, it } from 'vitest';
import { auditCsv, createAuditExport } from './exports/audit';
import { writeJsonAtomic } from './fsutil';
import type { Handler } from './ipc';
import {
  createJournalService,
  readJournalFiles,
  registerJournalIpc,
  type JournalIdentity,
} from './journal';
import { collectHandlers } from './notYet';

const signer = signerFromKey(generateKeyPairSync('ed25519').privateKey);
const identity: JournalIdentity = {
  actor: `a_${'r'.repeat(26)}`,
  name: 'Rana Example',
  initials: 'RE',
  device: { id: signer.device, publicKey: signer.publicKey },
  signer,
  app: { name: 'test-app', version: '0.9.0' },
};

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tmp(name: string) {
  const d = mkdtempSync(join(tmpdir(), `aio-journal-${name}-`));
  dirs.push(d);
  return d;
}

const f01: Issue = {
  id: 'i_f01',
  code: 'F01',
  classId: 'corrosion',
  severityModelId: 'sev-5',
  severity: 3,
  status: 'draft',
  title: 'Corrosion on flange',
  note: '',
  author: 'Rana Example',
  createdAt: '2026-10-01T06:00:00.000Z',
  updatedAt: '2026-10-01T06:00:00.000Z',
  sightings: [{ on: 'mesh', layer: 'site-mesh', geom: { type: 'spoint', p: [1, 2, 3] } }],
  source: 'human',
} as Issue;

function setup(opts: { afterAppend?: (rel: string) => void; userData?: string } = {}) {
  const root = tmp('project');
  const userData = opts.userData ?? tmp('userdata');
  writeFileSync(
    join(root, 'issues.json'),
    JSON.stringify({ schema: 'aio.issues/1', issues: [f01] }),
  );
  writeFileSync(
    join(root, 'manifest.json'),
    JSON.stringify({ schema: 'aio.project/1', layers: [] }),
  );
  return { root, userData };
}

function service(
  root: string,
  userData: string,
  extra: { afterAppend?: (rel: string) => void } = {},
) {
  const changed: unknown[] = [];
  const pkg = new Set<string>();
  const journal = createJournalService({
    userData,
    projects: { root: (id) => (id === 'p' ? root : undefined), package: (id) => pkg.has(id) },
    identity: () => Promise.resolve(identity),
    emitChanged: (e) => changed.push(e),
    now: () => Date.UTC(2026, 9, 7, 9, 0, 0),
    ...(extra.afterAppend ? { afterAppend: extra.afterAppend } : {}),
  });
  const writeIssues = journal.wrap('project:writeIssues', async ({ issues }) => {
    await writeJsonAtomic(
      join(root, 'issues.json'),
      { schema: 'aio.issues/1', issues },
      { backup: true },
    );
    return { ok: true };
  });
  const open = journal.wrap('project:open', () =>
    Promise.resolve({
      ok: true as const,
      id: 'p',
      root,
      manifest: {} as never,
      issues: [],
    }),
  );
  return { journal, changed, writeIssues, open, pkg };
}

const issuesOnDisk = (root: string) =>
  (JSON.parse(readFileSync(join(root, 'issues.json'), 'utf8')) as { issues: Issue[] }).issues;

describe('journal IPC', () => {
  it('registers the history, verify, redact and audit export channels', () => {
    const { root, userData } = setup();
    const { journal } = service(root, userData);
    const ipc = collectHandlers((handle) => {
      registerJournalIpc({
        handle,
        journal,
        exportAudit: () => Promise.resolve({ ok: true, path: null, count: 0 }),
      });
    });
    expect(ipc.channels()).toEqual([
      'audit:export',
      'journal:history',
      'journal:redact',
      'journal:verify',
    ]);
  });
});

describe('journal service', () => {
  it('records three labelled edits of F01 with before and after, signed and intact', async () => {
    const { root, userData } = setup();
    const { journal, writeIssues, open } = service(root, userData);
    await open({ path: root });
    const steps: [Partial<Issue>, string][] = [
      [{ severity: 4 }, 'F01 severity 3 to 4'],
      [{ note: 'Pitting near the weld' }, 'Edit F01'],
      [{ status: 'reviewed' }, 'F01 to reviewed'],
    ];
    let cur = f01;
    for (const [patch, label] of steps) {
      cur = { ...cur, ...patch };
      expect(
        await writeIssues({ projectId: 'p', issues: [cur], commands: [{ label, ids: ['i_f01'] }] }),
      ).toEqual({ ok: true });
    }
    expect(issuesOnDisk(root)[0]?.status).toBe('reviewed');
    const h = await journal.history({
      projectId: 'p',
      filter: { target: { rec: 'issue', id: 'i_f01' } },
    });
    if (!h.ok) throw new Error(h.error);
    expect(h.entries.map((e) => e.label)).toEqual([
      'F01 to reviewed',
      'Edit F01',
      'F01 severity 3 to 4',
    ]);
    expect(h.entries[2]).toMatchObject({
      how: 'hand',
      state: 'ok',
      actor: { id: identity.actor, name: 'Rana Example', initials: 'RE' },
      changes: [{ field: 'severity', before: 3, after: 4 }],
    });
    expect(h.entries[0]?.changes).toEqual([
      { field: 'status', before: 'draft', after: 'reviewed' },
    ]);
    const v = await journal.verify('p');
    if (!v.ok) throw new Error(v.error);
    expect(v.report.problems).toEqual([]);
    expect(v.report.counts.signed).toBe(3);
  });

  it('marks the ops the merge engine holds in quarantine, in a shared folder only', async () => {
    const { root, userData } = setup();
    const { journal, writeIssues, open } = service(root, userData);
    await open({ path: root });
    await writeIssues({ projectId: 'p', issues: [{ ...f01, severity: 4 }] });
    const held = new Set<string>();
    const asked: string[] = [];
    journal.setQuarantined((r) => {
      asked.push(r);
      return Promise.resolve(held);
    });
    const first = await journal.history({ projectId: 'p' });
    if (!first.ok) throw new Error(first.error);
    const op = first.entries[0]?.op ?? '';
    expect(first.entries[0]?.state).toBe('ok');
    // a private folder never asks the engine
    expect(asked).toEqual([]);

    writeFileSync(join(root, 'team.json'), JSON.stringify({ schema: 'aio.team/1' }));
    held.add(op);
    await writeIssues({ projectId: 'p', issues: [{ ...f01, severity: 5 }] });
    const shared = await journal.history({ projectId: 'p' });
    if (!shared.ok) throw new Error(shared.error);
    expect(shared.entries.find((e) => e.op === op)?.state).toBe('quarantined');
    expect(shared.entries[0]?.state).toBe('ok');
    expect(asked).toEqual([root]);
  });

  it('keeps the history after a restart, and an agent edit says so', async () => {
    const { root, userData } = setup();
    const first = service(root, userData);
    await first.open({ path: root });
    await first.writeIssues({
      projectId: 'p',
      issues: [{ ...f01, title: 'Corrosion on the flange' }],
      commands: [
        { label: 'Edit F01', ids: ['i_f01'], via: { agent: { conversation: 'c1', callId: 't1' } } },
      ],
    });
    const second = service(root, userData);
    await second.open({ path: root });
    await second.writeIssues({ projectId: 'p', issues: [{ ...f01, title: 'Flange' }] });
    const h = await second.journal.history({ projectId: 'p' });
    if (!h.ok) throw new Error(h.error);
    expect(h.entries.map((e) => e.how)).toEqual(['hand', 'agent']);
    expect(h.entries[1]?.changes).toEqual([
      { field: 'title', before: 'Corrosion on flange', after: 'Corrosion on the flange' },
    ]);
    // one chain: the replica id is kept per folder in userData
    expect(readdirSync(join(root, 'journal', 'ops'))).toHaveLength(1);
  });

  it('finishes a write that crashed between the op and the state write', async () => {
    const { root, userData } = setup();
    const crashing = service(root, userData, {
      afterAppend: () => {
        throw new Error('power cut');
      },
    });
    await crashing.open({ path: root });
    await expect(
      crashing.writeIssues({ projectId: 'p', issues: [{ ...f01, severity: 5 }] }),
    ).rejects.toThrow('power cut');
    expect(issuesOnDisk(root)[0]?.severity).toBe(3);

    const restarted = service(root, userData);
    await restarted.open({ path: root });
    expect(issuesOnDisk(root)[0]?.severity).toBe(5);
    const h = await restarted.journal.history({ projectId: 'p' });
    if (!h.ok) throw new Error(h.error);
    expect(h.entries).toHaveLength(1);
    expect(h.entries[0]).toMatchObject({ kind: 'issue.patch', how: 'hand' });
  });

  it('records an edit made outside the app on the next open', async () => {
    const { root, userData } = setup();
    const s = service(root, userData);
    await s.open({ path: root });
    writeFileSync(
      join(root, 'issues.json'),
      JSON.stringify({ schema: 'aio.issues/1', issues: [{ ...f01, severity: 1 }] }),
    );
    await s.open({ path: root });
    const h = await s.journal.history({ projectId: 'p' });
    if (!h.ok) throw new Error(h.error);
    expect(h.entries).toEqual([
      expect.objectContaining({
        how: 'external',
        via: { external: { found: 'open' } },
        changes: [{ field: 'severity', before: 3, after: 1 }],
      }),
    ]);
    expect(s.changed).toEqual([{ projectId: 'p', records: [{ rec: 'issue', id: 'i_f01' }] }]);
  });

  it('undoes the ops of a write the handler refused', async () => {
    const { root, userData } = setup();
    const s = service(root, userData);
    await s.open({ path: root });
    const refusing = s.journal.wrap('project:writeIssues', () =>
      Promise.resolve({ ok: false, error: 'Severity model missing' }),
    );
    expect(await refusing({ projectId: 'p', issues: [{ ...f01, severity: 9 }] })).toEqual({
      ok: false,
      error: 'Severity model missing',
    });
    const h = await s.journal.history({ projectId: 'p' });
    if (!h.ok) throw new Error(h.error);
    expect(h.entries.map((e) => [e.label, e.changes?.[0]?.after])).toEqual([
      ['Not saved, change undone', 3],
      [undefined, 9],
    ]);
  });

  it('attributes what a pipeline job changed to the pipeline', async () => {
    const { root, userData } = setup();
    const s = service(root, userData);
    await s.open({ path: root });
    const job = {
      id: 'job-1',
      pipeline: 'inspection.run',
      project: root,
      params: {},
      status: 'running',
      progress: 0,
      steps: [],
      artifacts: [],
      createdAt: '2026-10-07T09:00:00.000Z',
      updatedAt: '2026-10-07T09:00:00.000Z',
      packVersion: '0.9.0',
    } as JobRecord;
    const start = s.journal.wrap('jobs:start', () => Promise.resolve({ ok: true as const, job }));
    await start({ pipeline: 'inspection.run', project: root, params: {} });
    mkdirSync(join(root, 'detections'), { recursive: true });
    writeFileSync(
      join(root, 'issues.json'),
      JSON.stringify({
        schema: 'aio.issues/1',
        issues: [{ ...f01, note: 'Found by the pipeline' }],
      }),
    );
    await s.journal.jobEvent({ type: 'update', job: { ...job, status: 'done' } });
    const h = await s.journal.history({ projectId: 'p' });
    if (!h.ok) throw new Error(h.error);
    expect(h.entries[0]).toMatchObject({
      how: 'pipeline',
      via: { pipeline: { name: 'inspection.run', jobId: 'job-1', packVersion: '0.9.0' } },
    });
  });

  it('switches off for a private project with the switch recorded, never for a team project', async () => {
    const { root, userData } = setup();
    const s = service(root, userData);
    await s.open({ path: root });
    expect(await s.journal.setJournal('p', false, 'Scratch copy')).toEqual({ ok: true });
    await s.writeIssues({ projectId: 'p', issues: [{ ...f01, severity: 2 }] });
    let h = await s.journal.history({ projectId: 'p' });
    if (!h.ok) throw new Error(h.error);
    expect(h.off).toBe(true);
    expect(h.entries.map((e) => e.kind)).toEqual(['journal.off']);
    await s.journal.setJournal('p', true);
    h = await s.journal.history({ projectId: 'p' });
    if (!h.ok) throw new Error(h.error);
    expect(h.entries.map((e) => e.kind)).toEqual(['journal.on', 'journal.off']);
    writeFileSync(join(root, 'team.json'), JSON.stringify({ schema: 'aio.team/1' }));
    expect((await s.journal.setJournal('p', false)).ok).toBe(false);
  });

  it('redacts a payload and the history still verifies', async () => {
    const { root, userData } = setup();
    const s = service(root, userData);
    await s.open({ path: root });
    await s.writeIssues({ projectId: 'p', issues: [{ ...f01, note: 'Call Rana on 555 0100' }] });
    const h = await s.journal.history({ projectId: 'p' });
    if (!h.ok) throw new Error(h.error);
    const op = h.entries[0]?.op ?? '';
    expect(await s.journal.redact({ projectId: 'p', op, reason: 'Personal data' })).toEqual({
      ok: true,
    });
    const files = await readJournalFiles(root);
    expect([...files.values()].join('')).not.toContain('555 0100');
    const r = verifyJournal(files, { now: new Date(Date.UTC(2026, 9, 7, 9, 0, 0)) });
    expect(r.problems).toEqual([]);
    expect(r.counts.redacted).toBe(1);
    const after = await s.journal.history({ projectId: 'p' });
    if (!after.ok) throw new Error(after.error);
    expect(after.entries.find((e) => e.op === op)?.redacted?.by).toBe(identity.actor);
  });

  it('never journals a package', async () => {
    const { root, userData } = setup();
    const s = service(root, userData);
    s.pkg.add('p');
    const calls: string[] = [];
    const w = s.journal.wrap('project:writeIssues', () => {
      calls.push('handler');
      return { ok: false, error: 'read-only' };
    });
    await w({ projectId: 'p', issues: [f01] });
    expect(calls).toEqual(['handler']);
    expect(readdirSync(root)).not.toContain('journal');
  });

  it('leaves channels that are not writers untouched', () => {
    const { root, userData } = setup();
    const s = service(root, userData);
    const h: Handler<IpcChannel> = () => ({}) as never;
    expect(s.journal.wrap('app:getInfo', h as Handler<'app:getInfo'>)).toBe(h);
  });
});

describe('audit exports', () => {
  it('writes CSV with a BOM, Arabic names intact and formulas neutralised', () => {
    const csv = auditCsv([
      {
        op: 'a'.repeat(64),
        chain: `d_${'a'.repeat(52)}.r_${'b'.repeat(16)}`,
        seq: 1,
        hlc: `1790000000000.0000.d_${'a'.repeat(52)}`,
        at: '2026-09-21T13:46:40.000Z',
        actor: { id: `a_${'c'.repeat(26)}`, name: 'رنا مثال', initials: 'رم' },
        device: `d_${'a'.repeat(52)}`,
        kind: 'issue.patch',
        target: { rec: 'issue', id: 'i_f01' },
        label: '=HYPERLINK("x")',
        how: 'hand',
        changes: [{ field: 'note', before: 'قديم', after: 'جديد, "new"' }],
        state: 'ok',
      },
    ]);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv).toContain('رنا مثال');
    expect(csv).toContain(`"'=HYPERLINK(""x"")"`);
    expect(csv).toContain('"note: قديم to جديد, ""new"""');
    expect(csv.split('\r\n')).toHaveLength(3);
  });

  it('exports CSV and JSON through the save dialog, JSON with the whole journal', async () => {
    const { root, userData } = setup();
    const s = service(root, userData);
    await s.open({ path: root });
    await s.writeIssues({ projectId: 'p', issues: [{ ...f01, severity: 4 }] });
    const out = tmp('out');
    const exportAudit = createAuditExport({
      journal: s.journal,
      projectName: () => 'Demo site',
      app: { name: 'test-app', version: '0.9.0' },
      choose: (name) => Promise.resolve(join(out, name)),
      now: () => new Date('2026-10-07T09:00:00.000Z'),
    });
    const csv = await exportAudit({ projectId: 'p', format: 'audit-csv' });
    expect(csv).toMatchObject({ ok: true, count: 2 });
    const json = await exportAudit({ projectId: 'p', format: 'audit-json' });
    if (!json.ok || !json.path) throw new Error('no export');
    expect(json.path.endsWith('demo-site-audit-2026-10-07.json')).toBe(true);
    const doc = JSON.parse(readFileSync(json.path, 'utf8')) as {
      schema: string;
      journal: Record<string, string>;
      verify: { ok: boolean };
      head: { root: string };
    };
    expect(doc.schema).toBe('aio.audit/1');
    expect(doc.verify.ok).toBe(true);
    const report = verifyJournal(new Map(Object.entries(doc.journal)), {
      now: new Date('2026-10-07T09:00:00.000Z'),
    });
    expect(report.head?.root).toBe(doc.head.root);
    expect(Object.keys(doc.journal).some((p) => p.startsWith('journal/checkpoints/'))).toBe(true);
    const cancelled = createAuditExport({
      journal: s.journal,
      projectName: () => 'Demo site',
      app: { name: 'test-app', version: '0.9.0' },
      choose: () => Promise.resolve(null),
    });
    expect(await cancelled({ projectId: 'p', format: 'audit-csv' })).toMatchObject({
      ok: true,
      path: null,
    });
  });
});
