#!/usr/bin/env node
/* eslint-disable no-console -- CI step output */
// Does a change touch anything but documents? The changed paths come in on stdin, one per line
// (for a rename, the old path as well as the new one). Prints `code=true` when any path is not a
// document and `code=false` when every path is. A document is a file under `docs/` or any `.md`
// file. An empty list is not docs only: the e2e and pipeline jobs of CI run unless the change is
// known to be documents and nothing else.
//
//   gh api ... | node tools/ci/docs-only.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** True for `docs/**` and for any `.md` file. */
export function isDocPath(path) {
  const p = path.trim().replaceAll('\\', '/');
  return p.startsWith('docs/') || p.toLowerCase().endsWith('.md');
}

/** True when `paths` holds at least one path and none is a code path. */
export function docsOnly(paths) {
  const list = paths.map((p) => p.trim()).filter((p) => p !== '');
  return list.length > 0 && list.every(isDocPath);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const paths = readFileSync(0, 'utf8').split('\n');
  console.log(`code=${docsOnly(paths) ? 'false' : 'true'}`);
}
