import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCrashStore } from './crash';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'aio-crash-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const ctx = { version: '0.7.0', electron: '44.5.1', platform: 'win32 10.0 x64' };

describe('crash store', () => {
  it('writes a report with version, process, reason and scrubbed last lines', () => {
    const store = createCrashStore(dir, ctx);
    const key = `sk-ant-api03-${'K'.repeat(40)}`;
    const r = store.write({
      process: 'renderer',
      reason: 'crashed',
      exitCode: -1073741819,
      details: `TypeError at send (${key})`,
      lastLines: ['2026-10-05T08:00:00.000Z INFO opened', `2026-10-05T08:00:01.000Z ERROR ${key}`],
    });
    expect(r).not.toBeNull();
    const [saved] = store.reports();
    expect(saved).toMatchObject({
      version: '0.7.0',
      electron: '44.5.1',
      process: 'renderer',
      reason: 'crashed',
      exitCode: -1073741819,
      session: store.session,
    });
    expect(JSON.stringify(saved)).not.toContain(key);
    expect(saved?.lastLines).toHaveLength(2);
  });

  it('shows the notice on the next start when the previous run crashed', () => {
    const first = createCrashStore(dir, ctx);
    first.start({ uncleanNotice: false });
    first.write({ process: 'GPU', reason: 'crashed' });
    // the process dies here: no end()
    const second = createCrashStore(dir, ctx);
    second.start({ uncleanNotice: false });
    expect(second.notice()).toMatchObject({ kind: 'closed', process: 'GPU', reason: 'crashed' });
    second.dismiss();
    expect(second.notice()).toBeNull();
  });

  it('records an unclean exit without a report when asked to', () => {
    const first = createCrashStore(dir, ctx);
    first.start({ uncleanNotice: true });
    const second = createCrashStore(dir, ctx);
    second.start({ uncleanNotice: true });
    expect(second.notice()).toMatchObject({ kind: 'closed', reason: 'unclean-exit' });
    expect(second.reports()[0]?.session).toBe(first.session);
  });

  it('shows nothing after a clean quit, or for an unclean exit in development', () => {
    const first = createCrashStore(dir, ctx);
    first.start({ uncleanNotice: true });
    first.end();
    const second = createCrashStore(dir, ctx);
    second.start({ uncleanNotice: true });
    expect(second.notice()).toBeNull();
    const third = createCrashStore(dir, ctx);
    third.start({ uncleanNotice: false });
    expect(third.notice()).toBeNull();
  });

  it('a window crash shows its own notice in the same run', () => {
    const store = createCrashStore(dir, ctx);
    store.start({ uncleanNotice: false });
    store.write({ process: 'renderer', reason: 'oom' }, 'window');
    expect(store.notice()).toMatchObject({ kind: 'window', reason: 'oom' });
  });

  it('a second instance does not end the first one’s run', () => {
    const first = createCrashStore(dir, ctx);
    first.start({ uncleanNotice: true });
    createCrashStore(dir, ctx).end();
    const third = createCrashStore(dir, ctx);
    third.start({ uncleanNotice: true });
    expect(third.notice()?.reason).toBe('unclean-exit');
  });

  it('keeps at most 20 reports', async () => {
    const store = createCrashStore(dir, ctx);
    for (let i = 0; i < 25; i++) store.write({ process: 'Utility', reason: 'crashed' });
    const names = (await readdir(dir)).filter((n) => n.startsWith('crash-'));
    expect(names).toHaveLength(20);
  });
});
