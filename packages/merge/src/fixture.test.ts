import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSegment } from '@aio/journal';
import type { Op } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { applyIssues, project, stateFileText } from './index';

const fixtures = fileURLToPath(new URL('../../schema/src/__fixtures__/journal/', import.meta.url));
const keys = JSON.parse(readFileSync(join(fixtures, 'TEST-ONLY-KEYS.json'), 'utf8')) as {
  people: { name: string; actor: string; device: string; publicKey: string }[];
};
const keyMap = new Map(keys.people.map((p) => [p.device, p.publicKey]));

function opsOf(root: string): Op[] {
  const dir = join(root, 'journal', 'ops');
  return readdirSync(dir).flatMap((chain) =>
    readdirSync(join(dir, chain)).flatMap((f) =>
      readSegment(readFileSync(join(dir, chain, f), 'utf8')).flatMap((l) =>
        l.ok ? [l.raw as unknown as Op] : [],
      ),
    ),
  );
}

describe('the golden journal fixtures', () => {
  const ops = opsOf(join(fixtures, 'valid'));
  const p = project(ops, { keys: keyMap });

  it('projects the valid three-device history', () => {
    expect(p.held).toEqual([]);
    expect(p.quarantined).toEqual([]);
    expect(p.team.shared).toBe(true);
    expect([...p.team.members.values()].map((m) => [m.name, m.role])).toEqual([
      ['Rana Example', 'owner'],
      ['Omar Sample', 'reviewer'],
      ['Lina Test', 'reviewer'],
    ]);
    expect(p.team.policy?.approval.required).toBe(2);
    const f01 = p.issues.find((i) => i.id === 'i_f01');
    expect(f01?.state).toBe('live');
    expect(f01?.record.severity).toBe(4);
    expect(f01?.record.status).toBe('approved');
    expect(f01?.record.sightings).toHaveLength(2);
    expect(p.collab.comments.map((c) => c.id)).toEqual([
      'cm_aaaaaaaaaaaaaaaa',
      'cm_bbbbbbbbbbbbbbbb',
    ]);
    expect(p.collab.assignments.map((a) => a.assignee)).toEqual([keys.people[2]?.actor]);
    expect(p.collab.approvals.filter((a) => !a.withdrawn)).toHaveLength(2);
    expect(p.conflicts).toEqual([]);
  });

  it('writes issues.json as today: schema keys in order, one issue', () => {
    const { value, problems } = applyIssues(null, p);
    expect(problems).toEqual([]);
    const text = stateFileText(value);
    expect(
      text.startsWith(
        '{\n  "schema": "aio.issues/1",\n  "issues": [\n    {\n      "id": "i_f01",\n      "code": "F01",',
      ),
    ).toBe(true);
    expect(text.endsWith('}\n')).toBe(true);
  });

  it('quarantines the op whose signature does not verify', () => {
    const forged = project(opsOf(join(fixtures, 'tampered', 'bad-signature')), { keys: keyMap });
    expect(forged.quarantined.map((q) => q.reason)).toContain('signature');
    const edited = project(opsOf(join(fixtures, 'tampered', 'edited-payload')), { keys: keyMap });
    expect(edited.quarantined.map((q) => q.reason)).toContain('hash');
  });

  it('holds ops after a removed line instead of applying them', () => {
    const removed = project(opsOf(join(fixtures, 'tampered', 'removed-line')));
    expect(removed.held.length).toBeGreaterThan(0);
    expect(removed.held[0]?.missing.length).toBeGreaterThan(0);
  });
});
