import type { Op } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { project, resolveDrafts, releaseDraft, writeDrafts, type OpDraft } from './index';
import { issueRecord, sighting, sightingHash, TeamSim } from './testing/generator';

const AT = '2026-10-07T08:00:00.000Z';
const f = (id = 'i_f02') => ({ rec: 'issue', id });

/** Rana (0) and Omar (1) share an issue F02, then work apart. */
function apart(people = 2) {
  const sim = new TeamSim({ people });
  sim.write(0, 'issue.create', f(), { record: issueRecord('i_f02', 'F02', 'Rana Example', AT) });
  sim.syncAll();
  return sim;
}
const apply = (sim: TeamSim, who: number, drafts: OpDraft[]) =>
  drafts.map((d) => sim.write(who, d.kind, d.target, d.payload));
const issue = (ops: Op[], id = 'i_f02') => project(ops).issues.find((i) => i.id === id);

describe('issue fields', () => {
  it('concurrent severity edits: the later clock wins, one conflict, Keep mine writes it back', () => {
    const sim = apart();
    sim.write(0, 'issue.patch', f(), { set: { severity: 3 } });
    sim.write(1, 'issue.patch', f(), { set: { severity: 4 } }); // later clock
    sim.syncAll();
    const rana = sim.person(0).actor;
    const p = project(sim.all(), { viewer: rana });
    expect(p.issues[0]?.record.severity).toBe(4);
    expect(p.conflicts).toHaveLength(1);
    const c = p.conflicts[0];
    expect(c).toMatchObject({ field: 'severity', kind: 'value', current: 'theirs' });
    expect(c?.ours).toMatchObject({ value: 3, by: rana });
    expect(c?.theirs).toMatchObject({ value: 4, by: sim.person(1).actor });
    // Omar sees the same conflict the other way round, under the same id
    const omar = project(sim.all(), { viewer: sim.person(1).actor }).conflicts[0];
    expect(omar?.id).toBe(c?.id);
    expect(omar?.ours.value).toBe(4);
    expect(omar?.current).toBe('ours');
    if (!c) return;
    const drafts = resolveDrafts(c, 'ours');
    expect(drafts.map((d) => d.kind)).toEqual(['conflict.resolve', 'issue.patch']);
    apply(sim, 0, drafts);
    sim.syncAll();
    for (const who of [0, 1]) {
      const after = project(sim.known(who));
      expect(after.issues[0]?.record.severity).toBe(3);
      expect(after.conflicts).toEqual([]);
      // the losing values stay in history
      expect(after.history(f(), 'severity').map((h) => h.value)).toEqual([2, 3, 4, 3]);
    }
  });

  it('an edit that had seen the other one is no conflict', () => {
    const sim = apart();
    sim.write(0, 'issue.patch', f(), { set: { severity: 3 } });
    sim.syncAll();
    sim.write(1, 'issue.patch', f(), { set: { severity: 4 } });
    const p = project(sim.all());
    expect(p.issues[0]?.record.severity).toBe(4);
    expect(p.conflicts).toEqual([]);
  });

  it('the same value written apart is no conflict; updatedAt never is', () => {
    const sim = apart();
    sim.write(0, 'issue.patch', f(), { set: { severity: 3, updatedAt: '2026-10-07T09:00:00Z' } });
    sim.write(1, 'issue.patch', f(), { set: { severity: 3, updatedAt: '2026-10-07T09:01:00Z' } });
    expect(project(sim.all()).conflicts).toEqual([]);
  });

  it('class and severity model are one conflict', () => {
    const sim = apart();
    sim.write(0, 'issue.patch', f(), { set: { classId: 'crack', severityModelId: 'sev-5' } });
    sim.write(1, 'issue.patch', f(), { set: { classId: 'leak', severityModelId: 'sev-3' } });
    const [c] = project(sim.all()).conflicts;
    expect(c?.field).toBe('classId');
    expect(c?.theirs.value).toEqual({ classId: 'crack', severityModelId: 'sev-5' });
    expect(c && resolveDrafts(c, 'theirs')[1]?.payload).toEqual({
      set: { classId: 'crack', severityModelId: 'sev-5' },
    });
  });

  it('close against reopen is a status conflict', () => {
    const sim = apart();
    sim.write(0, 'issue.status', f(), { from: 'draft', to: 'reviewed' });
    sim.write(1, 'issue.status', f(), { from: 'draft', to: 'closed' });
    const [c] = project(sim.all()).conflicts;
    expect(c?.kind).toBe('status');
    expect(c && resolveDrafts(c, 'theirs')[1]).toMatchObject({
      kind: 'issue.status',
      payload: { from: 'closed', to: 'reviewed' },
    });
  });
});

