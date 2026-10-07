import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { verifyJournal } from './verify';

const fixtures = fileURLToPath(new URL('../../schema/src/__fixtures__/journal/', import.meta.url));

/** Every file under `<root>/journal`, keyed by its project-relative path with forward slashes. */
export function loadJournalFiles(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else out.set(relative(root, p).split('\\').join('/'), readFileSync(p, 'utf8'));
    }
  };
  walk(join(root, 'journal'));
  return out;
}

interface Expected {
  code: string;
  file?: string;
  line?: number;
  seq?: number;
  chain?: string;
}
const cases = JSON.parse(readFileSync(join(fixtures, 'cases.json'), 'utf8')) as Record<
  string,
  { ok: boolean; expect: Expected[] }
>;

function omarSegment(files: Map<string, string>): [string, string] {
  const hit = [...files].find(([p]) => p.endsWith('gxogqaexfvgkliye/000001.jsonl'));
  if (!hit) throw new Error('No segment of Omar in the fixtures');
  return hit;
}

const NOW = new Date('2026-10-07T12:00:00.000Z');

describe('verifyJournal', () => {
  it('finds the valid three-device history intact and every op signed', () => {
    const r = verifyJournal(loadJournalFiles(join(fixtures, 'valid')), { now: NOW });
    expect(r.problems).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.counts).toMatchObject({ ops: 16, signed: 16, unsigned: 0, redacted: 0 });
    expect(r.chains).toHaveLength(3);
    const rana = r.chains.find((c) => c.segments === 2);
    expect(rana?.ops).toBe(9);
    expect(r.head?.count).toBe(16);
    expect(r.head?.root).toMatch(/^[a-f0-9]{64}$/);
  });

  for (const [name, c] of Object.entries(cases)) {
    it(`names exactly what was done in the tampered case "${name}"`, () => {
      const r = verifyJournal(loadJournalFiles(join(fixtures, 'tampered', name)), { now: NOW });
      expect(r.ok).toBe(c.ok);
      expect(r.problems).toHaveLength(c.expect.length);
      for (const e of c.expect) {
        expect(r.problems).toContainEqual(expect.objectContaining(e));
      }
      for (const p of r.problems) expect(p.message.length).toBeGreaterThan(10);
    });
  }

  it('counts a legitimate redaction and keeps the history intact', () => {
    const r = verifyJournal(loadJournalFiles(join(fixtures, 'tampered', 'redacted-payload')), {
      now: NOW,
    });
    expect(r.counts.redacted).toBe(1);
  });

  it('names a line that is not JSON and keeps checking the rest', () => {
    const files = loadJournalFiles(join(fixtures, 'valid'));
    const [path, text] = omarSegment(files);
    files.set(path, text.replace(/\n$/, '\n{"v":1,"id":\n'));
    const r = verifyJournal(files, { now: NOW });
    expect(r.problems).toEqual([expect.objectContaining({ code: 'parse', file: path, line: 5 })]);
    expect(r.counts.ops).toBe(16);
  });

  it('reports a clock reading far ahead of this machine', () => {
    const r = verifyJournal(loadJournalFiles(join(fixtures, 'valid')), {
      now: new Date('2026-09-01T00:00:00.000Z'),
    });
    expect(r.problems.every((p) => p.code === 'clock-ahead')).toBe(true);
    expect(r.problems.length).toBeGreaterThan(0);
  });

  it('counts quarantined ops it is told about without calling them problems', () => {
    const files = loadJournalFiles(join(fixtures, 'valid'));
    const first = JSON.parse(omarSegment(files)[1].split('\n')[0] ?? '') as { id: string };
    const r = verifyJournal(files, { now: NOW, quarantined: new Set([first.id]) });
    expect(r.ok).toBe(true);
    expect(r.counts.quarantined).toBe(1);
  });
});
