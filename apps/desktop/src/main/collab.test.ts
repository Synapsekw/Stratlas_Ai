import { checkOp, readSegment } from '@aio/journal';
import { JOURNAL_OPS_DIR, Op, type CollabTarget } from '@aio/schema';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCollabService, registerCollabIpc, type CollabJournal, type Me } from './collab';
import { createFakeJournal, createFakeMembers } from './collab.fakes';
import { collectHandlers } from './notYet';

const RANA: Me = { actor: `a_${'r'.repeat(26)}`, name: 'Rana Example', initials: 'RE' };
const OMAR: Me = { actor: `a_${'o'.repeat(26)}`, name: 'Omar Sample', initials: 'OS' };
const LINA: Me = { actor: `a_${'l'.repeat(26)}`, name: 'Lina Test', initials: 'LT' };
const VERA: Me = { actor: `a_${'v'.repeat(26)}`, name: 'Vera Viewer', initials: 'VV' };
const CLEO: Me = { actor: `a_${'c'.repeat(26)}`, name: 'Cleo Client', initials: 'CC' };
const KEY = 'A'.repeat(43);
const F03: CollabTarget = { kind: 'issue', id: 'i_f03' };
const F05: CollabTarget = { kind: 'issue', id: 'i_f05' };

const issue = (id: string, code: string, author: string, extra: object = {}) => ({
  id,
  code,
  classId: 'corrosion',
  severityModelId: 'sev4',
  severity: 2,
  status: 'reviewed',
  title: `Finding ${code}`,
  note: '',
  author,
  createdAt: '2026-10-07T08:00:00.000Z',
  updatedAt: '2026-10-07T08:00:00.000Z',
  sightings: [{ on: 'mesh', layer: 'm', geom: { type: 'spoint', p: [0, 0, 0] } }],
  source: 'human',
  ...extra,
});

let base: string;
let root: string;
let userData: string;
let me: Me;
let journal: CollabJournal;
let packaged: boolean;
const service = () =>
  createCollabService({
    projects: {
      root: (id) => (id === 'p1' ? root : undefined),
      package: () => (packaged ? {} : undefined),
    },
    journal,
    identity: { me: () => Promise.resolve(me) },
    members: createFakeMembers(),
  });

async function writeIssues(list: object[]) {
  await writeFile(
    join(root, 'issues.json'),
    JSON.stringify({ schema: 'aio.issues/1', issues: list }),
  );
}

/** Share the project with Rana as owner, Omar and Lina as reviewers, Vera viewer, Cleo client. */
async function share() {
  const add = (m: Me, role: string) =>
    journal.append(root, RANA, {
      kind: 'member.add',
      target: { rec: 'member', id: m.actor },
      payload: {
        actor: m.actor,
        name: m.name,
        initials: m.initials,
        role,
        devices: [{ id: `d_${'a'.repeat(52)}`, key: KEY }],
      },
    });
  await journal.append(root, RANA, {
    kind: 'project.share',
    target: { rec: 'project', id: 'p1' },
    payload: { teamProjectId: 'tp1', name: 'Synthetic site' },
  });
  await add(RANA, 'owner');
  await add(OMAR, 'reviewer');
  await add(LINA, 'reviewer');
  await add(VERA, 'viewer');
  await add(CLEO, 'client');
}

async function segmentLines() {
  const dir = join(root, JOURNAL_OPS_DIR);
  const out: Record<string, unknown>[] = [];
  for (const chain of await readdir(dir))
    for (const f of await readdir(join(dir, chain)))
      for (const l of readSegment(await readFile(join(dir, chain, f), 'utf8')))
        if (l.ok) out.push(l.raw);
  return out;
}

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'aio-collab-'));
  root = join(base, 'project');
  userData = join(base, 'user');
  await mkdir(root, { recursive: true });
  await mkdir(userData, { recursive: true });
  journal = createFakeJournal({ userData });
  me = RANA;
  packaged = false;
  await writeIssues([issue('i_f03', 'F03', 'Omar Sample'), issue('i_f05', 'F05', 'Rana Example')]);
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