describe('sightings', () => {
  it('concurrent adds are both kept', () => {
    const sim = apart();
    const a = sighting(5);
    const b = sighting(6);
    sim.write(0, 'issue.sighting.add', f(), { hash: sightingHash(a), sighting: a });
    sim.write(1, 'issue.sighting.add', f(), { hash: sightingHash(b), sighting: b });
    expect(issue(sim.all())?.record.sightings).toEqual([sighting(1), a, b]);
  });

  it('a remove takes only the adds it had seen (add wins)', () => {
    const sim = apart();
    const a = sighting(5);
    sim.write(0, 'issue.sighting.add', f(), { hash: sightingHash(a), sighting: a });
    sim.syncAll();
    sim.write(1, 'issue.sighting.remove', f(), { hash: sightingHash(a) });
    // Rana adds the same sighting again while apart
    sim.write(0, 'issue.sighting.add', f(), { hash: sightingHash(a), sighting: a });
    expect(issue(sim.all())?.record.sightings).toEqual([sighting(1), a]);
    // without the concurrent add, it is gone
    const seen = sim.all().filter((o) => !(o.seq === 3 && o.act === sim.person(0).actor));
    expect(issue(seen)?.record.sightings).toEqual([sighting(1)]);
  });
});

describe('delete and merge', () => {
  it('delete against a concurrent edit keeps the issue; Delete again deletes it', () => {
    const sim = apart();
    sim.write(0, 'issue.delete', f(), {});
    sim.write(1, 'issue.patch', f(), { set: { note: 'Checked on site' } });
    const p = project(sim.all(), { viewer: sim.person(0).actor });
    expect(p.issues[0]?.state).toBe('live');
    expect(p.issues[0]?.record.note).toBe('Checked on site');
    const c = p.conflicts[0];
    expect(c).toMatchObject({ kind: 'delete-edit', ours: { value: true }, current: 'theirs' });
    if (!c) return;
    sim.syncAll();
    apply(sim, 0, resolveDrafts(c, 'ours'));
    const after = project(sim.all());
    expect(after.issues[0]?.state).toBe('deleted');
    expect(after.conflicts).toEqual([]);
  });

  it('keeping the issue after a delete conflict dismisses the conflict', () => {
    const sim = apart();
    sim.write(0, 'issue.delete', f(), {});
    sim.write(1, 'issue.patch', f(), { set: { note: 'Keep me' } });
    const [c] = project(sim.all()).conflicts;
    if (!c) throw new Error('no conflict');
    expect(resolveDrafts(c, c.current)).toHaveLength(1);
    sim.syncAll();
    apply(sim, 1, resolveDrafts(c, c.current));
    const after = project(sim.all());
    expect(after.conflicts).toEqual([]);
    expect(after.issues[0]?.state).toBe('live');
  });

  it('a delete that had seen every edit deletes', () => {
    const sim = apart();
    sim.write(1, 'issue.patch', f(), { set: { note: 'x' } });
    sim.syncAll();
    sim.write(0, 'issue.delete', f(), {});
    expect(issue(sim.all())?.state).toBe('deleted');
  });

  it('merge carries a sighting added concurrently to the source into the target', () => {
    const sim = apart();
    sim.write(0, 'issue.create', f('i_f03'), {
      record: issueRecord('i_f03', 'F03', 'Rana Example', AT, { sightings: [sighting(9)] }),
    });
    sim.syncAll();
    const late = sighting(7);
    sim.write(0, 'issue.merge', f('i_f03'), { into: 'i_f02' });
    sim.write(1, 'issue.sighting.add', f('i_f03'), { hash: sightingHash(late), sighting: late });
    const p = project(sim.all());
    expect(p.issues.find((i) => i.id === 'i_f03')?.state).toBe('deleted');
    expect(p.issues.find((i) => i.id === 'i_f02')?.record.sightings).toEqual([
      sighting(1),
      sighting(9),
      late,
    ]);
    expect(p.conflicts).toEqual([]);
  });

  it('merge against an edit of the source keeps the source, and the inbox offers merge again', () => {
    const sim = apart();
    sim.write(0, 'issue.create', f('i_f03'), {
      record: issueRecord('i_f03', 'F03', 'Rana Example', AT),
    });
    sim.syncAll();
    sim.write(0, 'issue.merge', f('i_f03'), { into: 'i_f02' });
    sim.write(1, 'issue.patch', f('i_f03'), { set: { severity: 5 } });
    const p = project(sim.all(), { viewer: sim.person(0).actor });
    expect(p.issues.find((i) => i.id === 'i_f03')?.state).toBe('live');
    const c = p.conflicts[0];
    expect(c).toMatchObject({ kind: 'merge', ours: { value: { into: 'i_f02' } } });
    expect(c && resolveDrafts(c, 'ours')[1]).toMatchObject({
      kind: 'issue.merge',
      payload: { into: 'i_f02' },
    });
  });
});

