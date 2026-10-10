// SessionStart hook: prints a compact orientation dump (branch, worktrees, north-star section 3,
// recent session notes, drafts) to stdout, which Claude Code injects as session context.
//
//   node tools/agent/session-context.mjs
//
// Read-only and local: never fetches (ahead/behind is against the local origin/main ref, which may
// be stale). Always exits 0; a broken SessionStart hook must never break a session. The pure
// helpers are exported for the tests and for the other tools/agent scripts.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const NORTH_STAR = 'docs/NORTH-STAR.md';
export const SESSIONS_DIR = 'docs/sessions';
const MAX_WORKTREES = 10;
const MAX_NOW_LINES = 14;

/** Runs git with optional locks off; returns trimmed stdout or null on any failure. */
export function git(args, cwd = process.cwd()) {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
      windowsHide: true,
    }).trimEnd();
  } catch {
    return null;
  }
}

export const toPosix = (p) => p.replace(/\\/g, '/');

/** True when this module was run directly (`node file.mjs`) rather than imported. */
export function isEntryPoint(metaUrl) {
  try {
    const argUrl = pathToFileURL(process.argv[1] ?? '').href;
    return process.platform === 'win32'
      ? argUrl.toLowerCase() === metaUrl.toLowerCase()
      : argUrl === metaUrl;
  } catch {
    return false;
  }
}

/** A linked worktree's git-dir lives under the main repo's .git/worktrees/. */
export function isLinkedWorktreeGitDir(gitDir) {
  return /(^|\/)\.git\/worktrees\//.test(toPosix(gitDir));
}

const splitLines = (text) => text.split(/\r?\n/);

