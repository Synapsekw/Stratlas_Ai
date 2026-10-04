import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLog, exportLogs } from './logs';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'aio-logs-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('app log', () => {
  it('appends timestamped lines with the level', async () => {
    const log = createLog(dir, { now: () => new Date('2026-10-04T08:00:00.000Z') });
    log.write('warn', ['Map pack', { id: 'gcc' }, new Error('boom')]);
    await log.flush();
    const text = await readFile(join(dir, 'main.log'), 'utf8');
    expect(text).toContain('2026-10-04T08:00:00.000Z WARN Map pack {"id":"gcc"} Error: boom');
  });

  it('starts a new file when the log grows past its limit', async () => {
    const log = createLog(dir, { maxBytes: 200 });
    for (let i = 0; i < 10; i++) log.write('info', [`line ${String(i)} ${'x'.repeat(40)}`]);
    await log.flush();
    expect((await stat(join(dir, 'main.log'))).size).toBeLessThanOrEqual(200);
    expect((await stat(join(dir, 'main.1.log'))).size).toBeGreaterThan(0);
  });
});

describe('exportLogs', () => {
  it('writes system details and every log, oldest first, into one file', async () => {
    await writeFile(join(dir, 'main.1.log'), 'older\n');
    await writeFile(join(dir, 'main.log'), 'newer\n');
    const out = join(dir, 'export.txt');
    await exportLogs(dir, out, ['Version 0.1.0', 'Platform win32']);
    const text = await readFile(out, 'utf8');
    expect(text.indexOf('Version 0.1.0')).toBeLessThan(text.indexOf('older'));
    expect(text.indexOf('older')).toBeLessThan(text.indexOf('newer'));
    expect(text).toContain('main.1.log');
  });

  it('exports details even when there are no logs yet', async () => {
    const out = join(dir, 'export.txt');
    await exportLogs(join(dir, 'none'), out, ['Version 0.1.0']);
    expect(await readFile(out, 'utf8')).toContain('No log files');
  });
});
