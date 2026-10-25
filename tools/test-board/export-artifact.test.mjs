import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { assertOutsideRepo, toResultsFiles, writeResultsFiles } from './export-artifact.mjs';

const now = new Date('2026-10-25T10:00:00Z');
const exported = {
  format: 'artifact-db-export',
  collections: {
    'results/tester-1/items': [
      { id: 'setup:install:0123456789', data: { s: 'pass', c: '', t: '2026-10-24T08:00:00Z' } },
      { id: 'setup:map:abcdef0123', data: { s: 'fail', c: 'The map stays blank', t: 'x' } },
    ],
    'results/tester-2/items': [
      { id: 'setup:install:0123456789', data: { s: 'skip', c: '', t: 'y' } },
    ],
  },
};

const tmp = [];
afterEach(() => {
  for (const d of tmp.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('artifact answers export', () => {
  it('turns each tester collection into one results file', () => {
    const files = toResultsFiles(exported, { board: 'Sample board', now });
    expect(files.map((f) => f.tester)).toEqual(['tester-1', 'tester-2']);
    expect(files[0].file).toEqual({
      format: 'quadrion-test-results/1',
      board: 'Sample board',
      tester: 'tester-1',
      name: '',
      savedAt: '2026-10-25T10:00:00.000Z',
      lines: 0,
      answered: 2,
      results: {
        'setup:install:0123456789': { s: 'pass', c: '', t: '2026-10-24T08:00:00Z' },
        'setup:map:abcdef0123': { s: 'fail', c: 'The map stays blank', t: 'x' },
      },
    });
  });

  it('drops records without a status or comment and unknown collection names', () => {
    const files = toResultsFiles(
      {
        format: 'artifact-db-export',
        collections: {
          'results/tester-1/items': [
            { id: 'a:b:0123456789', data: { s: '', c: '', t: '' } },
            { id: 'a:b:0123456780', data: { s: 'pass', c: '', t: '' } },
            { id: 'a:b:0123456781', data: { s: '', c: 'note only', t: '' } },
          ],
          'results/tester-3/other': [{ id: 'a:b:0123456782', data: { s: 'pass' } }],
          notes: [{ id: 'a:b:0123456783', data: { s: 'pass' } }],
        },
      },
      { board: 'Sample board', now },
    );
    expect(files.map((f) => f.tester)).toEqual(['tester-1']);
    expect(Object.keys(files[0].file.results)).toEqual(['a:b:0123456780', 'a:b:0123456781']);
    expect(files[0].file.answered).toBe(2);
  });

  it('refuses an output folder inside the repository', () => {
    expect(() => assertOutsideRepo(join(process.cwd(), 'tools', 'test-board', 'out'))).toThrow(
      /inside the repository/,
    );
    const out = mkdtempSync(join(tmpdir(), 'tb-'));
    tmp.push(out);
    expect(() => assertOutsideRepo(out)).not.toThrow();
    writeResultsFiles(toResultsFiles(exported, { board: 'B', now }), out);
    expect(readdirSync(out).sort()).toEqual([
      'quadrion-test-results-tester-1.json',
      'quadrion-test-results-tester-2.json',
    ]);
    const two = JSON.parse(readFileSync(join(out, 'quadrion-test-results-tester-2.json'), 'utf8'));
    expect(two.answered).toBe(1);
  });
});
