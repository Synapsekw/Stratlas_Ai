/* eslint-disable no-console -- CLI output */
// Readies a worktree branch for the orchestrator, or cleans it up after it landed (CLAUDE.md, "The
// orchestrator merges, one branch at a time"). Sessions never merge into main themselves.
//
//   node tools/agent/finish-task.mjs [--docs] [--no-rebase]   (from inside your worktree)
//     1. refuses on main and in the main checkout
//     2. requires a clean, committed tree
//     3. rebases the branch onto the latest origin/main, so the checks see what will land
//     4. runs `pnpm check` (`pnpm format:check` with --docs) under a machine-wide lock
//     5. checks the commit messages for client and site names (check-public-text.mjs)
//     6. prints the hand-off message to SendMessage to the Orchestrator session
//
//   node tools/agent/finish-task.mjs --cleanup <branch>   (once the orchestrator confirms it landed)
//     removes the branch's worktree (with the Windows long-path fallback) and deletes the branch
//
// The lock: two worktrees running `pnpm check` at once starve each other of CPU and fail flakily, so
// rebase plus checks run one worktree at a time.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function parseArgs(argv) {
  const args = { docs: false, rebase: true, cleanup: '' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--docs') args.docs = true;
    else if (arg === '--no-rebase') args.rebase = false;
    else if (arg === '--cleanup') {
      args.cleanup = argv[i + 1] ?? '';
      i += 1;
      if (!args.cleanup) return { error: '--cleanup needs a branch name' };
    } else return { error: `unexpected argument '${arg}'` };
  }
  return args;
}

// Paths whose change means a contract change (CONTRIBUTING.md, "Contracts in @aio/schema are frozen").
export function contractWarning(changedFiles) {
  const schema = changedFiles.some((f) => f.startsWith('packages/schema/src/'));
  const logged = changedFiles.includes('docs/architecture/contract-changes.md');
  return schema && !logged
    ? 'packages/schema changed but docs/architecture/contract-changes.md did not: add a row if a contract changed.'
    : '';
}

export function handoffMessage({ branch, sha, subjects, checks, contract }) {
  const lines = [
    `Ready to merge: ${branch} at ${sha}.`,
    `Summary: <one line: what this branch does>`,
    `Commits (${subjects.length}): ${subjects.slice(0, 8).join('; ')}${subjects.length > 8 ? '; ...' : ''}`,
    `Checks: ${checks} green on the branch rebased onto origin/main.`,
    'E2E: <specs run CI-like (1100x720 at scale 1, WARP, demos built) and their result, or "none touched">',
    `Contract changes: ${contract ? 'yes, see docs/architecture/contract-changes.md' : 'none'}`,
    'Merge order: <none, or what must land first>',
  ];
  return lines.join('\n');
}

// Windows refuses paths over 260 characters unless they carry the \\?\ prefix.
export function longPath(path) {
  if (process.platform !== 'win32' || path.startsWith('\\\\?\\')) return path;
  return `\\\\?\\${resolve(path)}`;
}

const git = (args, opts = {}) =>
  String(
    execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }) ??
      '',
  ).trim();

const tryGit = (args, opts) => {
  try {
    return { ok: true, out: git(args, opts) };
  } catch (error) {
    return { ok: false, out: String(error.stderr ?? error.message ?? '') };
  }
};

// One command string through the shell: pnpm is pnpm.cmd on Windows, and the args are fixed here.
const pnpm = (args, cwd) =>
  spawnSync(`pnpm ${args.join(' ')}`, { cwd, stdio: 'inherit', shell: true }).status === 0;

const fail = (...lines) => {
  for (const line of lines) console.error(line);
  process.exit(1);
};

