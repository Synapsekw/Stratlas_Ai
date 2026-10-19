// One-call, read-only context gather for /wrapup: date and note-id, location (linked worktree or
// main checkout), branch, status, ahead/behind vs the local origin/main, the full north-star
// section 3, recent session notes and the branch's commits. Plain labelled sections.
//
//   node tools/agent/wrapup-context.mjs
//
// Never fetches and never writes. Always exits 0.
import { dirname } from 'node:path';
import {
  NORTH_STAR,
  SESSIONS_DIR,
  extractNowSection,
  frontmatterValue,
  git,
  isEntryPoint,
  noteStamp,
  parseAheadBehind,
  readNorthStar,
  readSessionsDir,
  resolveRoot,
  toPosix,
} from './session-context.mjs';

const pad = (n) => String(n).padStart(2, '0');

function build() {
  const out = [];
  const section = (title) => out.push('', `== ${title} ==`);

  const now = new Date();
  const local = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const day = now.toLocaleDateString('en-GB', { weekday: 'long' });
  section('DATE');
  out.push(`local:    ${local} ${pad(now.getHours())}:${pad(now.getMinutes())} (${day})`);
  out.push(`utc:      ${now.toISOString().slice(0, 16).replace('T', ' ')}`);
  out.push(`note-id:  ${noteStamp(now)}   (session-note filename prefix)`);

  section('LOCATION');
  const root = resolveRoot();
  out.push(`cwd:       ${toPosix(process.cwd())}`);
  const top = git(['rev-parse', '--show-toplevel'], root);
  if (top === null) {
    out.push(`not inside a git repository (${toPosix(root)})`);
    return out.join('\n') + '\n';
  }
  out.push(`repo root: ${toPosix(top)}`);
  const gitDir = git(['rev-parse', '--absolute-git-dir'], root);
  const commonDir = git(['rev-parse', '--path-format=absolute', '--git-common-dir'], root);
  if (gitDir && commonDir && toPosix(gitDir) !== toPosix(commonDir)) {
    out.push(`worktree:  YES (linked worktree; main checkout: ${toPosix(dirname(commonDir))})`);
  } else {
    out.push('worktree:  no (this is the main checkout)');
  }

  section('BRANCH');
  out.push(`branch: ${git(['rev-parse', '--abbrev-ref', 'HEAD'], root) ?? 'unknown'}`);
  out.push(`head:   ${git(['log', '-1', '--format=%h %s'], root) ?? '(no commits)'}`);

  section('STATUS (git status --short)');
  const status = git(['status', '--short'], root) ?? '';
  if (status.trim() === '') {
    out.push('clean: no uncommitted changes');
  } else {
    const lines = status.split(/\r?\n/).filter(Boolean);
    out.push(`changed paths (${lines.length}):`, ...lines);
  }

  section('VS origin/main');
  if (git(['rev-parse', '--verify', '-q', 'origin/main'], root) === null) {
    out.push('origin/main ref not found');
  } else {
    const counts = parseAheadBehind(
      git(['rev-list', '--left-right', '--count', 'origin/main...HEAD'], root),
    );
    out.push(
      counts
        ? `ahead ${counts.ahead}, behind ${counts.behind} (vs local ref origin/main; no fetch)`
        : 'could not compute',
    );
  }

  section(`NORTH-STAR section 3 (${NORTH_STAR})`);
  const northStar = readNorthStar(top);
  const nowSection = northStar === null ? null : extractNowSection(northStar);
  if (northStar === null) {
    out.push('not found: cannot show current status');
  } else if (nowSection === null) {
    out.push('no "## 3" section found');
  } else {
    out.push(...nowSection, '');
    out.push(`(frontmatter last-updated: ${frontmatterValue(northStar, 'last-updated') ?? '?'})`);
  }

  const { notes } = readSessionsDir(top);

  section('RECENT SESSION NOTES (3 newest)');
  if (notes.length > 0) {
    for (const note of notes) out.push(`${SESSIONS_DIR}/${note.name}  ${note.title}`);
  } else {
    out.push('none found');
  }

  section('COMMITS SINCE origin/main (10 newest)');
  const commits = git(['log', '--format=%h %s', '-10', 'origin/main..HEAD'], root);
  out.push(commits === null ? 'unavailable' : commits.trim() === '' ? 'none' : commits);

  return out.join('\n') + '\n';
}

function main() {
  try {
    process.stdout.write(build());
  } catch {
    // never fail the caller over a context dump
  }
  process.exitCode = 0;
}

if (isEntryPoint(import.meta.url)) main();
