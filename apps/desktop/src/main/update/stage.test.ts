import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { stageInstaller, verifyMacImage, type Run, type RunResult } from './stage';

describe('stageInstaller', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'aio-stage-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('copies the installer into a fresh private folder; later changes to the original miss it', async () => {
    const src = join(dir, 'Setup.exe');
    await writeFile(src, 'signed bytes');
    const a = await stageInstaller(src, join(dir, 'verified'));
    const b = await stageInstaller(src, join(dir, 'verified'));
    expect(dirname(a)).not.toBe(dirname(b));
    expect(a.endsWith('Setup.exe')).toBe(true);
    await writeFile(src, 'swapped bytes');
    expect(await readFile(a, 'utf8')).toBe('signed bytes');
  });
});

describe('verifyMacImage', () => {
  const ok: RunResult = { code: 0, stdout: '', stderr: '' };
  const runner =
    (over: Partial<Record<'verify' | 'show' | 'spctl', RunResult>> = {}): Run =>
    (file, args) => {
      if (file === 'spctl') return Promise.resolve(over.spctl ?? ok);
      if (args[0] === '--verify') return Promise.resolve(over.verify ?? ok);
      return Promise.resolve(
        over.show ?? {
          code: 0,
          stdout: '',
          stderr: 'Authority=Developer ID\nTeamIdentifier=ABCDE12345\n',
        },
      );
    };

  it('refuses without a pinned team', async () => {
    expect(await verifyMacImage('/x.dmg', undefined, runner())).toMatchObject({
      ok: false,
      error: expect.stringMatching(/no Apple team configured/) as unknown,
    });
  });

  it('accepts a valid image from the pinned team that Gatekeeper accepts', async () => {
    expect(await verifyMacImage('/x.dmg', 'ABCDE12345', runner())).toEqual({ ok: true });
  });

  it('refuses a bad signature, another team, or a Gatekeeper refusal', async () => {
    expect(
      await verifyMacImage(
        '/x.dmg',
        'ABCDE12345',
        runner({ verify: { code: 1, stdout: '', stderr: 'invalid' } }),
      ),
    ).toMatchObject({ ok: false });
    expect(
      await verifyMacImage(
        '/x.dmg',
        'ABCDE12345',
        runner({ show: { code: 0, stdout: '', stderr: 'TeamIdentifier=ZZZZZ99999\n' } }),
      ),
    ).toMatchObject({ ok: false, error: expect.stringMatching(/ZZZZZ99999/) as unknown });
    expect(
      await verifyMacImage(
        '/x.dmg',
        'ABCDE12345',
        runner({ spctl: { code: 3, stdout: '', stderr: 'rejected' } }),
      ),
    ).toMatchObject({ ok: false, error: expect.stringMatching(/Gatekeeper/) as unknown });
  });
});
