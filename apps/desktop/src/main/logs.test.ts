import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { byLogAge, createLog, exportLogs } from './logs';

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

describe('log rotation and redaction', () => {
  it('keeps a fixed number of rotated files per process log', async () => {
    const log = createLog(dir, { name: 'renderer', maxBytes: 120, keep: 2 });
    for (let i = 0; i < 40; i++) log.write('info', [`line ${String(i)} ${'y'.repeat(30)}`]);
    await log.flush();
    const names = (await readdir(dir)).sort();
    expect(names).toEqual(['renderer.1.log', 'renderer.2.log', 'renderer.log']);
    for (const n of names) expect((await stat(join(dir, n))).size).toBeLessThanOrEqual(120);
    // the newest line is in the live file, older ones moved up a generation
    expect(await readFile(join(dir, 'renderer.log'), 'utf8')).toContain('line 39');
    expect(await readFile(join(dir, 'renderer.2.log'), 'utf8')).not.toContain('line 39');
  });

  it('never writes a key, token or password, even nested in an object or an error', async () => {
    const key = `sk-ant-api03-${'Q'.repeat(40)}`;
    const log = createLog(dir);
    log.write('error', [
      'Provider failed',
      { request: { headers: { 'x-api-key': key }, body: { password: 'hunter2!!' } } },
      new Error(`401 for key ${key}`),
      'token=abc123def456',
    ]);
    await log.flush();
    const text = await readFile(join(dir, 'main.log'), 'utf8');
    expect(text).toContain('Provider failed');
    expect(text).not.toContain(key);
    expect(text).not.toContain('hunter2!!');
    expect(text).not.toContain('abc123def456');
    expect(log.recent(1)[0]).not.toContain(key);
  });

  it('keeps one line per entry and remembers the recent lines', async () => {
    const log = createLog(dir);
    log.write('warn', ['two\nlines']);
    await log.flush();
    log.writeSync('error', ['sync']);
    const text = await readFile(join(dir, 'main.log'), 'utf8');
    expect(text.trimEnd().split('\n')).toHaveLength(2);
    expect(log.recent(5).map((l) => l.split(' ').slice(1).join(' '))).toEqual([
      'WARN two | lines',
      'ERROR sync',
    ]);
  });

  it('orders log files by process, oldest generation first', () => {
    expect(
      ['main.log', 'renderer.log', 'main.2.log', 'main.1.log', 'renderer.1.log'].sort(byLogAge),
    ).toEqual(['main.2.log', 'main.1.log', 'main.log', 'renderer.1.log', 'renderer.log']);
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
