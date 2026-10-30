/* eslint-disable no-console -- CLI output */
// The repository is public, so session notes, the north star and commit messages must not name a
// client, site or asset. Checks files and commit messages against the names the demo check knows
// (tools/demo/check-no-client-data.mjs: its built-in list plus the name, customer, site and brand of
// every local project manifest). Tester and person names are not in any list: still read the text.
//
//   node tools/agent/check-public-text.mjs [file ...] [--commits <range>]
//
// Exit code 1 when a name is found, 0 otherwise.
import { execFileSync } from 'node:child_process';
import { closeSync, openSync, readFileSync, readSync } from 'node:fs';
import { extname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { FORBIDDEN, referenceSites } from '../demo/check-no-client-data.mjs';
import { envVar } from '../../packages/brand/src/env.ts';

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function forbiddenWords(names = []) {
  return [
    ...FORBIDDEN,
    ...names.map((n) => [new RegExp(`(^|[^A-Za-z0-9])${escape(n)}([^A-Za-z0-9]|$)`, 'i'), n]),
  ];
}

const BINARY_EXTENSIONS = new Set([
  ...['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.bmp', '.ico', '.tif', '.tiff', '.heic'],
  ...['.woff', '.woff2', '.ttf', '.otf', '.eot', '.zip', '.gz', '.tgz', '.7z', '.rar', '.tar'],
  ...['.pdf', '.mp4', '.webm', '.mov', '.mkv', '.mp3', '.wav', '.exe', '.dll', '.node'],
]);

/** True for a binary file: a known binary extension, or a NUL byte in the first 8 KB. */
export function isBinaryFile(file) {
  if (BINARY_EXTENSIONS.has(extname(file).toLowerCase())) return true;
  const fd = openSync(file, 'r');
  try {
    const buf = Buffer.alloc(8192);
    return buf.subarray(0, readSync(fd, buf, 0, buf.length, 0)).includes(0);
  } finally {
    closeSync(fd);
  }
}

/** Findings for one text: `<where>:<line>: <what>`, one per matching word and line. */
export function findNames(text, where, words) {
  const findings = [];
  text.split(/\r?\n/).forEach((line, i) => {
    for (const [pattern, label] of words) {
      if (pattern.test(line)) findings.push(`${where}:${i + 1}: ${label}`);
    }
  });
  return findings;
}

function main() {
  const argv = process.argv.slice(2);
  const files = [];
  let range = '';
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--commits') {
      range = argv[i + 1] ?? '';
      i += 1;
    } else files.push(argv[i]);
  }
  const dataRoot =
    envVar(process.env, 'DATA') ?? (process.platform === 'win32' ? 'E:\\Stratlas Data' : '');
  const { names } = referenceSites(join(dataRoot, 'projects'));
  const words = forbiddenWords(names);
  const findings = [];
  const skipped = [];
  for (const file of files) {
    if (isBinaryFile(file)) skipped.push(file);
    else findings.push(...findNames(readFileSync(file, 'utf8'), file, words));
  }
  if (skipped.length) {
    console.log(
      `Skipped ${skipped.length} binary file(s), check these by eye: ${skipped.join(', ')}`,
    );
  }
  if (range) {
    const log = execFileSync('git', ['log', '--format=%h %B%x00', range], { encoding: 'utf8' });
    for (const entry of log.split('\0').filter((e) => e.trim())) {
      const text = entry.trim();
      findings.push(...findNames(text, `commit ${text.slice(0, 7)}`, words));
    }
  }
  if (findings.length) {
    console.error('Client or site names found (the repository is public):');
    for (const f of findings) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log(
    `No client or site names in ${files.length - skipped.length} file(s)${range ? ` and ${range}` : ''}.`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