describe('collab service: one person, project not shared', () => {
  it('comments and assigns to themself; approvals need a shared project', async () => {
    const s = service();
    const c = await s.comment({ projectId: 'p1', target: F03, text: 'Check the weld' });
    expect(c.ok).toBe(true);
    expect((await s.assign({ projectId: 'p1', target: F03, assignee: RANA.actor })).ok).toBe(true);
    expect((await s.assign({ projectId: 'p1', target: F03, assignee: OMAR.actor })).ok).toBe(false);
    const r = await s.read({ projectId: 'p1' });
    if (!r.ok) throw new Error(r.error);
    expect(r.state.policy).toBeNull();
    expect(r.state.comments.map((x) => x.text)).toEqual(['Check the weld']);
    const a = await s.approve({ projectId: 'p1', target: F05, decision: 'approve' });
    expect(a).toMatchObject({ ok: false, code: 'forbidden' });
  });

  it('refuses writes in a read-only package and reads it as empty', async () => {
    packaged = true;
    const s = service();
    expect(await s.comment({ projectId: 'p1', target: F03, text: 'x' })).toMatchObject({
      ok: false,
      code: 'read-only',
    });
    expect(await s.read({ projectId: 'p1' })).toMatchObject({ ok: true, state: { comments: [] } });
  });
});

