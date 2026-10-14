import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ODM_PIN,
  pinFrom,
  REQUIRED_FILES,
  SETUP_ARGS,
  SETUP_MAY_ASK_ADMIN,
  UNINSTALL_ARGS,
} from './pin';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'aio-odm-pin-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('the ODM pin', () => {
  it('names the 3.6.2 release with its size and hash, never a floating latest', () => {
    expect(ODM_PIN).toEqual({
      version: '3.6.2',
      url: 'https://github.com/OpenDroneMap/ODM/releases/download/v3.6.2/ODM_Setup_3.6.2.exe',
      size: 244_864_104,
      sha256: 'c9dbfabf0d066529a7b6c753fd45bf3366a0314266160cd677373bab4caff294',
      installedBytes: 1_100_000_000,
      file: 'ODM_Setup_3.6.2.exe',
    });
  });

  it('installs per user, silently, with what the probe found', () => {
    expect(SETUP_ARGS).toEqual(['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/CURRENTUSER']);
    expect(UNINSTALL_ARGS).toEqual(['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART']);
    expect(REQUIRED_FILES).toEqual([
      'run.bat',
      'winrun.bat',
      'win32env.bat',
      'VERSION',
      'venv\\Scripts\\python.exe',
    ]);
    expect(SETUP_MAY_ASK_ADMIN).toBe(false);
  });

  it('a pin file is read only in end to end tests', async () => {
    const file = join(dir, 'pin.json');
    const fake = { ...ODM_PIN, version: '9.9.9', url: 'http://127.0.0.1:1/x.exe' };
    await writeFile(file, JSON.stringify(fake));
    expect(await pinFrom({ QUADRION_ODM_PIN_FILE: file })).toEqual(ODM_PIN);
    expect(await pinFrom({})).toEqual(ODM_PIN);
    expect(await pinFrom({ QUADRION_E2E: '1', QUADRION_ODM_PIN_FILE: file })).toEqual(fake);
  });
});
