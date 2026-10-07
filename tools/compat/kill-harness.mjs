// Kill-during-write harness (1.0 checklist, stability): start a writer process that writes in a
// loop, kill it hard at a random moment, then check what is on disk. A writer script prints
// `ready` once its first write is done and then keeps writing until killed. T1 plugs the journal
// appender in with its own script and `check` (a torn last line must be detected, never a
// corrupt earlier one).
import { spawn } from 'node:child_process';

/**
 * Run `rounds` kill cycles. `check(round)` runs after each kill and throws on a bad state.
 * @param {{ script: string, args: (round: number) => string[], rounds: number,
 *   minDelayMs?: number, maxDelayMs?: number, rnd?: () => number,
 *   check: (round: number) => Promise<void> | void }} o
 */
export async function killDuringWrite(o) {
  const rnd = o.rnd ?? Math.random;
  const min = o.minDelayMs ?? 1;
  const max = o.maxDelayMs ?? 60;
  for (let round = 0; round < o.rounds; round++) {
    const child = spawn(process.execPath, [o.script, ...o.args(round)], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let err = '';
    child.stderr.on('data', (d) => (err += String(d)));
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`writer not ready: ${err}`)), 30_000);
      child.stdout.on('data', (d) => {
        if (String(d).includes('ready')) {
          clearTimeout(timer);
          resolve(undefined);
        }
      });
      child.on('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`writer exited early (${String(code)}): ${err}`));
      });
    });
    child.removeAllListeners('exit');
    await new Promise((r) => setTimeout(r, min + Math.floor(rnd() * (max - min))));
    const gone = new Promise((r) => child.once('exit', r));
    child.kill('SIGKILL');
    await gone;
    await o.check(round);
  }
}
