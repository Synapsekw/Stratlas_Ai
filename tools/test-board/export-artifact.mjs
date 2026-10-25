#!/usr/bin/env node
/* eslint-disable no-console -- CLI output */
// Turns a listing of the old Artifact's answers store into the results files the test board and
// the website's answer import read (format quadrion-test-results/1), one file per tester.
//
//   node tools/test-board/export-artifact.mjs <export.json> --out <folder>
//
// The export is what a session writes from ArtifactData listings:
//   { "format": "artifact-db-export",
//     "collections": { "results/<tester>/items": [ { "id": "<line id>", "data": { s, c, t } } ] } }
// The results hold tester answers, so the output folder must lie outside the repository.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const collection = /^results\/([^/]+)\/items$/;

/** One results payload per tester; records with neither a status nor a comment are dropped. */
export function toResultsFiles(exported, { board, now }) {
  if (exported?.format !== 'artifact-db-export') throw new Error('Not an artifact-db-export file.');
  const out = [];
  for (const [name, records] of Object.entries(exported.collections ?? {})) {
    const m = collection.exec(name);
    if (!m) continue;
    const results = {};
    for (const { id, data } of records) {
      const s = ['pass', 'fail', 'skip'].includes(data?.s) ? data.s : '';
      const c = String(data?.c ?? '');
      if (!s && !c) continue;
      results[id] = { s, c, t: String(data?.t ?? '') };
    }
    out.push({
      tester: m[1],
      file: {
        format: 'quadrion-test-results/1',
        board,
        tester: m[1],
        name: '',
        savedAt: now.toISOString(),
        lines: 0,
        answered: Object.keys(results).length,
        results,
      },
    });
  }
  return out;
}

/** Throws when the folder is the repository or lies inside it. */
export function assertOutsideRepo(folder) {
  const rel = relative(root, resolve(folder));
  if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel)))
    throw new Error(`The output folder ${folder} is inside the repository; use a private folder.`);
}

export function writeResultsFiles(files, folder) {
  mkdirSync(folder, { recursive: true });
  for (const { tester, file } of files)
    writeFileSync(
      join(folder, `quadrion-test-results-${tester}.json`),
      `${JSON.stringify(file, null, 2)}\n`,
    );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const argv = process.argv.slice(2);
  const k = argv.indexOf('--out');
  const input = argv.find((a, i) => !a.startsWith('--') && i !== k + 1);
  if (!input || k === -1 || !argv[k + 1])
    throw new Error('Usage: export-artifact.mjs <export.json> --out <folder>');
  const out = resolve(argv[k + 1]);
  assertOutsideRepo(out);
  const files = toResultsFiles(JSON.parse(readFileSync(input, 'utf8')), {
    board: 'Quadrion Test Run',
    now: new Date(),
  });
  writeResultsFiles(files, out);
  for (const { tester, file } of files) console.log(`${tester}: ${file.answered} answers`);
}