describe('collab service: a shared project', () => {
  beforeEach(share);

  it('four-eyes: the creator cannot approve; another reviewer completes it', async () => {
    const s = service();
    me = RANA;
    const own = await s.approve({ projectId: 'p1', target: F05, decision: 'approve' });
    expect(own).toMatchObject({ ok: false, code: 'forbidden' });
    if (!own.ok) expect(own.error).toMatch(/Another reviewer/);
    me = OMAR;
    expect(await s.approve({ projectId: 'p1', target: F05, decision: 'approve' })).toEqual({
      ok: true,
      approved: true,
    });
    expect(await s.approve({ projectId: 'p1', target: F05, decision: 'approve' })).toMatchObject({
      ok: false,
      error: 'You have already approved this.',
    });
  });

  it('two approvals required: approved on the second; viewers and clients cannot approve', async () => {
    const s = service();
    me = OMAR;
    expect((await s.policy({ projectId: 'p1', policy: { approval: { required: 2 } } })).ok).toBe(
      false,
    );
    me = RANA;
    expect((await s.policy({ projectId: 'p1', policy: { approval: { required: 2 } } })).ok).toBe(
      true,
    );
    me = VERA;
    expect((await s.approve({ projectId: 'p1', target: F05, decision: 'approve' })).ok).toBe(false);
    me = CLEO;
    expect((await s.approve({ projectId: 'p1', target: F05, decision: 'approve' })).ok).toBe(false);
    me = OMAR;
    expect(await s.approve({ projectId: 'p1', target: F05, decision: 'approve' })).toEqual({
      ok: true,
      approved: false,
    });
    me = LINA;
    expect(await s.approve({ projectId: 'p1', target: F05, decision: 'approve' })).toEqual({
      ok: true,
      approved: true,
    });
  });

  it('a material edit voids the approval; a note edit does not', async () => {
    const s = service();
    me = OMAR;
    await s.approve({ projectId: 'p1', target: F05, decision: 'approve' });
    const current = async () => {
      const r = await s.read({ projectId: 'p1', target: F05 });
      if (!r.ok) throw new Error(r.error);
      return r.state.approvals[0]?.current;
    };
    expect(await current()).toBe(true);
    await writeIssues([
      issue('i_f03', 'F03', 'Omar Sample'),
      issue('i_f05', 'F05', 'Rana Example', {
        note: 'Seen again',
        title: 'Renamed',
        status: 'approved',
      }),
    ]);
    expect(await current()).toBe(true);
    await writeIssues([
      issue('i_f03', 'F03', 'Omar Sample'),
      issue('i_f05', 'F05', 'Rana Example', { severity: 3, status: 'approved' }),
    ]);
    expect(await current()).toBe(false);
  });

  it('the agent can never approve, whoever runs it', async () => {
    const s = service();
    me = OMAR;
    const r = await s.approve(
      { projectId: 'p1', target: F05, decision: 'approve' },
      { via: { agent: { conversation: 'c1', callId: 't1' } } },
    );
    expect(r).toMatchObject({ ok: false, code: 'forbidden' });
    expect(() =>
      registerCollabIpc({
        handle: () => undefined,
        projects: { root: () => root, package: () => undefined },
        journal,
        identity: { me: () => Promise.resolve(RANA) },
        members: createFakeMembers(),
        agentTools: () => ['list_my_work', 'approve_issue'],
      }),
    ).toThrow(/never approve/);
  });

  it('request changes needs a comment; a client acceptance is recorded without approving', async () => {
    const s = service();
    me = OMAR;
    expect(
      (await s.approve({ projectId: 'p1', target: F03, decision: 'changes-requested' })).ok,
    ).toBe(false);
    expect(
      await s.approve({
        projectId: 'p1',
        target: F03,
        decision: 'changes-requested',
        comment: 'Add a close-up photo',
      }),
    ).toEqual({ ok: true, approved: false });
    me = CLEO;
    expect(await s.approve({ projectId: 'p1', target: F05, decision: 'accept' })).toEqual({
      ok: true,
      approved: false,
    });
  });

  it('withdraw by the approver only', async () => {
    const s = service();
    me = OMAR;
    await s.approve({ projectId: 'p1', target: F05, decision: 'approve' });
    const r = await s.read({ projectId: 'p1' });
    if (!r.ok) throw new Error(r.error);
    const id = r.state.approvals[0]?.id ?? '';
    me = LINA;
    expect((await s.withdraw({ projectId: 'p1', id })).ok).toBe(false);
    me = OMAR;
    expect((await s.withdraw({ projectId: 'p1', id })).ok).toBe(true);
    const after = await s.read({ projectId: 'p1' });
    expect(after.ok && after.state.approvals[0]?.withdrawn).toBe(true);
  });

  it('assigns to members only, with a due date; viewers cannot assign', async () => {
    const s = service();
    expect(
      (await s.assign({ projectId: 'p1', target: F03, assignee: `a_${'x'.repeat(26)}` })).ok,
    ).toBe(false);
    expect(
      (await s.assign({ projectId: 'p1', target: F03, assignee: OMAR.actor, due: '2026-10-09' }))
        .ok,
    ).toBe(true);
    me = VERA;
    expect((await s.assign({ projectId: 'p1', target: F03, assignee: null })).ok).toBe(false);
    const r = await s.read({ projectId: 'p1' });
    expect(r.ok && r.state.assignments[0]).toMatchObject({
      assignee: OMAR.actor,
      due: '2026-10-09',
    });
  });

  it('comments: mentions, author-only edit, owner delete, client visibility', async () => {
    const s = service();
    const c = await s.comment({
      projectId: 'p1',
      target: F03,
      text: '@Omar please check the weld',
      view: { camera: { position: [1, 2, 3], target: [0, 0, 0] } },
    });
    if (!c.ok) throw new Error(c.error);
    await s.comment({ projectId: 'p1', target: F03, text: 'Ready for you', visibility: 'client' });
    me = OMAR;
    expect((await s.editComment({ projectId: 'p1', id: c.id, text: 'Hijack' })).ok).toBe(false);
    const omars = await s.comment({ projectId: 'p1', target: F03, text: 'On it', replyTo: c.id });
    if (!omars.ok) throw new Error(omars.error);
    expect((await s.editComment({ projectId: 'p1', id: omars.id, text: 'On it today' })).ok).toBe(
      true,
    );
    me = RANA;
    expect((await s.deleteComment({ projectId: 'p1', id: omars.id })).ok).toBe(true);
    const r = await s.read({ projectId: 'p1', target: F03 });
    if (!r.ok) throw new Error(r.error);
    expect(r.state.comments[0]).toMatchObject({
      mentions: [OMAR.actor],
      view: { camera: { position: [1, 2, 3] } },
    });
    expect(r.state.comments[2]).toMatchObject({ deleted: true, text: null, versions: 2 });
    me = CLEO;
    const client = await s.read({ projectId: 'p1', target: F03 });
    expect(client.ok && client.state.comments.map((x) => x.text)).toEqual(['Ready for you']);
    expect((await s.comment({ projectId: 'p1', target: F03, text: 'Internal?' })).ok).toBe(false);
    expect(
      (await s.comment({ projectId: 'p1', target: F03, text: 'Thanks', visibility: 'client' })).ok,
    ).toBe(true);
  });

  it('owner redaction removes every version from disk and records the ops it removed', async () => {
    const s = service();
    me = OMAR;
    const c = await s.comment({
      projectId: 'p1',
      target: F03,
      text: 'Call me on a private number',
    });
    if (!c.ok) throw new Error(c.error);
    await s.editComment({ projectId: 'p1', id: c.id, text: 'Call me, private number here' });
    expect((await s.redactComment({ projectId: 'p1', id: c.id })).ok).toBe(false);
    me = RANA;
    expect(await s.redactComment({ projectId: 'p1', id: c.id, reason: 'Personal data' })).toEqual({
      ok: true,
      removed: 2,
    });
    const lines = await segmentLines();
    expect(JSON.stringify(lines)).not.toMatch(/private number/);
    const redact = lines.find((l) => l.kind === 'comment.redact');
    expect((redact?.payload as { ops: string[] }).ops).toHaveLength(2);
    for (const l of lines) expect(checkOp(l).id).toBe(true);
    const r = await s.read({ projectId: 'p1', target: F03 });
    expect(r.ok && r.state.comments[0]).toMatchObject({ text: null, redacted: { by: RANA.actor } });
  });
});

