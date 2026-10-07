import { createHash } from 'node:crypto';
import { DEFAULT_APPROVAL_POLICY, type CollabTarget } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import {
  approvalOutcome,
  issueMaterial,
  projectCollab,
  reportMaterial,
  stateOfTarget,
  type CollabOp,
} from './index';
import { ACTORS, F03, F05, hashOf, op, roleOf } from './testing';

const { rana, omar, lina } = ACTORS;
const isOwner = (a: string) => roleOf(a) === 'owner';
const share = () => op('project.share', rana, 0, { rec: 'project', id: 'p1' }, {});
const comment = (id: string, by: string, at: number, text: string, extra: object = {}) =>
  op('comment.add', by, at, F03, { id, target: F03, text, ...extra });
const approve = (id: string, by: string, at: number, target: CollabTarget, hash: string) =>
  op('approval.add', by, at, target, { id, target, decision: 'approve', contentHash: hash });

const sha = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');

const CM1 = 'cm_aaaaaaaaaaaaaaaa';
const CM2 = 'cm_bbbbbbbbbbbbbbbb';
const AP1 = 'ap_aaaaaaaaaaaaaaaa';
const AP2 = 'ap_bbbbbbbbbbbbbbbb';

/** Every order of a small list (the property the merge rules rely on). */
function permutations<T>(xs: readonly T[]): T[][] {
  if (xs.length <= 1) return [xs.slice()];
  return xs.flatMap((x, i) =>
    permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((p) => [x, ...p]),
  );
}

describe('projectCollab', () => {
  it('an unshared project has no policy: free status stepping as in 0.8', () => {
    const s = projectCollab([comment(CM1, rana, 1, 'Note to self')]);
    expect(s.policy).toBeNull();
    expect(s.comments).toHaveLength(1);
  });

  it('a shared project gets the default policy, folded with the owner policy ops only', () => {
    const ops = [
      share(),
      op('policy.set', omar, 2, { rec: 'policy', id: 'team' }, { approval: { required: 3 } }),
      op('policy.set', rana, 3, { rec: 'policy', id: 'team' }, { approval: { required: 2 } }),
    ];
    const s = projectCollab(ops, { isOwner });
    expect(s.policy?.approval.required).toBe(2);
    expect(s.policy?.approval.fourEyes).toBe(true);
  });

  it('comments: edits by the author only, delete by author or owner, versions counted', () => {
    const ops = [
      share(),
      comment(CM1, omar, 1, 'Weld looks cracked'),
      op('comment.edit', lina, 2, F03, { id: CM1, text: 'Hijacked' }),
      op('comment.edit', omar, 3, F03, { id: CM1, text: 'Weld looks cracked at the toe' }),
      comment(CM2, lina, 4, 'Agreed', { replyTo: CM1 }),
      op('comment.delete', rana, 5, F03, { id: CM2 }),
    ];
    const s = projectCollab(ops, { isOwner });
    const [a, b] = s.comments;
    expect(a?.text).toBe('Weld looks cracked at the toe');
    expect(a?.versions).toBe(2);
    expect(b?.deleted).toBe(true);
    expect(b?.text).toBeNull();
  });

  it('redaction by an owner removes the text even when the add lost its payload', () => {
    const add = comment(CM1, omar, 1, 'A private phone number');
    const bare: CollabOp = { ...add };
    delete bare.payload;
    const redact = op('comment.redact', rana, 2, F03, { id: CM1, ops: [add.id] });
    const byOwner = projectCollab([share(), bare, redact], { isOwner });
    expect(byOwner.comments[0]).toMatchObject({ id: CM1, text: null, author: omar });
    expect(byOwner.comments[0]?.redacted?.by).toBe(rana);
    const byReviewer = projectCollab([share(), add, { ...redact, act: lina }], { isOwner });
    expect(byReviewer.comments[0]?.text).toBe('A private phone number');
  });

  it('assignment: last writer by clock wins, null clears', () => {
    const set = (by: string, at: number, assignee: string | null) =>
      op('assign.set', by, at, F03, { target: F03, assignee, due: '2026-10-09' });
    expect(projectCollab([set(rana, 1, omar), set(lina, 2, lina)]).assignments[0]?.assignee).toBe(
      lina,
    );
    expect(projectCollab([set(rana, 1, omar), set(lina, 2, null)]).assignments).toEqual([]);
  });

  it('withdraw by the same actor only', () => {
    const ops = [
      share(),
      approve(AP1, omar, 1, F05, hashOf('a')),
      op('approval.withdraw', lina, 2, F05, { id: AP1 }),
    ];
    expect(projectCollab(ops).approvals[0]?.withdrawn).toBe(false);
    ops.push(op('approval.withdraw', omar, 3, F05, { id: AP1 }));
    expect(projectCollab(ops).approvals[0]?.withdrawn).toBe(true);
  });

  it('is independent of arrival order', () => {
    const ops = [
      share(),
      comment(CM1, omar, 1, 'One'),
      op('comment.edit', omar, 2, F03, { id: CM1, text: 'Two' }),
      op('assign.set', rana, 3, F03, { target: F03, assignee: omar }),
      op('assign.set', lina, 4, F03, { target: F03, assignee: lina }),
      approve(AP1, omar, 5, F05, hashOf('a')),
    ];
    const first = JSON.stringify(projectCollab(ops, { isOwner }));
    for (const p of permutations(ops))
      expect(JSON.stringify(projectCollab(p, { isOwner }))).toBe(first);
  });

  it('stateOfTarget keeps one target', () => {
    const ops = [comment(CM1, omar, 1, 'On F03'), approve(AP1, omar, 2, F05, hashOf('a'))];
    const s = stateOfTarget(projectCollab(ops), F03);
    expect(s.comments).toHaveLength(1);
    expect(s.approvals).toHaveLength(0);
  });
});

