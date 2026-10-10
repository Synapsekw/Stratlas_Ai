// Stop hook: on a substantial session, drops a `docs/sessions/_draft-*.md` stub so the work is not
// lost before /wrapup runs, and warns when a plan or decision record changed but the north-star was
// not bumped. Reads the hook's stdin JSON (`transcript_path`, `stop_hook_active`, `cwd`).
//
//   node tools/agent/session-draft.mjs   (Stop hook; stdin is the hook payload)
//
// The repo is public, so the draft holds only the branch, changed paths, counts and commit
// subjects: never prompt or transcript text. No drafts are written inside linked worktrees (those
// sessions hand their branch to the Orchestrator). User-visible output is `{"systemMessage": ...}`
// JSON on stdout. Always exits 0; a broken hook must never break a session.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  NORTH_STAR,
  SESSIONS_DIR,
  git,
  isEntryPoint,
  isLinkedWorktreeGitDir,
  parsePorcelainZ,
  resolveRoot,
  toPosix,
} from './session-context.mjs';

export const FILE_THRESHOLD = 10;
export const TOOL_CALL_THRESHOLD = 20;
export const MAX_TRANSCRIPT_BYTES = 25 * 1024 * 1024;
const RECENT_DRAFT_WINDOW_MS = 2 * 60 * 60 * 1000;
const MAX_LISTED_PATHS = 40;

export function shouldDraftSession({ changedFiles, toolCalls }) {
  return changedFiles >= FILE_THRESHOLD || toolCalls >= TOOL_CALL_THRESHOLD;
}

/** Counts tool_use blocks in assistant messages of transcript JSONL text; bad lines count 0. */
export function countToolCalls(jsonl) {
  let count = 0;
  for (const line of jsonl.split('\n')) {
    if (!line.includes('"tool_use"')) continue; // cheap pre-filter
    try {
      const event = JSON.parse(line);
      if (event?.type !== 'assistant') continue;
      const content = event.message?.content;
      if (!Array.isArray(content)) continue;
      for (const block of content) if (block?.type === 'tool_use') count += 1;
    } catch {
      // malformed line: skip
    }
  }
  return count;
}

/**
 * Tool calls in the transcript file. A transcript too big to read is a substantial session by
 * definition, so it counts as the threshold; a missing or unreadable one counts 0.
 */
export function countToolCallsFromTranscript(path, maxBytes = MAX_TRANSCRIPT_BYTES) {
  if (!path) return 0;
  try {
    if (statSync(path).size > maxBytes) return TOOL_CALL_THRESHOLD;
    return countToolCalls(readFileSync(path, 'utf8'));
  } catch {
    return 0;
  }
}

/** Drops this hook's own draft stubs, so a later stop does not look substantial because of them. */
export function filterRelevantPaths(paths) {
  const draft = new RegExp(`^${SESSIONS_DIR}/_draft-[^/]*\\.md$`);
  return paths.map(toPosix).filter((p) => !draft.test(p));
}