function mainCheckout() {
  return dirname(resolve(git(['rev-parse', '--path-format=absolute', '--git-common-dir'])));
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function acquireLock(lockDir) {
  const started = Date.now();
  let lastNote = 0;
  for (;;) {
    try {
      mkdirSync(lockDir);
      writeFileSync(join(lockDir, 'pid'), String(process.pid));
      return () => rmSync(lockDir, { recursive: true, force: true });
    } catch {
      const holder = Number(
        existsSync(join(lockDir, 'pid')) ? readFileSync(join(lockDir, 'pid'), 'utf8') : 0,
      );
      if (holder && !processAlive(holder)) {
        console.log(`   lock holder (pid ${holder}) is gone; taking the stale lock`);
        rmSync(lockDir, { recursive: true, force: true });
        continue;
      }
      const waited = Math.round((Date.now() - started) / 1000);
      if (waited > 1800) {
        fail(
          `error: waited 30 min for the check lock (pid ${holder || 'unknown'}).`,
          `       if no other finish-task is running, delete ${lockDir} and run again.`,
        );
      }
      if (waited - lastNote >= 30) {
        console.log(
          `   another worktree is running its checks (pid ${holder || '?'}); waiting (${waited}s)`,
        );
        lastNote = waited;
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

function removeWorktree(root, path) {
  if (tryGit(['-C', root, 'worktree', 'remove', path]).ok) return true;
  // "Filename too long" on deep node_modules: delete the folder with the long-path prefix, then prune.
  try {
    rmSync(longPath(path), { recursive: true, force: true, maxRetries: 3 });
  } catch (error) {
    console.error(`   could not delete ${path}: ${error.message}`);
  }
  tryGit(['-C', root, 'worktree', 'prune']);
  return !existsSync(path);
}

function cleanup(branch) {
  const root = mainCheckout();
  tryGit(['-C', root, 'fetch', 'origin', 'main']);
  if (!tryGit(['-C', root, 'merge-base', '--is-ancestor', branch, 'origin/main']).ok) {
    fail(
      `error: ${branch} is not in origin/main yet. Wait for the orchestrator to confirm it landed.`,
      '       (If the orchestrator rebased or squashed it, check by hand and use git branch -D.)',
    );
  }
  const list = git(['-C', root, 'worktree', 'list', '--porcelain']).split(/\r?\n\r?\n/);
  const entry = list.find((block) => block.includes(`branch refs/heads/${branch}`));
  if (entry) {
    const path = entry.split(/\r?\n/)[0].replace(/^worktree /, '');
    if (resolve(process.cwd()).startsWith(resolve(path))) {
      fail(`error: run --cleanup from outside ${path} (Windows cannot delete the current folder).`);
    }
    console.log(`-> removing worktree ${path}`);
    if (!removeWorktree(root, path)) fail(`error: ${path} is still there; delete it by hand.`);
  }
  console.log(`-> deleting branch ${branch}`);
  const del = tryGit(['-C', root, 'branch', '-d', branch]);
  if (!del.ok) fail(`error: ${del.out}`);
  console.log(`done: ${branch} cleaned up.`);
}

async function ready({ docs, rebase }) {
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  const top = git(['rev-parse', '--show-toplevel']);
  const root = mainCheckout();
  if (branch === 'main' || branch === 'HEAD')
    fail(`error: on '${branch}'; run this on your task branch.`);
  if (resolve(top) === resolve(root)) {
    fail('error: this is the main checkout. Work in your own worktree (CLAUDE.md).');
  }

  const dirty = git(['status', '--porcelain']);
  if (dirty) fail('error: uncommitted changes; commit them first.', dirty);

  const commonDir = resolve(git(['rev-parse', '--path-format=absolute', '--git-common-dir']));
  console.log('-> waiting for the machine-wide check lock');
  const release = await acquireLock(join(commonDir, 'finish-task-check.lock'));
  process.on('exit', release);

  if (rebase) {
    console.log('-> rebasing onto the latest origin/main');
    tryGit(['fetch', 'origin', 'main']);
    const before = git(['rev-parse', 'HEAD:pnpm-lock.yaml']);
    if (!tryGit(['rebase', 'origin/main']).ok) {
      const conflicts = tryGit(['diff', '--name-only', '--diff-filter=U'])
        .out.split(/\r?\n/)
        .join(' ');
      tryGit(['rebase', '--abort']);
      fail(
        `error: the rebase onto origin/main hit conflicts: ${conflicts || '(see git output)'}`,
        '       it was aborted; your branch is unchanged. Resolve with `git rebase origin/main`,',
        '       then run finish-task again.',
      );
    }
    if (git(['rev-parse', 'HEAD:pnpm-lock.yaml']) !== before) {
      console.log('-> the lockfile changed; reinstalling');
      if (!pnpm(['install', '--frozen-lockfile', '--prefer-offline'], top))
        fail('error: pnpm install failed.');
    }
  }

  const checks = docs ? 'pnpm format:check' : 'pnpm check';
  console.log(`-> running ${checks}`);
  if (!pnpm(docs ? ['format:check'] : ['check'], top)) {
    fail(`error: ${checks} is red. Fix it on the branch; never hand off a red branch.`);
  }

  const changed = git(['diff', '--name-only', 'origin/main...HEAD']).split(/\r?\n/).filter(Boolean);
  const subjects = git(['log', '--format=%s', 'origin/main..HEAD']).split(/\r?\n/).filter(Boolean);
  const warning = contractWarning(changed);
  if (warning) console.log(`\nWARNING: ${warning}`);

  const names = spawnSync(
    process.execPath,
    [join(top, 'tools', 'agent', 'check-public-text.mjs'), '--commits', 'origin/main..HEAD'],
    { cwd: top, stdio: 'inherit' },
  );
  if (names.status !== 0) {
    fail('error: a commit message names a client or site; reword it before handing off.');
  }

  console.log(
    '\nReady for the orchestrator. Fill in the <...> parts and SendMessage this to "Orchestrator":',
  );
  console.log('--------------------------------------------------------------------------------');
  console.log(
    handoffMessage({
      branch,
      sha: git(['rev-parse', '--short', 'HEAD']),
      subjects,
      checks,
      contract: changed.includes('docs/architecture/contract-changes.md'),
    }),
  );
  console.log('--------------------------------------------------------------------------------');
  console.log(
    'Before sending: no tester or person names in the commits either (no list catches those).',
  );
  console.log(
    `After it lands: node tools/agent/finish-task.mjs --cleanup ${branch}  (from the main checkout)`,
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.error) {
    fail(
      `error: ${args.error}`,
      'usage: node tools/agent/finish-task.mjs [--docs] [--no-rebase] | --cleanup <branch>',
    );
  }
  if (args.cleanup) cleanup(args.cleanup);
  else await ready(args);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