/** Lines of the north-star's "## 3" section (heading excluded), or null when there is none. */
export function extractNowSection(text) {
  const lines = splitLines(text);
  const start = lines.findIndex((l) => /^## 3(\.|\s|$)/.test(l));
  if (start === -1) return null;
  let end = lines.findIndex((l, i) => i > start && /^## /.test(l));
  if (end === -1) end = lines.length;
  const body = lines.slice(start + 1, end);
  while (body.length > 0 && body[0].trim() === '') body.shift();
  while (body.length > 0 && body[body.length - 1].trim() === '') body.pop();
  return body;
}

/** A scalar frontmatter value (e.g. last-updated), or null. */
export function frontmatterValue(text, key) {
  const lines = splitLines(text);
  if (lines[0]?.trim() !== '---') return null;
  for (const line of lines.slice(1)) {
    if (line.trim() === '---') break;
    const match = /^([\w-]+):\s*(.*)$/.exec(line);
    if (match?.[1] === key) return match[2].replace(/^['"]|['"]$/g, '').trim();
  }
  return null;
}

/** A note's title: frontmatter `title`, else its first `# ` heading, else the fallback. */
export function noteTitle(text, fallback) {
  const fromMatter = frontmatterValue(text, 'title');
  if (fromMatter) return fromMatter;
  const heading = splitLines(text).find((l) => /^# \S/.test(l));
  return heading ? heading.slice(2).trim() : fallback;
}

export const isDraftName = (name) => /^_draft-.*\.md$/.test(name);

/** The n newest dated session notes (names start YYYY-MM-DD-HHmm, so they sort by name). */
export function newestNoteNames(names, n = 3) {
  return names
    .filter((name) => /^\d{4}-\d{2}-\d{2}-\d{4}.*\.md$/.test(name))
    .sort()
    .reverse()
    .slice(0, n);
}

/** Session note and draft file names, or empty lists when the folder is missing. */
export function readSessionsDir(root) {
  const dir = join(root, SESSIONS_DIR);
  let names = [];
  try {
    if (existsSync(dir)) names = readdirSync(dir);
  } catch {
    names = [];
  }
  const notes = newestNoteNames(names).map((name) => {
    let title = name;
    try {
      title = noteTitle(readFileSync(join(dir, name), 'utf8'), name);
    } catch {
      // unreadable note: show the file name
    }
    return { name, title };
  });
  return { notes, drafts: names.filter(isDraftName).sort() };
}

/** The repo-relative paths in `git status --porcelain -z` output (rename sources skipped). */
export function parsePorcelainZ(text) {
  const parts = text.split('\0');
  const paths = [];
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (entry.length < 4) continue;
    paths.push(toPosix(entry.slice(3)));
    if (entry[0] === 'R' || entry[0] === 'C') i++; // the next entry is the original path
  }
  return paths;
}

/** Worktrees from `git worktree list --porcelain`: [{ path, branch }]. */
export function parseWorktrees(text) {
  const result = [];
  for (const block of text.split(/\r?\n\r?\n/)) {
    const lines = splitLines(block);
    const path = lines.find((l) => l.startsWith('worktree '))?.slice(9);
    if (!path) continue;
    const ref = lines.find((l) => l.startsWith('branch '))?.slice(7);
    const branch = ref ? ref.replace(/^refs\/heads\//, '') : '(detached)';
    result.push({ path: toPosix(path), branch });
  }
  return result;
}

/** One display line per worktree, the current one starred, capped with a "+N more" line. */
export function formatWorktrees(worktrees, currentRoot, max = MAX_WORKTREES) {
  const current = toPosix(currentRoot).toLowerCase();
  const mainPath = worktrees[0]?.path;
  const label = (wt) => {
    if (wt.path === mainPath) return '(main checkout)';
    const m = /\/\.claude\/worktrees\/([^/]+)$/.exec(wt.path);
    return m ? m[1] : wt.path;
  };
  const isCurrent = (wt) => wt.path.toLowerCase() === current;
  const ordered = [...worktrees.filter(isCurrent), ...worktrees.filter((wt) => !isCurrent(wt))];
  const lines = ordered
    .slice(0, max)
    .map((wt) => `  ${isCurrent(wt) ? '*' : ' '} ${label(wt)}  [${wt.branch}]`);
  if (ordered.length > max) lines.push(`    +${ordered.length - max} more (git worktree list)`);
  return lines;
}

/** "ahead A, behind B" from `git rev-list --left-right --count origin/main...HEAD`. */
export function parseAheadBehind(text) {
  const match = /^(\d+)\s+(\d+)/.exec(text?.trim() ?? '');
  return match ? { behind: Number(match[1]), ahead: Number(match[2]) } : null;
}

/** The repo root for cwd, falling back to CLAUDE_PROJECT_DIR / cwd outside a repo. */
export function resolveRoot(cwd = process.cwd()) {
  const top = git(['rev-parse', '--show-toplevel'], cwd);
  return top ?? process.env.CLAUDE_PROJECT_DIR ?? cwd;
}

/** Reads the north-star file, or null. */
export function readNorthStar(root) {
  try {
    return readFileSync(join(root, NORTH_STAR), 'utf8');
  } catch {
    return null;
  }
}

function buildContext() {
  const root = resolveRoot();
  const out = ['=== Quadrion session context (SessionStart) ==='];

  if (git(['rev-parse', '--git-dir'], root) !== null) {
    const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], root) ?? 'unknown';
    const head = git(['log', '-1', '--format=%h %s'], root) ?? '(no commits)';
    out.push(`Branch: ${branch} @ ${head}`);

    const dirty = parsePorcelainZ(git(['status', '--porcelain', '-z'], root) ?? '').length;
    const counts = parseAheadBehind(
      git(['rev-list', '--left-right', '--count', 'origin/main...HEAD'], root),
    );
    const vsMain = counts
      ? `vs local origin/main: ahead ${counts.ahead}, behind ${counts.behind} (no fetch)`
      : 'origin/main ref not found';
    out.push(`Uncommitted: ${dirty} path(s); ${vsMain}`);

    const worktrees = parseWorktrees(git(['worktree', 'list', '--porcelain'], root) ?? '');
    out.push(`Worktrees (${worktrees.length}):`);
    out.push(...formatWorktrees(worktrees, root));
  } else {
    out.push(`Not inside a git repository (${root}).`);
  }

  const northStar = readNorthStar(root);
  const now = northStar === null ? null : extractNowSection(northStar);
  if (northStar === null) {
    out.push(`North-star not found (${NORTH_STAR}).`);
  } else if (now === null) {
    out.push(`North-star has no "## 3" section (${NORTH_STAR}).`);
  } else {
    const updated = frontmatterValue(northStar, 'last-updated') ?? '?';
    out.push(`North-star section 3 (last-updated ${updated}):`);
    out.push(...now.slice(0, MAX_NOW_LINES));
    if (now.length > MAX_NOW_LINES) {
      out.push(`  (+${now.length - MAX_NOW_LINES} more lines in ${NORTH_STAR})`);
    }
  }

  const { notes, drafts } = readSessionsDir(root);
  if (notes.length > 0) {
    out.push('Recent session notes:');
    for (const note of notes) out.push(`  ${note.name}  ${note.title}`);
  } else {
    out.push(`No session notes yet (${SESSIONS_DIR}).`);
  }
  if (drafts.length > 0) {
    out.push(`Drafts to fold in via /wrapup: ${drafts.join(', ')}`);
  }

  out.push(
    'Rules: CLAUDE.md. Build in your own worktree; hand branches to the Orchestrator; ' +
      'end a working block with /wrapup.',
  );
  out.push('Full context: node tools/agent/wrapup-context.mjs');
  return out.join('\n') + '\n';
}

function main() {
  try {
    process.stdout.write(buildContext());
  } catch {
    // never fail the session over orientation output
  }
  process.exitCode = 0;
}

if (isEntryPoint(import.meta.url)) main();
