import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  downloadDir,
  isOurOdmFolder,
  isSafeOdmPath,
  odmInstallDir,
  odmRecordPath,
  odmSetupLogPath,
  odmWorkRoot,
  SPACES_OK,
} from './paths';

describe('paths ODM can use', () => {
  it('are drive paths of printable ASCII without spaces or cmd.exe metacharacters', () => {
    expect(SPACES_OK).toBe(false);
    expect(isSafeOdmPath('E:\\Data\\runtime\\odm-3.6.2')).toBe(true);
    expect(isSafeOdmPath('E:\\Stratlas Data\\runtime')).toBe(false);
    expect(isSafeOdmPath('C:\\Users\\Zoë\\x')).toBe(false);
    expect(isSafeOdmPath('C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\aio-odm-1')).toBe(true);
    expect(isSafeOdmPath('E:\\a&b')).toBe(false);
    for (const c of ['^', '%', '!', '(', ')', '<', '>', '|', '"'])
      expect(isSafeOdmPath(`E:\\a${c}b`)).toBe(false);
    expect(isSafeOdmPath('relative\\odm')).toBe(false);
    expect(isSafeOdmPath('/home/odm')).toBe(false);
    expect(isSafeOdmPath('E:\\tab\there')).toBe(false);
  });

  it('the install folder is the data root, else local app data, else the system drive', () => {
    expect(
      odmInstallDir('E:\\Data', { LOCALAPPDATA: 'C:\\Users\\a\\AppData\\Local' }, '3.6.2'),
    ).toBe('E:\\Data\\runtime\\odm-3.6.2');
    expect(
      odmInstallDir('E:\\Stratlas Data', { LOCALAPPDATA: 'C:\\Users\\a\\AppData\\Local' }, '3.6.2'),
    ).toBe('C:\\Users\\a\\AppData\\Local\\QuadrionODM\\odm-3.6.2');
    expect(
      odmInstallDir(
        'E:\\Stratlas Data',
        { LOCALAPPDATA: 'C:\\Users\\Zoë\\AppData\\Local', SystemDrive: 'D:' },
        '3.6.2',
      ),
    ).toBe('D:\\QuadrionODM\\odm-3.6.2');
    expect(odmInstallDir('E:\\Stratlas Data', {}, '3.6.2')).toBe('C:\\QuadrionODM\\odm-3.6.2');
    // an unsafe system drive value falls back to C:
    expect(odmInstallDir('E:\\Stratlas Data', { SystemDrive: 'D:\\Program Files' }, '3.6.2')).toBe(
      'C:\\QuadrionODM\\odm-3.6.2',
    );
  });

  it('knows a folder of ours by its name and parent', () => {
    const env = { LOCALAPPDATA: 'C:\\Users\\a\\AppData\\Local' };
    expect(isOurOdmFolder('E:\\Data\\runtime\\odm-3.6.2', 'E:\\Data', env)).toBe(true);
    expect(isOurOdmFolder('e:\\data\\runtime\\odm-3.5.6\\', 'E:\\Data', env)).toBe(true);
    expect(
      isOurOdmFolder('C:\\Users\\a\\AppData\\Local\\QuadrionODM\\odm-3.6.2', 'E:\\Data', env),
    ).toBe(true);
    expect(isOurOdmFolder('C:\\QuadrionODM\\odm-3.6.2', 'E:\\Data', {})).toBe(true);
    expect(isOurOdmFolder('E:\\Data\\runtime', 'E:\\Data', env)).toBe(false);
    expect(isOurOdmFolder('E:\\Data\\runtime\\photos', 'E:\\Data', env)).toBe(false);
    expect(isOurOdmFolder('C:\\ODM', 'E:\\Data', env)).toBe(false);
    expect(isOurOdmFolder('E:\\Other\\odm-3.6.2', 'E:\\Data', env)).toBe(false);
  });

  it('the record, downloads and work folders', () => {
    expect(odmRecordPath('E:\\Data')).toMatch(/^E:[\\/]Data[\\/]runtime[\\/]odm\.json$/);
    expect(downloadDir('E:\\Data')).toMatch(/^E:[\\/]Data[\\/]runtime[\\/]downloads$/);
    expect(odmWorkRoot('C:\\Q\\odm-3.6.2')).toBe('C:\\Q\\odm-work');
  });
});

describe("the setup's log", () => {
  it('sits in the runtime folder, outside the install folder a failed install removes', () => {
    const log = odmSetupLogPath('E:\\Data', '3.6.2');
    expect(log).toBe(join('E:\\Data', 'runtime', 'logs', 'odm-setup-3.6.2.log'));
    expect(log.startsWith(odmInstallDir('E:\\Data', {}, '3.6.2'))).toBe(false);
  });
});
