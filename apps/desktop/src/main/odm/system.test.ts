import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { nodeOdmSystem, odmSmokeEnv } from './system';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'aio-odm-sys-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('the smoke test environment', () => {
  it('drops NoDefaultCurrentDirectoryInExePath whatever its case and sets ODM_NONINTERACTIVE', () => {
    expect(
      odmSmokeEnv({ PATH: 'p', NODEFAULTCURRENTDIRECTORYINEXEPATH: '1', Gone: undefined }),
    ).toEqual({ PATH: 'p', ODM_NONINTERACTIVE: '1' });
  });
});

describe.skipIf(process.platform !== 'win32')('the real smoke test', () => {
  it('runs run.bat --help through cmd.exe from the ODM folder', async () => {
    // like ODM's run.bat: calls winrun.bat by bare name, which needs the current folder searched
    await writeFile(join(dir, 'run.bat'), '@echo off\r\ncall winrun.bat %*\r\n');
    await writeFile(
      join(dir, 'winrun.bat'),
      '@echo off\r\necho usage: run [options] %1 %ODM_NONINTERACTIVE%\r\n',
    );
    const system = nodeOdmSystem({
      ...process.env,
      NoDefaultCurrentDirectoryInExePath: '1',
    });
    const r = await system.runSmoke(dir);
    expect(r.code).toBe(0);
    expect(r.out).toContain('usage: run [options] --help 1');
  });

  it('reg query answers nothing for a key with no ODM in it', async () => {
    const system = nodeOdmSystem(process.env);
    expect(await system.regQuery('HKCU\\Software\\QuadrionNoSuchKeyForTests')).toBe('');
  });
});
