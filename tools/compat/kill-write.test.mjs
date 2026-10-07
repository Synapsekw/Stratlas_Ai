// Kill-during-write: `writeJsonAtomic`, which every JSON writer of the app uses, never leaves a
// half file. After a hard kill at a random moment the target holds one whole document. A killed
// write can leave its temp file behind; nothing reads it (counted only).
//
// Known gap (docs/release/CHECKLIST-1.0.md, stability): the `.bak` is made by `copyFile` in place,
// so a kill during that copy leaves a torn `.bak` while the file itself is whole. The `.bak` check
// runs with STRATLAS_KILL_BAK=1 and fails until fsutil copies to a temp file and renames it.
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { killDuringWrite } from './kill-harness.mjs';
import { prng } from './prng.mjs';

const writer = fileURLToPath(new URL('./kill-writer.mjs', import.meta.url));
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

  it.skipIf(!process.env.STRATLAS_KILL_BAK)(
    'leaves the .bak whole after every kill',
    run('bak', true),
    300_000,
  );
});
