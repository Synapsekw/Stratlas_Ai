// Git hook guard (lefthook): nobody builds on main. Commits and merge commits on `main` and pushes
// to `main` are refused unless QUADRION_ORCHESTRATOR=1, which only the orchestrator session sets
// for its fast-forward and push (CLAUDE.md). Everyone else works on a branch in a worktree.
//
//   node tools/git/guard-main.mjs commit   (pre-commit, pre-merge-commit)
//   node tools/git/guard-main.mjs push     (pre-push; git passes the refs on stdin)
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const allowed = process.env.QUADRION_ORCHESTRATOR === '1';
const mode = process.argv[2];

const refuse = (what) => {
  console.error(
    `Refused: ${what}. Nobody builds on main: work on your own branch in your own worktree ` +
      '(git worktree add .claude/worktrees/<name> -b <type>/<name> main) and hand the branch to ' +
      'the orchestrator session, which merges into main (CLAUDE.md).',
  );
  process.exit(1);
};

if (!allowed && mode === 'commit') {
  const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' });
  if (branch.trim() === 'main') refuse('a commit on main');
}

if (!allowed && mode === 'push') {
  // Each stdin line: <local ref> <local sha> <remote ref> <remote sha>
  let input;
  try {
    input = readFileSync(0, 'utf8');
  } catch {
    input = '';
  }
  const toMain = input
    .split('\n')
    .map((line) => line.trim().split(/\s+/)[2])
    .some((remoteRef) => remoteRef === 'refs/heads/main');
  if (toMain) refuse('a push to main');
}
