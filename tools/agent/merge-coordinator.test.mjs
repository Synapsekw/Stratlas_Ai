import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  coordinatorHint,
  coordinatorLine,
  LOCK_NAME,
  localStamp,
  parseArgs,
  parseOwner,
  readCoordinator,
  releaseLock,
  takeLock,
} from './merge-coordinator.mjs';

describe('parseOwner', () => {
  it('reads the session name and time, dropping a remark in brackets', () => {
    const text =
      'session: aio-software-f2 (merge coordinator)\nbranch: local main\n' +
      'time: 2026-10-24T12:06:09+04:00\nnote: local only\n';
    expect(parseOwner(text)).toEqual({
      name: 'aio-software-f2',
      since: '2026-10-24T12:06:09+04:00',
      raw: text,
    });
  });

  it('falls back to unknown', () => {
    expect(parseOwner('')).toMatchObject({ name: 'unknown', since: 'unknown' });
  });
});

describe('the lock folder', () => {
  let commonDir;
  beforeEach(() => {
    commonDir = mkdtempSync(join(tmpdir(), 'merge-coord-'));
  });
  afterEach(() => rmSync(commonDir, { recursive: true, force: true }));

  it('reads no coordinator without a lock', () => {
    expect(readCoordinator(commonDir)).toBeNull();
    expect(readCoordinator('')).toBeNull();
  });

  it('counts a lock folder without an owner file', () => {
    mkdirSync(join(commonDir, LOCK_NAME));
    expect(readCoordinator(commonDir)).toMatchObject({ name: 'unknown' });
  });

  it('takes the lock once and writes the owner only on success', () => {
    const first = takeLock(commonDir, 'aio-software-a1', '2026-10-24T10:00:00+04:00');
    expect(first.ok).toBe(true);
    expect(first.coordinator).toMatchObject({
      name: 'aio-software-a1',
      since: '2026-10-24T10:00:00+04:00',
    });
    const second = takeLock(commonDir, 'aio-software-b2', 'later');
    expect(second.ok).toBe(false);
    expect(second.coordinator?.name).toBe('aio-software-a1');
    expect(readFileSync(join(commonDir, LOCK_NAME, 'owner'), 'utf8')).toContain('aio-software-a1');
    releaseLock(commonDir);
    expect(existsSync(join(commonDir, LOCK_NAME))).toBe(false);
  });
});

describe('coordinatorHint and coordinatorLine', () => {
  const coordinator = { name: 'aio-software-f2', since: '2026-10-24T12:06', raw: '' };

  it('points at the coordinator', () => {
    const hint = coordinatorHint(coordinator);
    expect(hint).toContain('merge coordinator session aio-software-f2 (since 2026-10-24T12:06)');
    expect(hint).toContain('git rebase main');
    expect(hint).toContain('node tools/agent/finish-task.mjs');
    expect(hint).toContain('SendMessage aio-software-f2');
    expect(hint).toContain('Do not push or open pull requests.');
    expect(coordinatorLine(coordinator)).toBe(
      'Merge coordinator: aio-software-f2 since 2026-10-24T12:06',
    );
  });

  it('says how to start one when none runs', () => {
    expect(coordinatorHint(null)).toContain('No merge coordinator session is running');
    expect(coordinatorHint(null)).toContain('/coordinate');
    expect(coordinatorLine(null)).toContain('none running');
  });
});

describe('parseArgs and localStamp', () => {
  it('parses the subcommands', () => {
    expect(parseArgs([])).toMatchObject({ command: 'status' });
    expect(parseArgs(['take', '--name', 'x'])).toMatchObject({ command: 'take', name: 'x' });
    expect(parseArgs(['take']).error).toBeTruthy();
    expect(parseArgs(['land', 'feat/a'])).toMatchObject({ command: 'land', branch: 'feat/a' });
    expect(parseArgs(['land']).error).toBeTruthy();
    expect(parseArgs(['release', '--yes'])).toMatchObject({ command: 'release', yes: true });
    expect(parseArgs(['push']).error).toBeTruthy();
  });

  it('stamps local time with its offset', () => {
    expect(localStamp(new Date())).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[+-]\d\d:\d\d$/);
  });
});
