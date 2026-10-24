// Claude Code PreToolUse hook (Bash and PowerShell): only the merge coordinator lands work
// (CLAUDE.md, "Branches land in a local merge queue, one push per batch"). Git hooks cannot see a
// fast-forward merge, and a session should hear what to do before git refuses, so this hook stops
// a shell command that would:
//   - push (`git push`, `git -C <dir> push`, in any form),
//   - open, ready or merge a pull request (`gh pr create|ready|merge`, `gh api .../merges` or
//     `.../pulls/<n>/merge`),
//   - move main: `git update-ref refs/heads/main`, `git branch -f main`, `git fetch . x:main`
//     (refs are shared, so from any worktree), or `git merge`, `git pull`, `git reset --hard` run
//     in the main checkout: the hook cwd is the main checkout on main, or the command changes into
//     it (`cd`, `Set-Location`, `pushd`, `git -C`) and does not change on into a worktree.
// It lets the command through when it carries the coordinator marker (`QUADRION_ORCHESTRATOR=1`,
// or `$env:QUADRION_ORCHESTRATOR='1'`) and the merge lock exists.
//
// The heuristic is deliberately simple. The command is split into simple commands on ; && || | &
// ( ) and newlines outside quotes, quoted text stays inside its word (so `git commit -m "... git
// push ..."` is one commit), and heredoc / here-string bodies are dropped. Commands hidden in
// scripts, aliases or `bash -c "..."` strings get through: false negatives are acceptable, blocking
// ordinary branch work is not.
//
// Denies print the PreToolUse JSON on stdout and exit 0. Any internal error allows the command.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, posix } from 'node:path';
import { pathToFileURL } from 'node:url';
import { commonDirFor, coordinatorHint, readCoordinator } from './merge-coordinator.mjs';

