import { mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as FsPromises from 'node:fs/promises';

/** Lets a test refuse the next renames the way Windows does while a reader holds the target. */
const refusals = vi.hoisted(() => ({ left: 0, code: 'EPERM' }));
vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof FsPromises>();
  return {
    ...fs,
    rename: (from: string, to: string) => {
      if (refusals.left > 0) {
        refusals.left -= 1;
        return Promise.reject(
          Object.assign(new Error(`${refusals.code}: rename`), { code: refusals.code }),
        );
      }
      return fs.rename(from, to);
    },
  };
});

const { renameOver } = await import('./renameOver');
const { readRunSpend, writeRunSpend } = await import('./engineerSpend');
const { readApproval, writeApproval } = await import('./engineerApproval');

const platform = Object.getOwnPropertyDescriptor(process, 'platform');
const asPlatform = (p: NodeJS.Platform) =>
  Object.defineProperty(process, 'platform', { ...platform, value: p });

let dir = '';
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rename-over-'));
  refusals.left = 0;
  refusals.code = 'EPERM';
  asPlatform('win32');
});
afterEach(async () => {
  if (platform) Object.defineProperty(process, 'platform', platform);
  await rm(dir, { recursive: true, force: true });
});

const SPEND = { startedAt: 1, spentUsd: 0.5, calls: 1, tokens: 10, unpriced: 0, aiMs: 0 };

describe('renameOver', () => {
  it.each(['EPERM', 'EACCES', 'EBUSY'])(
    'tries again while Windows refuses with %s',
    async (code) => {
      refusals.code = code;
      refusals.left = 3;
      await writeFile(join(dir, 'a.tmp'), 'new');
      await renameOver(join(dir, 'a.tmp'), join(dir, 'a'));
      expect(await readFile(join(dir, 'a'), 'utf8')).toBe('new');
      expect(refusals.left).toBe(0);
    },
  );

  it('gives up after about 2.5 s of refusals', async () => {
    refusals.left = Infinity;
    await writeFile(join(dir, 'a.tmp'), 'new');
    await expect(renameOver(join(dir, 'a.tmp'), join(dir, 'a'))).rejects.toMatchObject({
      code: 'EPERM',
    });
  });

  it('does not try again off Windows or on other errors', async () => {
    asPlatform('linux');
    refusals.left = 1;
    await writeFile(join(dir, 'a.tmp'), 'new');
    await expect(renameOver(join(dir, 'a.tmp'), join(dir, 'a'))).rejects.toMatchObject({
      code: 'EPERM',
    });
    asPlatform('win32');
    await expect(renameOver(join(dir, 'missing'), join(dir, 'a'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('really replaces a file that a reader held open a moment ago', async () => {
    if (platform?.value !== 'win32') return;
    await writeFile(join(dir, 'a'), 'old');
    await writeFile(join(dir, 'a.tmp'), 'new');
    const reader = await open(join(dir, 'a'), 'r');
    setTimeout(() => void reader.close(), 50);
    await renameOver(join(dir, 'a.tmp'), join(dir, 'a'));
    expect(await readFile(join(dir, 'a'), 'utf8')).toBe('new');
  });
});

describe('engineer files survive a briefly locked target', () => {
  it('saves the run spend', async () => {
    await writeRunSpend(dir, SPEND);
    refusals.left = 2;
    await writeRunSpend(dir, { ...SPEND, calls: 2 });
    expect(await readRunSpend(dir)).toMatchObject({ calls: 2 });
  });

  it('saves the run approval', async () => {
    const approval = {
      token: 't',
      key: 'k',
      photos: true,
      scans: false,
      expires: 1,
      budgetUsd: 2,
      costConfirmed: false,
    };
    refusals.left = 2;
    await writeApproval(dir, approval);
    expect(await readApproval(dir)).toEqual(approval);
  });
});