// A change under any of these means a plan or decision moved, so the north-star should follow.
const BUMP_TRIGGERS = [/^docs\/plans\//, /^docs\/architecture\/adr\//];

export function needsNorthStarBumpWarning(changedPaths) {
  const paths = changedPaths.map(toPosix);
  const triggered = paths.some((p) => BUMP_TRIGGERS.some((re) => re.test(p)));
  return triggered && !paths.includes(NORTH_STAR);
}

const pad = (n) => String(n).padStart(2, '0');

/** Local-time note stamp YYYY-MM-DD-HHmm (the session-note filename prefix). */
export function noteStamp(date) {
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}-` +
    `${pad(date.getHours())}${pad(date.getMinutes())}`
  );
}

export function buildDraftFilename(date) {
  return `${SESSIONS_DIR}/_draft-${noteStamp(date)}.md`;
}

export function hasRecentDraft(dir, now = Date.now()) {
  try {
    if (!existsSync(dir)) return false;
    return readdirSync(dir)
      .filter((f) => f.startsWith('_draft-') && f.endsWith('.md'))
      .some((f) => now - statSync(join(dir, f)).mtimeMs < RECENT_DRAFT_WINDOW_MS);
  } catch {
    return false;
  }
}

/** The draft's markdown. Only repo metadata goes in; never prompt or transcript text. */
export function renderDraft({ stamp, branch, changedPaths, toolCalls, commits }) {
  const listed = changedPaths.slice(0, MAX_LISTED_PATHS).map((p) => `- \`${p}\``);
  if (changedPaths.length > MAX_LISTED_PATHS) {
    listed.push(`- (+${changedPaths.length - MAX_LISTED_PATHS} more)`);
  }
  const commitLines = commits.length > 0 ? commits.map((c) => `- ${c}`) : ['- (none)'];
  return [
    '---',
    'type: session',
    `date: ${stamp}`,
    `branch: ${branch}`,
    'status: draft',
    '---',
    '',
    '# DRAFT: auto-generated session stub',
    '',
    `> Stop hook fired with ${changedPaths.length} changed path(s) and ${toolCalls} tool call(s).`,
    '> Fold this into a session note with `/wrapup`, or delete it.',
    '',
    '## Uncommitted paths at stop',
    '',
    ...(listed.length > 0 ? listed : ['- (none)']),
    '',
    '## Commits on the branch since origin/main',
    '',
    ...commitLines,
    '',
    '## What changed',
    '',
    '- (fill in)',
    '',
    '## Open threads',
    '',
    '- (fill in)',
    '',
    '## Next session entry point',
    '',
    '- (fill in)',
    '',
  ].join('\n');
}

function readPayload() {
  try {
    return JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    return {};
  }
}

function branchCommits(root) {
  const range = git(['rev-parse', '--verify', '-q', 'origin/main'], root)
    ? ['origin/main..HEAD']
    : ['-5', 'HEAD'];
  const out = git(['log', '--format=%h %s', '-10', ...range], root);
  return out ? out.split(/\r?\n/).filter(Boolean) : [];
}

function run() {
  const payload = readPayload();
  if (payload?.stop_hook_active === true) return [];
  const root = resolveRoot(typeof payload?.cwd === 'string' ? payload.cwd : process.cwd());
  const gitDir = git(['rev-parse', '--git-dir'], root);
  if (gitDir === null) return [];

  const messages = [];
  const changedPaths = filterRelevantPaths(
    parsePorcelainZ(git(['status', '--porcelain', '-z', '--untracked-files=all'], root) ?? ''),
  );
  if (needsNorthStarBumpWarning(changedPaths)) {
    messages.push(
      '[session-draft] A plan or decision record changed under docs/plans or ' +
        `docs/architecture/adr, but ${NORTH_STAR} was not bumped. Update it (or run /wrapup).`,
    );
  }

  const toolCalls = countToolCallsFromTranscript(payload?.transcript_path);
  if (!shouldDraftSession({ changedFiles: changedPaths.length, toolCalls })) return messages;
  if (isLinkedWorktreeGitDir(gitDir)) return messages;
  const sessionsDir = join(root, SESSIONS_DIR);
  if (hasRecentDraft(sessionsDir)) return messages;

  const now = new Date();
  const relPath = buildDraftFilename(now);
  const absPath = join(root, relPath);
  if (existsSync(absPath)) return messages;
  mkdirSync(sessionsDir, { recursive: true });
  const body = renderDraft({
    stamp: noteStamp(now),
    branch: git(['rev-parse', '--abbrev-ref', 'HEAD'], root) ?? 'unknown',
    changedPaths,
    toolCalls,
    commits: branchCommits(root),
  });
  writeFileSync(absPath, body, 'utf8');
  messages.push(
    `[session-draft] Substantial session (${changedPaths.length} changed path(s), ` +
      `${toolCalls} tool call(s)): wrote ${relPath}. Fold it in with /wrapup or delete it.`,
  );
  return messages;
}

function main() {
  let messages;
  try {
    messages = run();
  } catch {
    messages = [];
  }
  if (messages.length > 0) {
    // writeFileSync(1) rather than console.log: stdout is a pipe under the hook runner.
    try {
      writeFileSync(1, JSON.stringify({ systemMessage: messages.join('\n') }) + '\n');
    } catch {
      // nothing more to do
    }
  }
  process.exitCode = 0;
}

if (isEntryPoint(import.meta.url)) main();