describe('approvals and material content (decision 6)', () => {
  const fields = DEFAULT_APPROVAL_POLICY.materialFields;
  const issue = {
    id: 'i_f05',
    classId: 'corrosion',
    severityModelId: 'sev4',
    severity: 2,
    status: 'reviewed',
    title: 'Corrosion at the flange',
    note: '',
    sightings: [{ on: 'mesh' }],
    measurements: [],
  };
  const hash = (i: typeof issue) => sha(issueMaterial(i, fields));
  const target = (i: typeof issue) => ({
    creator: rana,
    materialHash: hash(i),
    roleOf,
  });
  const project = (i: typeof issue, ops: CollabOp[]) =>
    projectCollab([share(), ...ops], {
      isOwner,
      materialHashOf: (t) => (t.id === i.id ? hash(i) : null),
    });

  it('four-eyes refuses the creator; another reviewer completes it', () => {
    const s = project(issue, [approve(AP1, rana, 1, F05, hash(issue))]);
    const mine = approvalOutcome(DEFAULT_APPROVAL_POLICY, s.approvals, target(issue));
    expect(mine.approved).toBe(false);
    expect(mine.notCounted).toEqual([{ id: AP1, why: 'four-eyes' }]);
    const both = project(issue, [
      approve(AP1, rana, 1, F05, hash(issue)),
      approve(AP2, omar, 2, F05, hash(issue)),
    ]);
    expect(approvalOutcome(DEFAULT_APPROVAL_POLICY, both.approvals, target(issue)).approved).toBe(
      true,
    );
  });

  it('four-eyes also refuses the last material editor', () => {
    const s = project(issue, [approve(AP1, omar, 1, F05, hash(issue))]);
    const r = approvalOutcome(DEFAULT_APPROVAL_POLICY, s.approvals, {
      ...target(issue),
      lastEditor: omar,
    });
    expect(r.notCounted).toEqual([{ id: AP1, why: 'four-eyes' }]);
  });

  it('two approvals required: approved on the second', () => {
    const two = { ...DEFAULT_APPROVAL_POLICY, required: 2 };
    const one = project(issue, [approve(AP1, omar, 1, F05, hash(issue))]);
    expect(approvalOutcome(two, one.approvals, target(issue)).approved).toBe(false);
    const both = project(issue, [
      approve(AP1, omar, 1, F05, hash(issue)),
      approve(AP2, lina, 2, F05, hash(issue)),
    ]);
    expect(approvalOutcome(two, both.approvals, target(issue)).approved).toBe(true);
  });

  it('a material edit voids the approval; a note or title edit does not; approving does not', () => {
    const ops = [approve(AP2, omar, 1, F05, hash(issue))];
    const severity = { ...issue, severity: 3 };
    expect(project(severity, ops).approvals[0]?.current).toBe(false);
    expect(
      approvalOutcome(DEFAULT_APPROVAL_POLICY, project(severity, ops).approvals, target(severity))
        .approved,
    ).toBe(false);
    const noted = { ...issue, note: 'Seen again from the north', title: 'Flange corrosion' };
    expect(project(noted, ops).approvals[0]?.current).toBe(true);
    const approved = { ...issue, status: 'approved' };
    expect(project(approved, ops).approvals[0]?.current).toBe(true);
    const draft = { ...issue, status: 'draft' };
    expect(project(draft, ops).approvals[0]?.current).toBe(false);
  });

  it('withdrawing the completing approval undoes the outcome', () => {
    const ops = [
      approve(AP2, omar, 1, F05, hash(issue)),
      op('approval.withdraw', omar, 2, F05, { id: AP2 }),
    ];
    const s = project(issue, ops);
    expect(approvalOutcome(DEFAULT_APPROVAL_POLICY, s.approvals, target(issue)).approved).toBe(
      false,
    );
  });

  it('report sign-off is bound to the hash of the report inputs', () => {
    const report: CollabTarget = { kind: 'report', id: 'p1' };
    const inputs = (issues: (typeof issue)[]) => sha(reportMaterial('p1', issues, fields));
    const before = inputs([issue]);
    const ops = [share(), approve(AP1, omar, 1, report, before)];
    const same = projectCollab(ops, { materialHashOf: () => inputs([{ ...issue, note: 'x' }]) });
    expect(same.approvals[0]?.current).toBe(true);
    const changed = projectCollab(ops, {
      materialHashOf: () => inputs([{ ...issue, severity: 4 }]),
    });
    expect(changed.approvals[0]?.current).toBe(false);
  });
});
