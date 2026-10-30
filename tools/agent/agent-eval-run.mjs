#!/usr/bin/env node
/**
 * `pnpm eval:agent`: build the app, then run the agent eval (apps/desktop/e2e/agent-eval.spec.ts)
 * one test at a time, with one run id for the whole run so every suite writes into one folder of
 * `.agent-eval/`. Extra arguments go to Playwright (for example `--grep quarry`).
 *
 * It refuses to start without QUADRION_EVAL_PROFILE (anthropic, local or scripted): a key left in
 * the shell must never start a paid run by itself. The spec header lists the other variables.
 */
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const PROFILES = ['anthropic', 'local', 'scripted'];

/** Null when the environment can start a run, else why not. */
export function refusal(env) {
  const profile = (env.QUADRION_EVAL_PROFILE ?? '').trim().toLowerCase();
  if (!profile)
    return 'Set QUADRION_EVAL_PROFILE to anthropic, local or scripted first. A key alone starts nothing: the anthropic and local profiles call a real model and the first spends tokens.';
  if (!PROFILES.includes(profile))
    return `QUADRION_EVAL_PROFILE is "${profile}": use anthropic, local or scripted.`;
  return null;
}

/** One id per run: the folder the run's traces go to. */
export const runId = (now = new Date()) => now.toISOString().replace(/[:.]/g, '-').slice(0, 19);

function main() {
  const why = refusal(process.env);
  if (why) {
    process.stderr.write(`agent eval: ${why}\n`);
    process.exit(2);
  }
  const env = { ...process.env, QUADRION_EVAL_RUN_ID: process.env.QUADRION_EVAL_RUN_ID || runId() };
  const run = (args) => {
    const r = spawnSync('pnpm', args, {
      stdio: 'inherit',
      env,
      shell: process.platform === 'win32',
    });
    if (r.status !== 0) process.exit(r.status ?? 1);
  };
  run(['build']);
  run([
    '-F',
    '@aio/desktop',
    'exec',
    'playwright',
    'test',
    'e2e/agent-eval.spec.ts',
    '--workers=1',
    ...process.argv.slice(2),
  ]);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
