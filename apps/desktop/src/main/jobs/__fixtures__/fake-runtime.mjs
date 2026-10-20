// A stand-in for `python -m aio_pipelines` in unit tests: same JSON-RPC lines on stdio.
// FAKE_MODE: ok | fail | coded (fail with a failure code) | slow (until cancelled) | stubborn (ignores cancel) | crash | live (live progress, then a failure)
import { createInterface } from 'node:readline';

const mode = process.env.FAKE_MODE ?? 'ok';
const send = (m) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...m })}\n`);
const note = (method, params) => send({ method, params });
let cancelled = false;

async function run(id, p) {
  const jobId = p.jobId;
  const plan = [
    { name: 'one', title: 'Step one' },
    { name: 'two', title: 'Step two' },
  ];
  note('progress', { jobId, state: 'plan', steps: 2, plan, fraction: 0 });
  note('progress', {
    jobId,
    step: 'one',
    stepIndex: 0,
    steps: 2,
    state: 'start',
    stepFraction: 0,
    fraction: 0,
    message: 'Step one',
  });
  note('log', { jobId, level: 'info', message: 'working\nsecond line', step: 'one' });
  process.stderr.write('a library warning\n');
  note('progress', {
    jobId,
    step: 'one',
    stepIndex: 0,
    steps: 2,
    state: 'done',
    stepFraction: 1,
    fraction: 0.5,
  });
  if (mode === 'fail') {
    note('error', { jobId, step: 'two', message: 'Bad input', traceback: 'Traceback\n  line' });
    send({ id, error: { code: -32000, message: 'Bad input', data: { jobId } } });
    return;
  }
  if (mode === 'coded') {
    note('error', {
      jobId,
      step: 'two',
      message: 'x',
      code: 'misaligned',
      data: { shiftM: 2.01 },
    });
    send({ id, error: { code: -32000, message: 'x', data: { jobId } } });
    return;
  }
  if (mode === 'live') {
    const base = { jobId, step: 'two', stepIndex: 1, steps: 2, state: 'running', fraction: 0.6 };
    note('progress', {
      ...base,
      live: {
        detail: { label: 'Matching photos', done: 10, total: 20, unit: 'pairs' },
        lastActivityAt: '2026-10-20T10:00:00.000Z',
        stepStartedAt: '2026-10-20T09:50:00.000Z',
        etaSeconds: 30,
      },
    });
    await new Promise((r) => setTimeout(r, 50));
    note('progress', { ...base, live: { etaSeconds: -1 } });
    await new Promise((r) => setTimeout(r, 50));
    send({ id, error: { code: -32000, message: 'Stopped', data: { jobId } } });
    return;
  }
  if (mode === 'crash') {
    process.stderr.write('Fatal Python error: boom\n');
    process.exit(3);
  }
  if (mode === 'slow' || mode === 'stubborn') {
    for (let i = 0; i < 400; i++) {
      if (cancelled && mode === 'slow') {
        send({ id, error: { code: -32001, message: 'Cancelled', data: { jobId } } });
        return;
      }
      note('progress', {
        jobId,
        step: 'two',
        stepIndex: 1,
        steps: 2,
        state: 'running',
        stepFraction: i / 400,
        fraction: 0.5 + i / 800,
      });
      await new Promise((r) => setTimeout(r, 25));
    }
  }
  note('artifact', { jobId, path: 'out/result.json', kind: 'file' });
  note('progress', {
    jobId,
    step: 'two',
    stepIndex: 1,
    steps: 2,
    state: 'done',
    stepFraction: 1,
    fraction: 1,
  });
  send({ id, result: { jobId, status: 'done', outputs: {} } });
}

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const m = JSON.parse(line);
  if (m.method === 'jobs.run') void run(m.id, m.params);
  else if (m.method === 'cancel') {
    cancelled = true;
    send({ id: m.id, result: { ok: true } });
  }
});
rl.on('close', () => {
  if (mode !== 'stubborn') process.exit(0);
});
