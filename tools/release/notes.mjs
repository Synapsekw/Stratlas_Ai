#!/usr/bin/env node
// Release notes from conventional commits between two git refs, as Markdown.
//
// The range runs from the newest `v<version>` tag before `--to` (or the first commit when there
// is none) to `--to` (default HEAD). Only what a user notices is listed: `feat` under "New",
// `fix` under "Fixed", `perf` under "Faster", and anything marked breaking (`!` or a
// `BREAKING CHANGE:` footer) first. Merges, docs, tests, chores and refactors are left out.
//
// The app bundles the notes of its own version (electron.vite.config.ts, Settings, About and
// updates) and tools/release/feed.mjs puts them in the update feed.
//
// Usage: node tools/release/notes.mjs [--from <ref>] [--to <ref>] [--version 1.2.3] [--json] [--out file]
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');

/** Items listed per group before "and N more". */
export const GROUP_LIMIT = 60;

const GROUPS = [
  { key: 'breaking', title: 'Breaking changes' },
  { key: 'feat', title: 'New' },
  { key: 'fix', title: 'Fixed' },
  { key: 'perf', title: 'Faster' },
];

const SUBJECT = /^(?<type>[a-z]+)(?:\((?<scope>[^)]*)\))?(?<bang>!)?:\s*(?<text>.+)$/;

/**
 * Parse one commit. Returns null for anything that is not a conventional commit.
 * @param {string} subject
 * @param {string} [body]
 */
export function parseCommit(subject, body = '') {
  const m = SUBJECT.exec(subject.trim());
  if (!m?.groups) return null;
  const { type = '', scope, bang, text = '' } = m.groups;
  const breaking = Boolean(bang) || /^BREAKING[ -]CHANGE:/m.test(body);
  return { type, scope: scope ?? null, text: text.trim(), breaking };
}

const sentence = (t) => {
  const s = t.trim().replace(/\s+/g, ' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
};

/**
 * Group parsed commits for the notes; duplicates (same text) collapse to one line.
 * @param {{ subject: string, body?: string }[]} commits newest first, as git log lists them
 */
export function groupCommits(commits) {
  /** @type {Record<string, string[]>} */
  const groups = { breaking: [], feat: [], fix: [], perf: [] };
  const seen = new Set();
  for (const c of commits) {
    const p = parseCommit(c.subject, c.body);
    if (!p) continue;
    const key = p.breaking ? 'breaking' : p.type;
    const list = groups[key];
    if (!list) continue;
    const line = sentence(p.text);
    if (seen.has(line.toLowerCase())) continue;
    seen.add(line.toLowerCase());
    list.push(line);
  }
  return groups;
}

/**
 * Markdown for one version.
 * @param {{ version: string, date?: string, productName?: string, commits: { subject: string, body?: string }[], limit?: number }} o
 */
export function renderNotes({
  version,
  date,
  productName = 'Quadrion AI',
  commits,
  limit = GROUP_LIMIT,
}) {
  const groups = groupCommits(commits);
  const lines = [`# ${productName} ${version}`];
  if (date) lines.push('', date);
  let any = false;
  for (const g of GROUPS) {
    const items = groups[g.key] ?? [];
    if (!items.length) continue;
    any = true;
    lines.push('', `## ${g.title}`, '');
    for (const item of items.slice(0, limit)) lines.push(`- ${item}`);
    if (items.length > limit) lines.push(`- and ${String(items.length - limit)} more`);
  }
  if (!any) lines.push('', 'Maintenance release: no user-visible changes.');
  return `${lines.join('\n')}\n`;
}

const git = (args, cwd) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });

/**
 * The newest `v*` tag that is an ancestor of `to`, excluding a tag on `to` itself; null when
 * there is none (the first release, or a shallow clone without tags).
 */
export function previousTag(to = 'HEAD', cwd = root) {
  try {
    return (
      git(['describe', '--tags', '--abbrev=0', '--match', 'v[0-9]*', `${to}^`], cwd).trim() || null
    );
  } catch {
    return null;
  }
}

/** Commits in `from..to` (all of `to`'s history when `from` is null), newest first. */
export function readCommits(from, to = 'HEAD', cwd = root) {
  const range = from ? `${from}..${to}` : to;
  const out = git(['log', '--no-merges', '--format=%s%x1f%b%x1e', range], cwd);
  return out
    .split('\x1e')
    .map((r) => r.replace(/^\s+/, ''))
    .filter(Boolean)
    .map((r) => {
      const [subject = '', body = ''] = r.split('\x1f');
      return { subject, body };
    });
}

/** Version of the desktop app (apps/desktop/package.json). */
/** The product name from packages/brand/brand.json under `cwd`. */
function productNameAt(cwd) {
  try {
    return JSON.parse(readFileSync(join(cwd, 'packages/brand/brand.json'), 'utf8')).productName;
  } catch {
    return 'Quadrion AI';
  }
}

export function appVersion(cwd = root) {
  return JSON.parse(readFileSync(join(cwd, 'apps/desktop/package.json'), 'utf8')).version;
}

/**
 * Notes for the running checkout. Never throws: without git the notes say so.
 * @param {{ from?: string | null, to?: string, version?: string, cwd?: string, date?: string }} [o]
 */
export function releaseNotes(o = {}) {
  const cwd = o.cwd ?? root;
  const version = o.version ?? appVersion(cwd);
  const to = o.to ?? 'HEAD';
  let commits;
  let from = o.from ?? null;
  try {
    if (o.from === undefined) from = previousTag(to, cwd);
    commits = readCommits(from, to, cwd);
  } catch {
    return {
      version,
      from,
      markdown: `# ${productNameAt(cwd)} ${version}\n\nRelease notes are not available in this build.\n`,
    };
  }
  const date = o.date ?? new Date().toISOString().slice(0, 10);
  return {
    version,
    from,
    markdown: renderNotes({ version, date, productName: productNameAt(cwd), commits }),
  };
}

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const notes = releaseNotes({
    ...(arg('--from') !== undefined ? { from: arg('--from') } : {}),
    ...(arg('--to') !== undefined ? { to: arg('--to') } : {}),
    ...(arg('--version') !== undefined ? { version: arg('--version') } : {}),
  });
  const text = process.argv.includes('--json') ? `${JSON.stringify(notes)}\n` : notes.markdown;
  const out = arg('--out');
  if (out) writeFileSync(out, text);
  else process.stdout.write(text);
}