describe('codes', () => {
  it('two issues made apart with one code: the later takes the next free code, with a notice', () => {
    const sim = apart();
    sim.write(0, 'issue.create', f('i_a'), {
      record: issueRecord('i_a', 'F09', 'Rana Example', AT),
    });
    sim.write(
      0,
      'package.export',
      { rec: 'project', id: 'p' },
      {
        file: 'Site F09.aio',
        readOnly: true,
        history: 'summary',
      },
    );
    sim.write(1, 'issue.create', f('i_b'), {
      record: issueRecord('i_b', 'F09', 'Omar Sample', AT),
    });
    sim.syncAll();
    const p = project(sim.all());
    const code = (id: string) => p.issues.find((i) => i.id === id)?.record.code;
    expect([code('i_a'), code('i_b')]).toEqual(['F09', 'F10']);
    expect(p.recodes).toEqual([{ issue: 'i_b', from: 'F09', to: 'F10', delivered: [] }]);
    const c = p.conflicts.find((x) => x.kind === 'code');
    expect(c).toMatchObject({ target: f('i_b'), ours: { value: 'F09' }, theirs: { value: 'F10' } });
    // the recode op makes it stick; the notice stays until dismissed
    sim.write(1, 'issue.recode', f('i_b'), { from: 'F09', to: 'F10' });
    const q = project(sim.all());
    expect(q.recodes).toEqual([]);
    expect(q.conflicts.map((x) => x.kind)).toEqual(['code']);
    const dismiss = q.conflicts[0];
    if (dismiss) apply(sim, 1, resolveDrafts(dismiss, 'theirs'));
    expect(project(sim.all()).conflicts).toEqual([]);
  });

  it('lists packages delivered with the old code', () => {
    const sim = apart();
    sim.write(0, 'issue.create', f('i_a'), {
      record: issueRecord('i_a', 'F09', 'Rana Example', AT),
    });
    // Omar's issue is made later, then he delivers a package with it as F09
    sim.write(1, 'issue.create', f('i_b'), {
      record: issueRecord('i_b', 'F09', 'Omar Sample', AT),
    });
    sim.write(
      1,
      'package.export',
      { rec: 'project', id: 'p' },
      {
        file: 'Site.aio',
        readOnly: true,
        history: 'summary',
      },
    );
    sim.syncAll();
    const p = project(sim.all());
    expect(p.recodes).toEqual([{ issue: 'i_b', from: 'F09', to: 'F10', delivered: ['Site.aio'] }]);
  });
});

