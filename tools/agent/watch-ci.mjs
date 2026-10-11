/* eslint-disable no-console -- CLI output */
// One bounded CI poller for the orchestrator, instead of ad-hoc `gh run watch` loops. Prints a line
// only when the state changes, plus a heartbeat every fifth poll, and tolerates gh hiccups and a run
// that does not exist yet. Safe to run as one background task.
//
//   node tools/agent/watch-ci.mjs branch <branch> [--max-seconds 1800] [--interval 30]
//   node tools/agent/watch-ci.mjs pr <number>     [--max-seconds 1800] [--interval 30]
//
// Exit codes: 0 green, 1 failed, 2 timed out, 3 usage error or no run found.
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export function parseArgs(argv) {
  const [mode, target, ...rest] = argv;
  if (!['branch', 'pr'].includes(mode) || !target) return { error: 'usage' };
  if (mode === 'pr' && !/^\d+$/.test(target)) return { error: 'a pr target must be a PR number' };
  const args = { mode, target, maxSeconds: 1800, interval: 30 };
  for (let i = 0; i < rest.length; i += 2) {
    const value = Number(rest[i + 1]);
    if (!Number.isInteger(value) || value < 1) return { error: `bad value for ${rest[i]}` };
    if (rest[i] === '--max-seconds') args.maxSeconds = value;
    else if (rest[i] === '--interval') args.interval = value;
    else return { error: `unexpected argument '${rest[i]}'` };
  }
  return args;
}

// gh pr checks buckets: pass | fail | pending | skipping | cancel.
export function summariseChecks(checks) {
  const count = (...buckets) => checks.filter((c) => buckets.includes(c.bucket)).length;
  const bad = count('fail', 'cancel');
  const pending = count('pending');
  const state =
    bad > 0 ? 'failed' : checks.length === 0 ? 'none' : pending > 0 ? 'pending' : 'green';
  return {
    state,
    pass: count('pass'),
    bad,
    pending,
    skip: count('skipping'),
    total: checks.length,
  };
}

// `gh pr checks` exits non-zero while checks are pending or failed, but still prints the JSON.
const gh = (args) => {
  let out;
  try {
    out = execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (error) {
    out = error.stdout;
  }
  try {
    return JSON.parse(out);
  } catch {
    return undefined;
  }
};

const sleep = (s) => new Promise((r) => setTimeout(r, s * 1000));

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.error) {
    console.error(`error: ${args.error}`);
    console.error(
      'usage: node tools/agent/watch-ci.mjs (branch <branch> | pr <number>) [--max-seconds N] [--interval N]',
    );
    process.exit(3);
  }
  const { mode, target, maxSeconds, interval } = args;
  const start = Date.now();
  const elapsed = () => Math.round((Date.now() - start) / 1000);
  const tag = () => `[watch-ci ${mode}:${target} +${elapsed()}s]`;
  const grace = Math.min(120, maxSeconds);
  let last = '';
  let poll = 0;
  const note = (state) => {
    if (state !== last) console.log(`${tag()} ${state}`);
    else if (poll % 5 === 0) console.log(`${tag()} still: ${state}`);
    last = state;
  };
  const timedOut = () => {
    if (elapsed() < maxSeconds) return;
    console.log(`${tag()} TIMED OUT; last state: ${last || 'unknown'}`);
    process.exit(2);
  };

  if (mode === 'branch') {
    let run;
    while (!run) {
      run = gh([
        'run',
        'list',
        '--branch',
        target,
        '--limit',
        '1',
        '--json',
        'databaseId,url,workflowName',
      ])?.[0];
      if (run) break;
      if (elapsed() >= grace) {
        console.error(
          `error: no workflow run for '${target}' after ${grace}s (gh run list --branch ${target}).`,
        );
        process.exit(3);
      }
      await sleep(interval);
    }
    console.log(`${tag()} watching run ${run.databaseId} (${run.workflowName}) ${run.url}`);
    for (;;) {
      timedOut();
      poll += 1;
      const view = gh(['run', 'view', String(run.databaseId), '--json', 'status,conclusion']);
      if (!view) note('gh poll failed; retrying');
      else if (view.status === 'completed') {
        const ok = view.conclusion === 'success';
        console.log(`${tag()} ${ok ? 'SUCCESS' : `FAILED (${view.conclusion})`} ${run.url}`);
        process.exit(ok ? 0 : 1);
      } else note(`status=${view.status}`);
      await sleep(interval);
    }
  }

  for (;;) {
    timedOut();
    poll += 1;
    const checks = gh(['pr', 'checks', target, '--json', 'name,bucket,link']);
    if (!checks) note('gh poll failed or no checks yet; retrying');
    else {
      const s = summariseChecks(checks);
      if (s.state === 'failed') {
        console.log(`${tag()} FAILED: ${s.bad} check(s) failed or cancelled`);
        for (const c of checks.filter((c) => c.bucket === 'fail' || c.bucket === 'cancel')) {
          console.log(`  - ${c.name} [${c.bucket}] ${c.link}`);
        }
        process.exit(1);
      }
      if (s.state === 'green') {
        console.log(`${tag()} ALL GREEN: pass ${s.pass}, skipped ${s.skip}`);
        process.exit(0);
      }
      if (s.state === 'none' && elapsed() >= grace) {
        console.error(`error: PR #${target} has no checks after ${grace}s.`);
        process.exit(3);
      }
      note(`pass ${s.pass}, pending ${s.pending}, skipped ${s.skip}`);
    }
    await sleep(interval);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
