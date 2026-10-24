/* eslint-disable no-console -- CLI output */
// The merge coordinator (CLAUDE.md, "Branches land in a local merge queue, one push per batch").
// One session holds the merge lock `<git-common-dir>/quadrion-merge-lock` for a whole batch; its
// `owner` file (lines `session: <name>`, `branch: ...`, `time: ...`, `note: ...`) names it. Every
// other session hands its branch to that session and never pushes, opens a pull request or touches
// `main`. The guards (tools/git/guard-main.mjs, tools/agent/merge-guard-hook.mjs) read the same lock.
//
//   node tools/agent/merge-coordinator.mjs status               who coordinates, and what to do
//   node tools/agent/merge-coordinator.mjs take --name <session> become the coordinator (/coordinate)
//   node tools/agent/merge-coordinator.mjs land <branch>        fast-forward main to a handed-over
//                                                               branch (main checkout, on main)
//   node tools/agent/merge-coordinator.mjs release [--yes]      remove the lock after the batch push
//
// The pure helpers are exported for the guards, finish-task, session-context and the tests.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const LOCK_NAME = 'quadrion-merge-lock';
export const COORDINATE_HELP =
  'start a Claude session in the main checkout and run /coordinate; then hand your branch to it';

/** The lock folder for a git common dir. */
export const lockDir = (commonDir) => join(commonDir, LOCK_NAME);

/** `{ name, since, raw }` from the owner file's text. The name drops a trailing "(...)" remark. */
export function parseOwner(text) {
  const raw = String(text ?? '');
  const field = (key) =>
    new RegExp(`^\\s*${key}\\s*:\\s*(.*?)\\s*$`, 'im').exec(raw)?.[1]?.trim() ?? '';
  const name = field('session').replace(/\s*\(.*\)\s*$/, '') || 'unknown';
  return { name, since: field('time') || 'unknown', raw };
}

/**
 * The coordinator from `<commonDir>/quadrion-merge-lock/owner`, or null when there is no lock.
 * A lock folder without an owner file still counts: someone is mid-take or the lock is stale.
 */
export function readCoordinator(commonDir) {
  if (!commonDir) return null;
  const dir = lockDir(commonDir);
  if (!existsSync(dir)) return null;
  try {
    return parseOwner(readFileSync(join(dir, 'owner'), 'utf8'));
  } catch {
    return { name: 'unknown', since: 'unknown', raw: '' };
  }
}

/** One paragraph of user-facing guidance for a session that wants to land work. */
export function coordinatorHint(coordinator) {
  if (coordinator) {
    const { name, since } = coordinator;
    return (
      `Merges go through the merge coordinator session ${name} (since ${since}). ` +
      'Commit on your branch, rebase onto the local main (`git rebase main`), ' +
      `run \`node tools/agent/finish-task.mjs\`, then SendMessage ${name} the hand-off. ` +
      'Do not push or open pull requests.'
    );
  }
  return (
    'No merge coordinator session is running. Tell the user: to land work, start a Claude ' +
    'session in the main checkout and run /coordinate; then hand your branch to it.'
  );
}

/** The SessionStart line. */
export function coordinatorLine(coordinator) {
  return coordinator
    ? `Merge coordinator: ${coordinator.name} since ${coordinator.since}`
    : 'Merge coordinator: none running (start one with /coordinate in the main checkout)';
}

/** Local time with its UTC offset, e.g. 2026-10-24T12:06:09+04:00. */
export function localStamp(date = new Date()) {
  const pad = (n) => String(Math.trunc(Math.abs(n))).padStart(2, '0');
  const off = -date.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `${sign}${pad(off / 60)}:${pad(off % 60)}`
  );
}

export function ownerText({ name, time }) {
  return [
    `session: ${name} (merge coordinator)`,
    'branch: local main (no push until the founder has tested)',
    `time: ${time}`,
    `note: all merges go through ${name}, local only; do not push or open pull requests`,
    '',
  ].join('\n');
}

/**
 * Takes the lock: the owner file is written only when this mkdir created the folder, so two
 * sessions racing for it cannot both win. Returns `{ ok, coordinator }`.
 */
export function takeLock(commonDir, name, time = localStamp()) {
  const dir = lockDir(commonDir);
  try {
    mkdirSync(dir);
  } catch (error) {
    if (error?.code === 'EEXIST') return { ok: false, coordinator: readCoordinator(commonDir) };
    throw error;
  }
  writeFileSync(join(dir, 'owner'), ownerText({ name, time }));
  return { ok: true, coordinator: readCoordinator(commonDir) };
}

export function releaseLock(commonDir) {
  rmSync(lockDir(commonDir), { recursive: true, force: true });
}

export function parseArgs(argv) {
  const [command, ...rest] = argv;
  const args = { command: command ?? 'status', name: '', branch: '', yes: false };
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === '--name') {
      args.name = rest[i + 1] ?? '';
      i += 1;
    } else if (arg === '--yes') args.yes = true;
    else if (!arg.startsWith('-') && !args.branch) args.branch = arg;
    else return { error: `unexpected argument '${arg}'` };
  }
  if (!['status', 'take', 'land', 'release'].includes(args.command))
    return { error: `unknown command '${args.command}'` };
  if (args.command === 'take' && !args.name) return { error: 'take needs --name <session-name>' };
  if (args.command === 'land' && !args.branch) return { error: 'land needs a branch' };
  return args;
}

