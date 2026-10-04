import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listReports } from './reports';

let dir = '';
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'aio-reports-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('listReports', () => {
  it('lists the PDFs in report/ by name, ignoring other files', async () => {
    await mkdir(join(dir, 'report'));
    await writeFile(join(dir, 'report', 'b Report.PDF'), 'x');
    await writeFile(join(dir, 'report', 'a.pdf'), 'xyz');
    await writeFile(join(dir, 'report', 'findings.csv'), 'x');
    expect(await listReports(dir)).toEqual([
      { path: 'report/a.pdf', name: 'a.pdf', sizeBytes: 3 },
      { path: 'report/b Report.PDF', name: 'b Report.PDF', sizeBytes: 1 },
    ]);
  });

  it('returns nothing when the project has no report folder', async () => {
    expect(await listReports(dir)).toEqual([]);
  });
});
