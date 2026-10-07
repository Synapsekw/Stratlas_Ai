import { describe, expect, it } from 'vitest';
import { createInbox, type Inbox } from './index';
import { issueRecord, TeamSim } from './testing/generator';

const AT = '2026-10-07T08:00:00.000Z';
const f02 = { rec: 'issue', id: 'i_f02' };

/** Two copies, each with its own files, wired as main would wire the `sync:*` channels. */
function copies(sim: TeamSim) {
  const files = [new Map<string, string>(), new Map<string, string>()];
  const inbox = (who: number): Inbox =>
    createInbox({
      ops: () => Promise.resolve(sim.known(who)),
      viewer: sim.person(who).actor,
      append: (d) => {
        sim.write(who, d.kind, d.target, d.payload, d.label ? { label: d.label } : {});
        return Promise.resolve();
      },
      read: (path) => Promise.resolve(files[who]?.get(path) ?? null),
      write: (out) => {
        for (const f of out) files[who]?.set(f.path, f.text);
        return Promise.resolve();
      },
    });
  return { files, inbox };
}

describe('createInbox', () => {
  it('Keep mine writes the chosen value on both copies after the next sync', async () => {
    const sim = new TeamSim({ people: 2 });
    sim.write(0, 'issue.create', f02, { record: issueRecord('i_f02', 'F02', 'Rana Example', AT) });
    sim.syncAll();
    sim.write(0, 'issue.patch', f02, { set: { severity: 3 } });
    sim.write(1, 'issue.patch', f02, { set: { severity: 4 } });
    sim.syncAll();
    const { files, inbox } = copies(sim);
    await inbox(0).refresh();
    await inbox(1).refresh();
    expect(files[0]?.get('issues.json')).toBe(files[1]?.get('issues.json'));
    const listed = await inbox(0).conflicts();
    if (!listed.ok) throw new Error(listed.error);
    expect(listed.conflicts).toHaveLength(1);
    const c = listed.conflicts[0];
    expect(c?.ours.value).toBe(3);
    expect(await inbox(0).resolve({ conflict: c?.id ?? '', choice: 'ours' })).toEqual({ ok: true });
    expect(await inbox(0).resolve({ conflict: c?.id ?? '', choice: 'ours' })).toEqual({
      ok: false,
      error: 'This conflict is already resolved.',
    });
    sim.syncAll();
    await inbox(1).refresh();
    for (const who of [0, 1]) {
      const issues = JSON.parse(files[who]?.get('issues.json') ?? '{}') as {
        issues: { severity: number }[];
      };
      expect(issues.issues[0]?.severity).toBe(3);
      const after = await inbox(who).conflicts();
      expect(after.ok && after.conflicts).toEqual([]);
    }
    expect(files[0]?.get('issues.json')).toBe(files[1]?.get('issues.json'));
  });

  it('restores a value from history by op id', async () => {
    const sim = new TeamSim({ people: 2 });
    sim.write(0, 'issue.create', f02, { record: issueRecord('i_f02', 'F02', 'Rana Example', AT) });
    sim.syncAll();
    const old = sim.write(0, 'issue.patch', f02, { set: { title: 'First' } });
    sim.write(0, 'issue.patch', f02, { set: { title: 'Mine' } });
    sim.write(1, 'issue.patch', f02, { set: { title: 'Theirs' } });
    sim.syncAll();
    const { files, inbox } = copies(sim);
    const listed = await inbox(0).conflicts();
    const id = listed.ok ? (listed.conflicts[0]?.id ?? '') : '';
    expect(await inbox(0).resolve({ conflict: id, choice: 'restore', op: 'f'.repeat(64) })).toEqual(
      {
        ok: false,
        error: 'That earlier value is not in the history.',
      },
    );
    expect(await inbox(0).resolve({ conflict: id, choice: 'restore', op: old.id })).toEqual({
      ok: true,
    });
    expect(files[0]?.get('issues.json')).toContain('"title": "First"');
  });

  it('writes recodes so a renumbered code sticks, and lets only an owner release', async () => {
    const sim = new TeamSim({ people: 2 });
    const rana = sim.person(0);
    const omar = sim.person(1);
    sim.write(
      0,
      'project.share',
      { rec: 'project', id: 't' },
      { teamProjectId: 't', name: 'Site' },
    );
    sim.write(
      0,
      'member.add',
      { rec: 'member', id: omar.actor },
      {
        actor: omar.actor,
        name: omar.name,
        initials: omar.initials,
        role: 'reviewer',
        devices: [{ id: omar.device }],
      },
    );
    sim.syncAll();
    sim.write(
      0,
      'issue.create',
      { rec: 'issue', id: 'i_a' },
      {
        record: issueRecord('i_a', 'F09', rana.name, AT),
      },
    );
    sim.write(
      1,
      'issue.create',
      { rec: 'issue', id: 'i_b' },
      {
        record: issueRecord('i_b', 'F09', omar.name, AT),
      },
    );
    sim.write(
      1,
      'manifest.entry',
      { rec: 'manifest', id: 'project' },
      {
        set: { crs: { epsg: 4326 } },
      },
    );
    sim.syncAll();
    const { files, inbox } = copies(sim);
    const p = await inbox(1).refresh();
    expect(p.recodes).toEqual([]);
    expect(sim.known(1).some((o) => o.kind === 'issue.recode')).toBe(true);
    expect(files[1]?.get('issues.json')).toContain('"code": "F10"');
    const q = await inbox(1).quarantine();
    const op = q.ok ? (q.entries[0]?.op ?? '') : '';
    expect(await inbox(1).release({ op })).toEqual({
      ok: false,
      error: 'Only an owner can apply a quarantined change.',
    });
    expect(await inbox(0).release({ op })).toEqual({ ok: true });
    const after = await inbox(0).quarantine();
    expect(after.ok && after.entries).toEqual([]);
  });
});