const git = (args, opts = {}) =>
  String(
    execFileSync('git', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      ...opts,
    }) ?? '',
  ).trim();

const tryGit = (args, opts = {}) => {
  try {
    return { ok: true, out: git(args, opts) };
  } catch (error) {
    return { ok: false, out: String(error.stderr ?? error.message ?? '').trim() };
  }
};

/** The absolute git common dir for cwd, or null outside a repository. */
export function commonDirFor(cwd = process.cwd()) {
  const result = tryGit(['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd });
  return result.ok && result.out ? resolve(cwd, result.out) : null;
}

const fail = (...lines) => {
  for (const line of lines) console.error(line);
  process.exit(1);
};

function land(branch, commonDir) {
  const root = dirname(commonDir);
  const top = tryGit(['rev-parse', '--show-toplevel']).out;
  if (!top || resolve(top).toLowerCase() !== resolve(root).toLowerCase())
    fail(`error: run land from the main checkout (${root}).`);
  const head = tryGit(['rev-parse', '--abbrev-ref', 'HEAD']).out;
  if (head !== 'main') fail(`error: the main checkout is on '${head}', not main.`);
  const coordinator = readCoordinator(commonDir);
  if (!coordinator)
    fail('error: no merge lock. Run /coordinate (merge-coordinator.mjs take) first.');
  if (tryGit(['status', '--porcelain', '--untracked-files=no']).out)
    fail('error: the main checkout has uncommitted changes; tell the founder, do not land.');
  if (!tryGit(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]).ok)
    fail(`error: no local branch '${branch}'.`);
  if (!tryGit(['merge-base', '--is-ancestor', 'main', branch]).ok)
    fail(
      `error: ${branch} does not sit on top of the local main.`,
      `       Ask its session to run \`git rebase main\` and send the new SHA.`,
    );

  const docs = git([
    'diff',
    '--name-only',
    '--diff-filter=ACMR',
    `main..${branch}`,
    '--',
    'docs',
    'CLAUDE.md',
  ])
    .split(/\r?\n/)
    .filter(Boolean);
  if (docs.length) {
    // The files are not on main yet: copy the branch's versions into a temp folder and check those.
    const temp = mkdtempSync(join(tmpdir(), 'quadrion-land-'));
    try {
      const files = docs.map((path) => {
        const target = join(temp, path);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, git(['show', `${branch}:${path}`]));
        return target;
      });
      const checker = join(dirname(fileURLToPath(import.meta.url)), 'check-public-text.mjs');
      const names = spawnSync(process.execPath, [checker, ...files], { stdio: 'inherit' });
      if (names.status !== 0)
        fail(`error: ${branch} names a client or site in its docs; send it back to its session.`);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  } else console.log('-> no docs changed on the branch');

  const merge = spawnSync('git', ['merge', '--ff-only', branch], {
    stdio: 'inherit',
    env: { ...process.env, QUADRION_ORCHESTRATOR: '1' },
  });
  if (merge.status !== 0) fail(`error: git merge --ff-only ${branch} failed.`);
  const sha = git(['rev-parse', '--short', 'HEAD']);
  console.log(`\nLanded ${branch}: main is now ${sha}.`);
  console.log('Announce to every session (SendMessage):');
  console.log(
    `  main moved to ${sha} (${branch} landed). Rebase onto the local main (git rebase main); ` +
      'if your branch is queued, send the new SHA.',
  );
}

function release(commonDir, yes) {
  const coordinator = readCoordinator(commonDir);
  if (!coordinator) {
    console.log('No merge lock to release.');
    return;
  }
  const count = tryGit(['rev-list', '--count', 'origin/main..main']);
  const ahead = count.ok ? count.out : '';
  if (!yes) {
    console.log(`The merge lock is held by ${coordinator.name} (since ${coordinator.since}).`);
    if (ahead && ahead !== '0')
      console.log(`WARNING: local main is ${ahead} commit(s) ahead of origin/main (not pushed).`);
    fail('Run again with --yes to remove it.');
  }
  releaseLock(commonDir);
  console.log(`Released the merge lock (was ${coordinator.name}).`);
  if (ahead && ahead !== '0')
    console.log(`Note: local main is ${ahead} commit(s) ahead of origin/main (not pushed).`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.error)
    fail(
      `error: ${args.error}`,
      'usage: node tools/agent/merge-coordinator.mjs status | take --name <session> | land <branch> | release [--yes]',
    );
  const commonDir = commonDirFor();
  if (!commonDir) fail('error: not inside a git repository.');

  if (args.command === 'status') {
    const coordinator = readCoordinator(commonDir);
    console.log(coordinatorLine(coordinator));
    console.log(coordinatorHint(coordinator));
  } else if (args.command === 'take') {
    const { ok, coordinator } = takeLock(commonDir, args.name);
    if (!ok)
      fail(
        `The merge lock is already held by ${coordinator?.name ?? 'unknown'} (since ${coordinator?.since ?? 'unknown'}).`,
        `Lock: ${lockDir(commonDir)}`,
      );
    console.log(`${args.name} is now the merge coordinator (lock: ${lockDir(commonDir)}).`);
  } else if (args.command === 'land') land(args.branch, commonDir);
  else release(commonDir, args.yes);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