describe('other records', () => {
  it('change item confirm against dismiss is a status conflict', () => {
    const sim = apart();
    const item = { rec: 'change-item', id: 'issue:F01', in: 'c1-c2-issues' };
    sim.write(0, 'change.review', item, {
      set: { status: 'confirmed', by: 'Rana Example', at: AT },
    });
    sim.write(1, 'change.review', item, {
      set: { status: 'dismissed', by: 'Omar Sample', at: AT },
    });
    const p = project(sim.all());
    expect(p.subRecords[0]?.set).toMatchObject({ status: 'dismissed', by: 'Omar Sample' });
    const [c] = p.conflicts;
    expect(c).toMatchObject({ kind: 'status', field: 'status' });
    expect(c && resolveDrafts(c, c.current === 'ours' ? 'theirs' : 'ours')[1]).toMatchObject({
      kind: 'change.review',
      payload: { set: { status: 'confirmed', by: 'Rana Example', at: AT } },
    });
  });

  it('procmodel accept against reject is a status conflict', () => {
    const sim = apart();
    const part = { rec: 'part', id: 't1', in: 'm1' };
    sim.write(0, 'procmodel.part', part, { set: { status: 'accepted' } });
    sim.write(1, 'procmodel.part', part, { set: { status: 'rejected' } });
    expect(project(sim.all()).conflicts[0]).toMatchObject({ kind: 'status', target: part });
  });

  it('boundary edits: last writer per pile and date, conflict flagged', () => {
    const sim = apart();
    const edit = (net: number) => ({ record: { pile: 'P1', epoch: 'e1', autoNet: net } });
    sim.write(0, 'boundary.edit', { rec: 'boundary', id: 'P1/e1' }, edit(1));
    sim.write(1, 'boundary.edit', { rec: 'boundary', id: 'P1/e1' }, edit(2));
    const p = project(sim.all());
    expect(p.boundaries[0]?.record.autoNet).toBe(2);
    expect(p.conflicts[0]?.target).toEqual({ rec: 'boundary', id: 'P1/e1' });
  });

  it('narrative versions only grow', () => {
    const sim = apart();
    const v = (text: string) => ({
      record: { part: 'summary', text, source: 'user', createdAt: AT },
    });
    sim.write(0, 'narrative.version', { rec: 'narrative', id: 'summary' }, v('A'));
    sim.write(1, 'narrative.version', { rec: 'narrative', id: 'summary' }, v('B'));
    expect(project(sim.all()).narrative.map((n) => n.version.text)).toEqual(['A', 'B']);
  });
});

describe('collaboration', () => {
  it('two different concurrent assignees are a conflict', () => {
    const sim = apart(3);
    const t = { kind: 'issue', id: 'i_f02' };
    sim.write(0, 'assign.set', f(), { target: t, assignee: sim.person(1).actor });
    sim.write(1, 'assign.set', f(), { target: t, assignee: sim.person(2).actor });
    const p = project(sim.all());
    expect(p.collab.assignments[0]?.assignee).toBe(sim.person(2).actor);
    const [c] = p.conflicts;
    expect(c).toMatchObject({ field: 'assignee', target: f() });
    expect(c && resolveDrafts(c, c.current === 'ours' ? 'theirs' : 'ours')[1]).toMatchObject({
      kind: 'assign.set',
      payload: { target: t, assignee: sim.person(1).actor },
    });
  });

  it('comments only grow; edits are versions by the author', () => {
    const sim = apart();
    const t = { kind: 'issue', id: 'i_f02' };
    const id = 'cm_aaaaaaaaaaaaaaaa';
    sim.write(0, 'comment.add', f(), {
      id,
      target: t,
      text: 'Weld?',
      visibility: 'team',
      mentions: [],
    });
    sim.syncAll();
    sim.write(0, 'comment.edit', f(), { id, text: 'Weld seam?' });
    sim.write(1, 'comment.edit', f(), { id, text: 'Not mine to edit' });
    const p = project(sim.all());
    expect(p.collab.comments[0]).toMatchObject({ text: 'Weld seam?', versions: 2 });
    expect(p.quarantined.map((q) => [q.kind, q.reason])).toEqual([['comment.edit', 'role']]);
  });
});

