import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkOp, readSegment } from '../../packages/journal/src/index.ts';
import { projectCollab } from '../../packages/collab/src/index.ts';
import { identityOf, PEOPLE, writeTeamJournal } from './team.mjs';

const issue = (id, code) => ({
  id,
  code,
  classId: 'corrosion',
  severityModelId: 'sev4',
  severity: 2,
  status: 'reviewed',
  title: `Finding ${code}`,
  note: '',
  author: 'Rana Example',
  createdAt: '2026-10-07T08:00:00.000Z',
  updatedAt: '2026-10-07T08:00:00.000Z',
  sightings: [{ on: 'mesh', layer: 'm', geom: { type: 'spoint', p: [0, 0, 0], n: [0, 1, 0] } }],
  source: 'human',
});

let dir;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'aio-team-demo-'));
  await writeFile(
    join(dir, 'issues.json'),
    JSON.stringify({ schema: 'aio.issues/1', issues: [issue('i3', 'F03'), issue('i5', 'F05')] }),
  );
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function ops() {
  const root = join(dir, 'journal', 'ops');
  const out = [];
  for (const chain of (await readdir(root)).sort())
    for (const l of readSegment(await readFile(join(root, chain, '000001.jsonl'), 'utf8')))
      if (l.ok) out.push(l.raw);
  return out;
}

describe('team demo journal', () => {
  it('shares the project with three fictional people and seeds the review work', async () => {
    expect(await writeTeamJournal(dir)).toEqual({ ops: 9, issues: ['F03', 'F05'] });
    const all = await ops();
    for (const op of all) expect(checkOp(op)).toMatchObject({ id: true, payload: true });
    const s = projectCollab(all, {
      isOwner: (a) => a === PEOPLE.rana.actor,
      materialHashOf: () => null,
    });
    expect(s.policy?.approval.required).toBe(1);
    expect(s.assignments[0]).toMatchObject({ assignee: PEOPLE.omar.actor, due: '2026-10-09' });
    expect(s.comments.map((c) => c.visibility)).toEqual(['team', 'team', 'client']);
    expect(s.approvals[0]).toMatchObject({ by: PEOPLE.lina.actor, decision: 'approve' });
    expect(JSON.stringify(all)).not.toMatch(/@(?!example\.com|Omar)/);
  });

  it('is byte for byte the same on a second run; shared writes members only', async () => {
    await writeTeamJournal(dir);
    const first = JSON.stringify(await ops());
    await writeTeamJournal(dir);
    expect(JSON.stringify(await ops())).toBe(first);
    await writeTeamJournal(dir, { scenario: 'shared' });
    expect((await ops()).map((o) => o.kind)).toEqual([
      'project.share',
      'member.add',
      'member.add',
      'member.add',
    ]);
  });

  it('gives each person an identity file T2 can read', () => {
    expect(identityOf('omar')).toMatchObject({
      schema: 'aio.identity/1',
      name: 'Omar Sample',
      initials: 'OS',
      email: 'omar@example.com',
    });
    expect(identityOf('omar').actor).toMatch(/^a_[a-z2-7]{26}$/);
  });
});
