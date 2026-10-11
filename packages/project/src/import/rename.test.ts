import { describe, expect, it } from 'vitest';
import { RENAME_WAITS_MS, isLockedError, renameWhenFree } from './rename';

const locked = (code = 'EPERM') =>
  Object.assign(new Error(`${code}: operation not permitted`), { code });

/** A rename that fails `fails` times with `code`, then succeeds; calls and waits are recorded. */
function flaky(fails: number, code = 'EPERM') {
  const calls: [string, string][] = [];
  const waits: number[] = [];
  return {
    calls,
    waits,
    o: {
      platform: 'win32' as const,
      rename: (from: string, to: string) => {
        calls.push([from, to]);
        return calls.length <= fails ? Promise.reject(locked(code)) : Promise.resolve();
      },
      sleep: (ms: number) => {
        waits.push(ms);
        return Promise.resolve();
      },
    },
  };
}

describe('renameWhenFree', () => {
  it('renames at once when nothing holds the file', async () => {
    const f = flaky(0);
    await renameWhenFree('a', 'b', f.o);
    expect(f.calls).toEqual([['a', 'b']]);
    expect(f.waits).toEqual([]);
  });

  it('tries again while another program holds a file open, then succeeds', async () => {
    for (const code of ['EPERM', 'EACCES', 'EBUSY']) {
      const f = flaky(3, code);
      await renameWhenFree('a', 'b', f.o);
      expect(f.calls).toHaveLength(4);
      expect(f.waits).toEqual(RENAME_WAITS_MS.slice(0, 3));
    }
  });

  it('gives up after tens of seconds with the last error, never earlier', async () => {
    const f = flaky(Infinity);
    await expect(renameWhenFree('a', 'b', f.o)).rejects.toMatchObject({ code: 'EPERM' });
    expect(f.calls).toHaveLength(RENAME_WAITS_MS.length + 1);
    const total = f.waits.reduce((n, w) => n + w, 0);
    expect(total).toBeGreaterThanOrEqual(20_000);
    expect(total).toBeLessThanOrEqual(60_000);
  });

  it('does not wait for an error that is not a lock', async () => {
    const f = flaky(Infinity, 'ENOENT');
    await expect(renameWhenFree('a', 'b', f.o)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(f.calls).toHaveLength(1);
  });

  it('stops at once when the caller says the refusal is not a lock (the target exists)', async () => {
    const f = flaky(Infinity);
    let asked = 0;
    await expect(
      renameWhenFree('a', 'b', {
        ...f.o,
        giveUp: () => {
          asked++;
          return Promise.resolve(true);
        },
      }),
    ).rejects.toMatchObject({ code: 'EPERM' });
    expect(asked).toBe(1);
    expect(f.calls).toHaveLength(1);
    expect(f.waits).toEqual([]);
  });

  it('stops waiting when the import is cancelled', async () => {
    const f = flaky(Infinity);
    const stop = new AbortController();
    f.o.sleep = (ms: number) => {
      f.waits.push(ms);
      if (f.waits.length === 2) stop.abort();
      return Promise.resolve();
    };
    await expect(renameWhenFree('a', 'b', { ...f.o, signal: stop.signal })).rejects.toMatchObject({
      code: 'EPERM',
    });
    expect(f.calls).toHaveLength(2);
  });

  it('only waits on Windows, where an open file refuses a rename', async () => {
    const f = flaky(Infinity);
    await expect(renameWhenFree('a', 'b', { ...f.o, platform: 'linux' })).rejects.toMatchObject({
      code: 'EPERM',
    });
    expect(f.calls).toHaveLength(1);
  });
});

describe('isLockedError', () => {
  it('knows the codes of a file held open', () => {
    expect(isLockedError(locked('EBUSY'))).toBe(true);
    expect(isLockedError(locked('ENOENT'))).toBe(false);
    expect(isLockedError(new Error('plain'))).toBe(false);
    expect(isLockedError(null)).toBe(false);
  });
});