describe('quarantine', () => {
  function team() {
    const sim = new TeamSim({ people: 3 });
    const [rana, omar, lina] = [0, 1, 2].map((i) => sim.person(i));
    sim.write(
      0,
      'project.share',
      { rec: 'project', id: 't' },
      { teamProjectId: 't', name: 'Site' },
    );
    sim.write(
      0,
      'member.add',
      { rec: 'member', id: omar?.actor ?? '' },
      {
        actor: omar?.actor,
        name: omar?.name,
        initials: omar?.initials,
        role: 'reviewer',
        devices: [{ id: omar?.device }],
      },
    );
    sim.write(
      0,
      'member.add',
      { rec: 'member', id: lina?.actor ?? '' },
      {
        actor: lina?.actor,
        name: lina?.name,
        initials: lina?.initials,
        role: 'viewer',
        devices: [{ id: lina?.device }],
      },
    );
    sim.write(0, 'issue.create', f(), {
      record: issueRecord('i_f02', 'F02', rana?.name ?? '', AT),
    });
    sim.syncAll();
    return sim;
  }

  it('a reviewer changing the CRS is quarantined; an owner releases it with a recorded op', () => {
    const sim = team();
    sim.write(
      1,
      'manifest.entry',
      { rec: 'manifest', id: 'project' },
      { set: { crs: { epsg: 4326 } } },
    );
    sim.write(1, 'manifest.entry', { rec: 'manifest', id: 'layer:dem' }, { set: { name: 'DEM' } });
    sim.syncAll();
    const p = project(sim.all());
    expect(p.quarantined.map((q) => [q.kind, q.reason])).toEqual([['manifest.entry', 'role']]);
    expect(p.subRecords.map((r) => r.ref.id)).toEqual(['layer:dem']);
    const q = p.quarantined[0];
    if (!q) return;
    // a reviewer cannot release it
    apply(sim, 1, [releaseDraft(q)]);
    expect(project(sim.all()).quarantined).toHaveLength(1);
    apply(sim, 0, [releaseDraft(q)]);
    const after = project(sim.all());
    expect(after.quarantined).toEqual([]);
    expect(after.subRecords.map((r) => r.ref.id).sort()).toEqual(['layer:dem', 'project']);
  });

  it('a viewer editing an issue, a non-member and the agent approving are quarantined', () => {
    const sim = team();
    const stranger = new TeamSim({ people: 4 });
    sim.write(2, 'issue.patch', f(), { set: { severity: 5 } });
    sim.write(
      1,
      'approval.add',
      f(),
      {
        id: 'ap_aaaaaaaaaaaaaaaa',
        target: { kind: 'issue', id: 'i_f02' },
        decision: 'approve',
        contentHash: 'a'.repeat(64),
      },
      { via: { agent: { conversation: 'c1', callId: 't1' } } },
    );
    stranger.advance(60_000);
    const outsider = stranger.write(3, 'issue.patch', f(), { set: { severity: 1 } });
    const p = project([...sim.all(), outsider]);
    expect(p.issues[0]?.record.severity).toBe(2);
    expect(p.quarantined.map((q) => q.reason).sort()).toEqual(['non-member', 'role', 'role']);
  });

  it('ops from a revoked device after its revocation are quarantined, earlier ones stay', () => {
    const sim = team();
    sim.write(1, 'issue.patch', f(), { set: { title: 'Before' } });
    sim.syncAll();
    sim.write(
      0,
      'device.revoke',
      { rec: 'device', id: sim.person(1).device },
      {
        device: sim.person(1).device,
      },
    );
    sim.write(1, 'issue.patch', f(), { set: { note: 'After' } });
    const p = project(sim.all());
    expect(p.issues[0]?.record.title).toBe('Before');
    expect(p.issues[0]?.record.note).toBe('');
    expect(p.quarantined.map((q) => q.reason)).toEqual(['revoked']);
  });

  it('a clock two days ahead is held in quarantine; ten minutes ahead is a notice', () => {
    const day = 24 * 60 * 60 * 1000;
    const sim = new TeamSim({ people: 2, skewMs: [0, 2 * day] });
    sim.write(0, 'issue.create', f(), { record: issueRecord('i_f02', 'F02', 'Rana Example', AT) });
    sim.sync(0, 1);
    sim.write(1, 'issue.patch', f(), { set: { severity: 5 } });
    const now = 1_790_000_000_000 + 10;
    const p = project(sim.all(), { now });
    expect(p.quarantined.map((q) => q.reason)).toEqual(['clock-ahead']);
    expect(p.clock).toEqual([
      expect.objectContaining({ device: sim.person(1).device, level: 'hold' }),
    ]);
    const near = new TeamSim({ people: 2, skewMs: [0, 10 * 60 * 1000] });
    near.write(1, 'issue.create', f(), { record: issueRecord('i_f02', 'F02', 'Omar Sample', AT) });
    const q = project(near.all(), { now });
    expect(q.quarantined).toEqual([]);
    expect(q.clock[0]?.level).toBe('notice');
  });
});

describe('restore', () => {
  it('writes a value from history back', () => {
    const sim = apart();
    sim.write(0, 'issue.patch', f(), { set: { title: 'Old title' } });
    sim.write(0, 'issue.patch', f(), { set: { title: 'New title' } });
    const old = project(sim.all())
      .history(f(), 'title')
      .find((h) => h.value === 'Old title');
    apply(sim, 0, writeDrafts(f(), 'title', old?.value));
    expect(issue(sim.all())?.record.title).toBe('Old title');
  });
});
