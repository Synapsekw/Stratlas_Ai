import { describe, expect, it } from 'vitest';
import {
  downloadDir,
  isSafeOdmPath,
  odmInstallDir,
  odmRecordPath,
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
  });

  it('the record, downloads and work folders', () => {
    expect(odmRecordPath('E:\\Data')).toMatch(/^E:[\\/]Data[\\/]runtime[\\/]odm\.json$/);
    expect(downloadDir('E:\\Data')).toMatch(/^E:[\\/]Data[\\/]runtime[\\/]downloads$/);
    expect(odmWorkRoot('C:\\Q\\odm-3.6.2')).toBe('C:\\Q\\odm-work');
  });
});