/** Drops bash heredoc bodies and PowerShell here-string bodies. */
export function stripHeredocs(command) {
  let text = String(command ?? '').replace(/\r\n/g, '\n');
  // PowerShell here-strings: @' ... '@ and @" ... "@ (the closer starts its line).
  text = text.replace(/@(['"])\n[\s\S]*?\n\1@/g, "''");
  // Bash heredocs: <<EOF, <<-EOF, <<'EOF', <<"EOF" ... a line holding only the word.
  const lines = text.split('\n');
  const out = [];
  let terminators = [];
  for (const line of lines) {
    if (terminators.length) {
      const [word, dash] = terminators[0];
      if ((dash ? line.replace(/^\t+/, '') : line).trim() === word) terminators.shift();
      continue;
    }
    out.push(line);
    for (const m of line.matchAll(/<<(-?)\s*(['"]?)([A-Za-z_][\w-]*)\2/g))
      terminators.push([m[3], m[1] === '-']);
  }
  return out.join('\n');
}

/**
 * Splits a command line into simple commands, each a list of unquoted words. Quoted text stays in
 * its word; separators outside quotes end the command.
 */
export function splitCommands(command) {
  const text = stripHeredocs(command);
  const commands = [];
  let words = [];
  let word = '';
  let inWord = false;
  const endWord = () => {
    if (inWord) words.push(word);
    word = '';
    inWord = false;
  };
  const endCommand = () => {
    endWord();
    if (words.length) commands.push(words);
    words = [];
  };
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (c === "'") {
      inWord = true;
      // Bash: no escapes. PowerShell: '' is a literal quote.
      for (i += 1; i < text.length; i += 1) {
        if (text[i] === "'") {
          if (text[i + 1] === "'") {
            word += "'";
            i += 1;
          } else break;
        } else word += text[i];
      }
    } else if (c === '"') {
      inWord = true;
      for (i += 1; i < text.length; i += 1) {
        const d = text[i];
        if (d === '"') break;
        if ((d === '\\' || d === '`') && /["\\$`]/.test(text[i + 1] ?? '')) {
          word += text[i + 1];
          i += 1;
        } else word += d;
      }
    } else if (c === '\\' && /[\s"'\\]/.test(text[i + 1] ?? '') && text[i + 1] !== '\n') {
      inWord = true;
      word += text[i + 1];
      i += 1;
    } else if (c === '\\' && text[i + 1] === '\n') {
      i += 1; // line continuation
    } else if (c === '`' && text[i + 1] === '\n') {
      i += 1; // PowerShell line continuation
    } else if (/[;&|\n(){}]/.test(c)) {
      endCommand();
    } else if (c === '$' && text[i + 1] === '(') {
      endCommand();
      i += 1;
    } else if (/\s/.test(c)) {
      endWord();
    } else {
      inWord = true;
      word += c;
    }
  }
  endCommand();
  return commands;
}

const MARKER =
  /(?:^|[\s;&|(])(?:export\s+|set\s+)?(?:\$env:)?QUADRION_ORCHESTRATOR\s*=\s*(['"]?)1\1(?=$|[\s;&|)])/i;

/** True when the command lifts the guard with QUADRION_ORCHESTRATOR=1 (bash or PowerShell). */
export function hasMarker(command) {
  return MARKER.test(stripHeredocs(command));
}

/** Lower-case forward-slash path; `/e/x` and `/mnt/e/x` become `e:/x`. */
export function normalizePath(path) {
  let p = String(path ?? '')
    .trim()
    .replace(/\\/g, '/');
  const msys = /^\/(?:mnt\/)?([a-z])(\/|$)/i.exec(p);
  if (msys) p = `${msys[1]}:/${p.slice(msys[0].length)}`;
  p = p.toLowerCase().replace(/\/+/g, '/');
  if (/^[a-z]:$/.test(p)) p += '/';
  p = posix.normalize(p);
  return p.length > 3 && p.endsWith('/') ? p.slice(0, -1) : p;
}

const isAbsolute = (p) => /^[a-z]:\//.test(p) || p.startsWith('/');

/** Resolves a cd / -C argument against the current directory (both normalized). */
export function resolveDir(base, arg) {
  const target = normalizePath(arg);
  if (!target || target.startsWith('~') || target.startsWith('$')) return null;
  return isAbsolute(target) ? target : normalizePath(posix.join(base, target));
}

/** True when dir is the main checkout or a folder in it, but not a linked worktree under it. */
export function inMainCheckout(dir, mainRoot) {
  if (!dir || !mainRoot) return false;
  const root = normalizePath(mainRoot);
  const d = normalizePath(dir);
  if (d === root) return true;
  if (!d.startsWith(`${root}/`)) return false;
  return !d.startsWith(`${root}/.claude/worktrees/`);
}

const base = (word) =>
  String(word ?? '')
    .replace(/\\/g, '/')
    .split('/')
    .pop()
    .toLowerCase()
    .replace(/\.exe$/, '');

const CD = new Set(['cd', 'set-location', 'sl', 'chdir', 'pushd', 'push-location']);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const GIT_OPTS_WITH_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace']);
const MAIN_REF = /^(?:\+?(?:refs\/heads\/)?main|.*:(?:refs\/heads\/)?main)$/;

/** The violation in one git command, or ''. `where` is the directory the command runs in. */
function gitViolation(words, where, whereInMain, mainRoot) {
  let i = 1;
  let dir = where;
  while (i < words.length && words[i].startsWith('-')) {
    const opt = words[i];
    if (opt === '-C') {
      dir = resolveDir(dir ?? '', words[i + 1] ?? '') ?? dir;
      i += 2;
    } else if (GIT_OPTS_WITH_VALUE.has(opt)) i += 2;
    else i += 1;
  }
  const sub = words[i];
  const args = words.slice(i + 1);
  const mainHere = dir === where ? whereInMain : inMainCheckout(dir, mainRoot);
  switch (sub) {
    case 'push':
      return 'a git push';
    case 'update-ref':
      return args.some((a) => a === 'refs/heads/main') ? 'moving main with git update-ref' : '';
    case 'branch': {
      // `git branch -f main <start>` resets main; `git branch -M <old> main` renames onto it.
      const positional = args.filter((a) => !a.startsWith('-'));
      const force = args.some((a) => /^(-f|--force|-[a-z]*f[a-z]*)$/.test(a));
      const rename = args.some((a) => /^(-M|-m|-C|-c|--move|--copy)$/.test(a));
      const hit = (force && positional[0] === 'main') || (rename && positional.at(-1) === 'main');
      return hit ? 'moving main with git branch -f' : '';
    }
    case 'fetch':
      return args.some((a) => a.includes(':') && MAIN_REF.test(a))
        ? 'moving main with git fetch'
        : '';
    case 'merge':
      if (args.some((a) => a === '--abort' || a === '--quit')) return '';
      return mainHere ? 'a git merge into main' : '';
    case 'pull':
      return mainHere ? 'a git pull into main' : '';
    case 'reset':
      return mainHere && args.includes('--hard') ? 'a git reset --hard of main' : '';
    default:
      return '';
  }
}

function ghViolation(words) {
  let i = 1;
  while (i < words.length && words[i].startsWith('-')) i += words[i] === '-R' ? 2 : 1;
  const [group, action] = words.slice(i, i + 2);
  if (group === 'pr' && ['create', 'merge', 'ready', 'new'].includes(action))
    return `gh pr ${action}`;
  if (group === 'api') {
    const hit = words
      .slice(i + 1)
      .some((w) => /\/merges(?:$|[?/])/.test(w) || /\/pulls\/\d+\/merge(?:$|[?/])/.test(w));
    return hit ? 'a merge through gh api' : '';
  }
  return '';
}

/**
 * The guard decision for one shell command.
 *   command        the shell command text
 *   cwd            the directory it runs in
 *   mainRoot       the main checkout (the git common dir's parent)
 *   currentBranch  the branch checked out in cwd
 *   coordinator    readCoordinator(...) result, or null without a lock
 * Returns null to allow, or { reason, message } to deny.
 */
export function decide({ command, cwd, mainRoot, currentBranch, coordinator }) {
  const commands = splitCommands(command);
  const startDir = normalizePath(cwd ?? '');
  const startInMain = currentBranch === 'main' && inMainCheckout(startDir, mainRoot);
  let dir = startDir;
  let dirInMain = startInMain;
  const found = [];
  for (const raw of commands) {
    let words = raw;
    // PowerShell's call operator and env-style prefixes.
    while (words.length && (words[0] === '&' || ASSIGNMENT.test(words[0]))) words = words.slice(1);
    if (['env', 'command', 'exec', 'sudo'].includes(base(words[0]))) {
      words = words.slice(1);
      while (words.length && ASSIGNMENT.test(words[0])) words = words.slice(1);
    }
    if (!words.length) continue;
    const head = base(words[0]);
    if (CD.has(head)) {
      const target = words.slice(1).find((w) => !w.startsWith('-'));
      const next = target ? resolveDir(dir, target) : null;
      if (next) {
        dir = next;
        dirInMain = inMainCheckout(dir, mainRoot);
      }
      continue;
    }
    if (head === 'git') {
      const what = gitViolation(words, dir, dirInMain, mainRoot);
      if (what) found.push(what);
    } else if (head === 'gh') {
      const what = ghViolation(words);
      if (what) found.push(what);
    }
  }
  if (!found.length) return null;

  const what = [...new Set(found)].join(', ');
  const marked = hasMarker(command);
  if (marked && coordinator) return null;
  if (marked) {
    return {
      reason:
        `Stopped: ${what}. QUADRION_ORCHESTRATOR=1 lifts the guard only for the merge ` +
        'coordinator, and no merge lock exists. Run /coordinate first, in the main checkout, ' +
        'to become the coordinator. If you are not meant to coordinate, stop and tell the user.',
      message: `Merge guard: blocked ${what}. No coordinator lock: run /coordinate first.`,
    };
  }
  if (coordinator) {
    return {
      reason:
        `Stopped: ${what}. Only the merge coordinator pushes, opens pull requests or moves ` +
        `main. ${coordinatorHint(coordinator)} Do not retry this command or work around the ` +
        `guard. Stop and tell the user: this branch goes to the merge coordinator ` +
        `${coordinator.name}; you will hand it over with SendMessage to ${coordinator.name} ` +
        '(branch, head SHA, checks, e2e results, How to test).',
      message: `Merge guard: blocked ${what}. Hand the branch to the coordinator ${coordinator.name}.`,
    };
  }
  return {
    reason:
      `Stopped: ${what}. Only the merge coordinator pushes, opens pull requests or moves main. ` +
      `${coordinatorHint(null)} Do not retry this command or work around the guard. Stop and ` +
      'ask the user to launch a coordinator: start a Claude session in the main checkout and ' +
      'run /coordinate. Then hand your branch to it with SendMessage.',
    message: `Merge guard: blocked ${what}. No coordinator running: start one with /coordinate in the main checkout.`,
  };
}

const QUICK = /\b(?:git|gh)(?:\.exe)?\b/i;

function gitOut(args, cwd) {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
      windowsHide: true,
    }).trim();
  } catch {
    return '';
  }
}

/** Runs the hook on one payload; returns the stdout text ('' to allow). */
export function runHook(payload) {
  const tool = payload?.tool_name;
  if (tool !== 'Bash' && tool !== 'PowerShell') return '';
  const command = payload?.tool_input?.command;
  if (typeof command !== 'string' || !QUICK.test(command)) return '';
  const cwd = payload?.cwd || process.cwd();
  const commonDir = commonDirFor(cwd);
  const mainRoot = commonDir ? dirname(commonDir) : '';
  const currentBranch = gitOut(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
  const coordinator = readCoordinator(commonDir);
  const verdict = decide({ command, cwd, mainRoot, currentBranch, coordinator });
  if (!verdict) return '';
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: verdict.reason,
    },
    systemMessage: verdict.message,
  });
}

function main() {
  try {
    const payload = JSON.parse(readFileSync(0, 'utf8') || '{}');
    const out = runHook(payload);
    if (out) process.stdout.write(`${out}\n`);
  } catch {
    // never break a session over the guard
  }
  process.exitCode = 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