describe('report sign-off', () => {
  it('is null for a project that is not shared', async () => {
    expect(await service().signOff('p1')).toBeNull();
  });

  it('lists who reviewed and approved the report, bound to its inputs', async () => {
    await share();
    const s = service();
    me = OMAR;
    await s.approve({ projectId: 'p1', target: F05, decision: 'approve' });
    me = LINA;
    await s.approve({ projectId: 'p1', target: { kind: 'report', id: 'p1' }, decision: 'approve' });
    me = RANA;
    const b = await s.signOff('p1', undefined, () => '2026-10-07');
    expect(b?.prepared).toMatchObject({ name: 'Rana Example', initials: 'RE', date: '2026-10-07' });
    expect(b?.reviewed.map((p) => p.initials)).toEqual(['OS']);
    expect(b?.approved.map((p) => p.initials)).toEqual(['LT']);
    expect(b?.findings).toEqual({ approved: 1, total: 2 });
    await writeIssues([
      issue('i_f03', 'F03', 'Omar Sample', { severity: 4 }),
      issue('i_f05', 'F05', 'Rana Example'),
    ]);
    const after = await s.signOff('p1');
    expect(after?.approved).toEqual([]);
    expect(after?.outOfDate.map((p) => p.initials)).toEqual(['LT']);
  });
});

describe('interim journal', () => {
  it('writes chained aio.op/1 lines with rising clocks and deps on other chains', async () => {
    await journal.append(root, RANA, {
      kind: 'project.share',
      target: { rec: 'project', id: 'p1' },
      payload: { teamProjectId: 'tp1', name: 'Site' },
    });
    await journal.append(root, OMAR, {
      kind: 'comment.add',
      target: { rec: 'issue', id: 'i_f03' },
      payload: { id: 'cm_aaaaaaaaaaaaaaaa', target: F03, text: 'one' },
    });
    await journal.append(root, OMAR, {
      kind: 'comment.add',
      target: { rec: 'issue', id: 'i_f03' },
      payload: { id: 'cm_bbbbbbbbbbbbbbbb', target: F03, text: 'two' },
    });
    const lines = await segmentLines();
    expect(lines).toHaveLength(3);
    for (const l of lines) {
      expect(Op.safeParse(l).success).toBe(true);
      expect(checkOp(l)).toMatchObject({ id: true, payload: true, signature: null });
    }
    const omar = lines.filter((l) => l.act === OMAR.actor);
    expect(omar.map((l) => l.seq)).toEqual([1, 2]);
    expect(omar[1]?.prev).toBe(omar[0]?.id);
    expect(Object.keys(omar[0]?.deps ?? {})).toHaveLength(1);
    const clocks = lines.map((l) => String(l.hlc).slice(0, 18)).sort();
    expect(new Set(clocks).size).toBe(3);
  });
});

describe('collab IPC', () => {
  it('validates requests and responses like main does', async () => {
    await share();
    const { call, channels } = collectHandlers((handle) => {
      registerCollabIpc({
        handle,
        projects: { root: () => root, package: () => undefined },
        journal,
        identity: { me: () => Promise.resolve(OMAR) },
        members: createFakeMembers(),
        agentTools: () => ['list_my_work', 'add_comment', 'request_approval', 'show_thread'],
      });
    });
    expect(channels()).toEqual([
      'collab:approve',
      'collab:assign',
      'collab:comment',
      'collab:deleteComment',
      'collab:editComment',
      'collab:policy',
      'collab:read',
      'collab:redactComment',
      'collab:withdraw',
    ]);
    expect(
      await call('collab:approve', { projectId: 'p1', target: F05, decision: 'approve' }),
    ).toEqual({
      ok: true,
      approved: true,
    });
    const r = await call('collab:read', { projectId: 'p1' });
    expect(r.ok && r.state.policy?.approval.fourEyes).toBe(true);
  });
});
