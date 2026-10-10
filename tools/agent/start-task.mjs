/* eslint-disable no-console -- CLI output */
// Starts a building session in its own worktree so parallel sessions never share files (CLAUDE.md,
// "Nobody builds on main"). Cuts `<type>/<name>` off the latest origin/main into the nested folder
// `.claude/worktrees/<name>` and installs dependencies there (the commit hooks and `pnpm check` need
// the worktree's own node_modules/.bin).
//
//   node tools/agent/start-task.mjs <name> [--type feat|fix|chore|docs|test|refactor|perf|ci]
//
// Nested, not a sibling folder: a worktree inside the project is inside the subagent sandbox, so a
// session that re-roots with EnterWorktree({ path: '.claude/worktrees/<name>' }) can hand work to
// subagents. Finish with `node tools/agent/finish-task.mjs`, which readies the branch for the
// orchestrator.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const BRANCH_TYPES = ['feat', 'fix', 'chore', 'docs', 'test', 'refactor', 'perf', 'ci'];

export function parseArgs(argv) {
  const args = { name: '', type: 'feat' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--type') {
      args.type = argv[i + 1] ?? '';
      i += 1;
    } else if (!args.name) {
      args.name = arg;
    } else {
      return { error: `unexpected argument '${arg}'` };
    }
  }
  if (!args.name) return { error: 'missing <name>' };
  if (!/^[a-z0-9][a-z0-9-]*$/.test(args.name)) {
    return { error: `<name> must be kebab-case (a-z, 0-9, -), got '${args.name}'` };
  }
  if (!BRANCH_TYPES.includes(args.type)) {
    return { error: `--type must be one of ${BRANCH_TYPES.join(', ')}, got '${args.type}'` };
  }
  return { name: args.name, type: args.type, branch: `${args.type}/${args.name}` };
}

const git = (args, opts = {}) =>
  String(
    execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }) ??
      '',
  ).trim();

export function mainCheckout() {
  return dirname(resolve(git(['rev-parse', '--path-format=absolute', '--git-common-dir'])));
}

function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.error) {
    console.error(`error: ${parsed.error}`);
    console.error('usage: node tools/agent/start-task.mjs <name> [--type feat|fix|chore|docs|...]');
    process.exit(1);
  }
  const { name, branch } = parsed;
  const root = mainCheckout();
  const wt = join(root, '.claude', 'worktrees', name);

  try {
    git(['-C', root, 'show-ref', '--verify', '--quiet', `refs/heads/${branch}`]);
    console.error(`error: branch ${branch} already exists; pick another name or finish that task.`);
    process.exit(1);
  } catch {
    // The branch does not exist yet, as wanted.
  }
  if (existsSync(wt)) {
    console.error(`error: folder ${wt} already exists.`);
    process.exit(1);
  }

  console.log('-> fetching the latest main');
  try {
    git(['-C', root, 'fetch', 'origin', 'main']);
  } catch {
    console.log('   fetch failed (offline?); cutting from the last known origin/main');
  }

  console.log(`-> creating worktree ${wt} on ${branch}`);
  git(['-C', root, 'worktree', 'add', '--no-track', '-b', branch, wt, 'origin/main'], {
    stdio: 'inherit',
  });

  console.log('-> installing dependencies in the worktree');
  const install = spawnSync('pnpm', ['install', '--frozen-lockfile', '--prefer-offline'], {
    cwd: wt,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (install.status !== 0) {
    console.error('error: pnpm install failed in the worktree; fix it before building.');
    process.exit(1);
  }

  console.log('');
  console.log(`ready: ${branch} in ${wt}`);
  console.log(
    `  agent: EnterWorktree({ path: ".claude/worktrees/${name}" }) to re-root the session`,
  );
  console.log('  done:  node tools/agent/finish-task.mjs   (from inside the worktree)');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
