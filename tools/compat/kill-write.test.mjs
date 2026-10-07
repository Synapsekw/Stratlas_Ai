// Kill-during-write: `writeJsonAtomic`, which every JSON writer of the app uses, never leaves a
// half file. After a hard kill at a random moment the target holds one whole document. A killed
// write can leave its temp file behind; nothing reads it (counted only).
//
// The `.bak` is copied to a temp file and renamed over (M9 integration, T8 finding 2), so it is
// whole after a kill too; that check runs on every merge, and longer with STRATLAS_KILL_BAK=1
// (more rounds with STRATLAS_KILL_ROUNDS). The journal appender is killed mid-append as well: only
// the last line of the segment may be torn, every earlier op stays whole and chained.
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { killDuringWrite } from './kill-harness.mjs';
import { prng } from './prng.mjs';

const writer = fileURLToPath(new URL('./kill-writer.mjs', import.meta.url));
const journalWriter = fileURLToPath(new URL('./kill-journal-writer.mjs', import.meta.url));
const ROUNDS = Number(process.env.STRATLAS_KILL_ROUNDS ?? 12);

function wholeDocument(file) {
  const doc = JSON.parse(readFileSync(file, 'utf8'));
  expect([0, 1]).toContain(doc.n);
  expect(doc.end).toBe(doc.n);
  expect(doc.issues).toHaveLength(20_000);
  expect(doc.issues.every((i) => i.n === doc.n)).toBe(true);
}

function run(name, checkBak) {
  const dir = mkdtempSync(join(tmpdir(), `aio-kill-${name}-`));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  return async () => {
    let leftovers = 0;
    await killDuringWrite({
      script: writer,
      args: (round) => [join(dir, `issues-${String(round)}.json`)],
      rounds: ROUNDS,
      rnd: prng(20261007),
      check: (round) => {
        const name = `issues-${String(round)}.json`;
        const names = readdirSync(dir);
        wholeDocument(join(dir, name));
        if (checkBak && names.includes(`${name}.bak`)) wholeDocument(join(dir, `${name}.bak`));
        leftovers += names.filter((n) => n.startsWith(`${name}.`) && n.endsWith('.tmp')).length;
      },
    });
    expect(leftovers).toBeLessThanOrEqual(ROUNDS);
  };
}

describe('kill during an atomic JSON write', () => {
  it('leaves the file whole after every kill', run('file', false), 300_000);

  it('leaves the .bak whole after every kill', run('bak', true), 300_000);
});

/** Every segment line of the chain in `dir`: whole and chained, but for a torn last line. */
function chainWhole(dir) {
  const ops = join(dir, 'journal', 'ops');
  const [chain] = readdirSync(ops);
  expect(chain).toBeTruthy();
  const segs = readdirSync(join(ops, chain)).sort();
  let prev = null;
  let seq = 0;
  let torn = 0;
  segs.forEach((seg, s) => {
    const text = readFileSync(join(ops, chain, seg), 'utf8');
    const lines = text.split('\n');
    const last = lines.pop();
    // a line without its newline is the append the kill cut short: only at the very end
    if (last !== '') {
      expect(s).toBe(segs.length - 1);
      torn++;
    }
    for (const line of lines) {
      const op = JSON.parse(line);
      seq++;
      expect(op.seq).toBe(seq);
      expect(op.prev).toBe(prev);
      expect(typeof op.sig).toBe('string');
      prev = op.id;
    }
  });
  expect(seq).toBeGreaterThan(0);
  return torn;
}

describe('kill during a journal append', () => {
  it('keeps every earlier op whole and chained; at most the last line is torn', async () => {
    const base = mkdtempSync(join(tmpdir(), 'aio-kill-journal-'));
    afterAll(() => rmSync(base, { recursive: true, force: true }));
    let torn = 0;
    await killDuringWrite({
      script: journalWriter,
      args: (round) => [join(base, `p${String(round)}`)],
      rounds: ROUNDS,
      rnd: prng(20261008),
      check: (round) => {
        torn += chainWhole(join(base, `p${String(round)}`));
      },
    });
    expect(torn).toBeLessThanOrEqual(ROUNDS);
  }, 300_000);
});
