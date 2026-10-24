// Git hook guard (lefthook): nobody builds on main. Commits and merge commits on `main` and pushes
// to `main` are refused unless QUADRION_ORCHESTRATOR=1, which only the merge coordinator sets, for
// one command at a time (CLAUDE.md, "Branches land in a local merge queue"). While a coordinator
// holds the merge lock, every push is refused without it: during a batch only the coordinator
// pushes. A fast-forward `git merge --ff-only` runs no hook; tools/agent/merge-guard-hook.mjs
// stops those in Claude sessions.
//
//   node tools/git/guard-main.mjs commit   (pre-commit, pre-merge-commit)
//   node tools/git/guard-main.mjs push     (pre-push; git passes the refs on stdin)
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { commonDirFor, coordinatorHint, readCoordinator } from '../agent/merge-coordinator.mjs';

/** The remote refs a pre-push stdin names (each line: <local ref> <local sha> <remote ref> <remote sha>). */
export function pushedRefs(input) {
  return String(input ?? '')
    .split('\n')
    .map((line) => line.trim().split(/\s+/)[2])
    .filter(Boolean);
}

/** Why a push is refused, or '' when it may go. */
export function pushRefusal({ input, allowed, coordinator }) {
  if (allowed) return '';
  const refs = pushedRefs(input);
  if (refs.includes('refs/heads/main')) return 'a push to main';
  if (coordinator && refs.length) return `a push (${refs.join(', ')}) while a merge batch is open`;
  return '';
}

export function refusalMessage(what, coordinator) {
  return (
    `Refused: ${what}. Nobody builds on main and only the merge coordinator pushes. Work on your ` +
    'own branch in your own worktree (node tools/agent/start-task.mjs <name>). ' +
    coordinatorHint(coordinator)
  );
}

function main() {
  const allowed = process.env.QUADRION_ORCHESTRATOR === '1';
  const mode = process.argv[2];
  if (allowed) return;
  const coordinator = readCoordinator(commonDirFor());
  const refuse = (what) => {
    console.error(refusalMessage(what, coordinator));
    process.exit(1);
  };

  if (mode === 'commit') {
    const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' });
    if (branch.trim() === 'main') refuse('a commit on main');
  }

  if (mode === 'push') {
    let input;
    try {
      input = readFileSync(0, 'utf8');
    } catch {
      input = '';
    }
    const what = pushRefusal({ input, allowed, coordinator });
    if (what) refuse(what);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
