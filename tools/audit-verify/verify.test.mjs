import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { verifyJournal } from '../../packages/journal/src/index';
import { readProjectFolder, verifyFiles } from './verify.mjs';

const fixtures = fileURLToPath(
  new URL('../../packages/schema/src/__fixtures__/journal/', import.meta.url),
);
const script = fileURLToPath(new URL('./verify.mjs', import.meta.url));
const cases = Object.keys(JSON.parse(readFileSync(join(fixtures, 'cases.json'), 'utf8')));
const NOW = new Date('2026-10-07T12:00:00.000Z');

const run = (...args) =>
  spawnSync(process.execPath, [script, ...args, '--now', NOW.toISOString()], {
    encoding: 'utf8',
  });

describe('tools/audit-verify agrees with Verify in the app', () => {
  it('on the valid three-device history', () => {
    const files = readProjectFolder(join(fixtures, 'valid'));
    const report = verifyFiles(files, { now: NOW });
    expect(report.ok).toBe(true);
    expect(report.counts.ops).toBe(16);
    expect(report).toStrictEqual(verifyJournal(files, { now: NOW }));
  });

  it.each(cases)('on the tampered case "%s"', (name) => {
    const files = readProjectFolder(join(fixtures, 'tampered', name));
    expect(verifyFiles(files, { now: NOW })).toStrictEqual(verifyJournal(files, { now: NOW }));
  });

  it('on quarantined ops and a clock ahead of this computer', () => {
    const files = readProjectFolder(join(fixtures, 'valid'));
    const early = new Date('2020-01-01T00:00:00.000Z');
    const quarantined = new Set([verifyJournal(files, { now: NOW }).chains[0]?.head?.id ?? '']);
    const mine = verifyFiles(files, { now: early, quarantined });
    expect(mine.problems.some((p) => p.code === 'clock-ahead')).toBe(true);
    expect(mine.counts.quarantined).toBe(1);
    expect(mine).toStrictEqual(verifyJournal(files, { now: early, quarantined }));
  });
});

describe('the audit-verify command line', () => {
  let dir;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'audit-verify-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('exits 0 on an intact project folder and 1 on a tampered one', () => {
    const ok = run(join(fixtures, 'valid'));
    expect(ok.status).toBe(0);
    expect(ok.stdout).toMatch(
      /^Intact: 16 entries in 3 chains, all signed\. Audit head [a-f0-9]{64}\./,
    );

    const bad = run(join(fixtures, 'tampered', 'edited-line'));
    expect(bad.status).toBe(1);
    expect(bad.stdout).toContain('hash-mismatch');
    expect(bad.stdout).toMatch(/journal\/ops\/[^ ]+\/000002\.jsonl:1/);
  });

  it('reads an audit JSON export and prints the full report with --json', async () => {
    const files = readProjectFolder(join(fixtures, 'valid'));
    const file = join(dir, 'audit.json');
    await writeFile(
      file,
      JSON.stringify({ schema: 'aio.audit/1', journal: Object.fromEntries(files) }),
    );
    const r = run(file, '--json');
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toStrictEqual(verifyJournal(files, { now: NOW }));
  });

  it('exits 2 on a wrong command or an unreadable input', async () => {
    expect(spawnSync(process.execPath, [script], { encoding: 'utf8' }).status).toBe(2);
    expect(run(join(dir, 'missing.json')).status).toBe(2);
    const file = join(dir, 'other.json');
    await writeFile(file, JSON.stringify({ schema: 'something/1' }));
    expect(run(file).status).toBe(2);
  });
});
