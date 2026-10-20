import { describe, expect, it } from 'vitest';
import {
  findOtherOdm,
  missingVcRuntime,
  nvcudaPresent,
  nvidiaName,
  parseUninstallEntries,
  UNINSTALL_MATCH,
} from './detect';

const KEY = 'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{ODM}_is1';
const REG = [
  KEY,
  '    DisplayName    REG_SZ    ODM version 3.5.6',
  '    InstallLocation    REG_SZ    C:\\ODM\\',
  '    DisplayVersion    REG_SZ    3.5.6',
  '',
  'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Other',
  '    DisplayName    REG_SZ    Something with ODM inside',
  '',
  'End of search: 2 match(es) found.',
].join('\r\n');

const regFor =
  (text: string) =>
  (k: string): Promise<string> =>
    Promise.resolve(k.startsWith('HKCU') ? text : '');

describe('finding another ODM', () => {
  it('parses reg query output into uninstall entries', () => {
    expect(parseUninstallEntries(REG)).toEqual([
      {
        key: KEY,
        displayName: 'ODM version 3.5.6',
        installLocation: 'C:\\ODM\\',
        displayVersion: '3.5.6',
      },
      {
        key: 'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Other',
        displayName: 'Something with ODM inside',
      },
    ]);
    expect(parseUninstallEntries('')).toEqual([]);
    expect(UNINSTALL_MATCH.test('ODM version 3.6.2')).toBe(true);
    expect(UNINSTALL_MATCH.test('Something with ODM inside')).toBe(false);
    expect(UNINSTALL_MATCH.test('ODMX')).toBe(false);
  });

  it('answers an uninstall entry that is not ours', async () => {
    expect(
      await findOtherOdm({
        regQuery: regFor(REG),
        exists: () => Promise.resolve(false),
        ours: null,
        env: {},
      }),
    ).toEqual({ dir: 'C:\\ODM', version: '3.5.6' });
    const nameOnly = REG.replace(/^.*DisplayVersion.*$/m, '');
    expect(
      await findOtherOdm({
        regQuery: regFor(nameOnly),
        exists: () => Promise.resolve(false),
        ours: null,
        env: {},
      }),
    ).toEqual({ dir: 'C:\\ODM', version: '3.5.6' });
  });

  it('reads the folder from the entry itself when its path has no "ODM" in it', async () => {
    // `reg query /f ODM /d` prints only the values holding "ODM": here the name, not the folder
    const key =
      'HKEY_LOCAL_MACHINE\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{X}_is1';
    const found = [key, '    DisplayName    REG_SZ    ODM version 3.5.6', ''].join('\r\n');
    const full = [
      key,
      '    Inno Setup: App Path    REG_SZ    D:\\OpenDroneMap',
      '    InstallLocation    REG_SZ    D:\\OpenDroneMap\\',
      '    Inno Setup: Selected Tasks    REG_SZ    ',
      '    DisplayName    REG_SZ    ODM version 3.5.6',
      '    DisplayVersion    REG_SZ    3.5.6',
      '    Publisher    REG_SZ    OpenDroneMap',
      '',
    ].join('\r\n');
    const asked: string[][] = [];
    const regQuery = (k: string, search?: string): Promise<string> => {
      asked.push(search ? [k, search] : [k]);
      if (k === key && !search) return Promise.resolve(full);
      return Promise.resolve(k.startsWith('HKLM\\Software\\Microsoft') && search ? found : '');
    };
    const d = { regQuery, exists: () => Promise.resolve(false), env: {} };
    expect(await findOtherOdm({ ...d, ours: null })).toEqual({
      dir: 'D:\\OpenDroneMap',
      version: '3.5.6',
    });
    expect(asked).toContainEqual([key]);
    expect(await findOtherOdm({ ...d, ours: 'd:\\opendronemap\\' })).toBeNull();
    // only the App Path: still found
    const appPathOnly = full.replace(/^.*InstallLocation.*$/m, '');
    const d2 = {
      ...d,
      regQuery: (k: string, search?: string) =>
        k === key && !search ? Promise.resolve(appPathOnly) : regQuery(k, search),
    };
    expect(await findOtherOdm({ ...d2, ours: null })).toEqual({
      dir: 'D:\\OpenDroneMap',
      version: '3.5.6',
    });
  });

  it('leaves out a program named ODM by another publisher', async () => {
    const key = 'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Acme';
    const entry = [
      key,
      '    DisplayName    REG_SZ    ODM Office Data Manager',
      '    InstallLocation    REG_SZ    C:\\Program Files\\Acme ODM\\',
      '    Publisher    REG_SZ    Acme',
      '',
    ].join('\r\n');
    expect(
      await findOtherOdm({
        regQuery: (k) => Promise.resolve(k.startsWith('HKCU') || k === key ? entry : ''),
        exists: () => Promise.resolve(false),
        ours: null,
        env: {},
      }),
    ).toBeNull();
  });

  it('ignores an entry whose folder is ours', async () => {
    expect(
      await findOtherOdm({
        regQuery: regFor(REG),
        exists: () => Promise.resolve(false),
        ours: 'c:\\odm',
        env: {},
      }),
    ).toBeNull();
    expect(
      await findOtherOdm({
        regQuery: regFor(REG),
        exists: () => Promise.resolve(false),
        ours: [null, 'E:\\Data\\runtime\\odm-3.6.2', 'C:\\ODM\\'],
        env: {},
      }),
    ).toBeNull();
  });

  it('finds C:\\ODM\\run.bat without a registry entry', async () => {
    const seen: string[] = [];
    const exists = (p: string) => {
      seen.push(p);
      return Promise.resolve(p === 'C:\\ODM\\run.bat');
    };
    expect(await findOtherOdm({ regQuery: regFor(''), exists, ours: null, env: {} })).toEqual({
      dir: 'C:\\ODM',
    });
    expect(seen).toContain('C:\\ODM\\run.bat');
    expect(
      await findOtherOdm({ regQuery: regFor(''), exists, ours: 'C:\\ODM\\', env: {} }),
    ).toBeNull();
  });

  it('QUADRION_ODM_OTHER stands for another ODM only in end to end tests', async () => {
    const d = { regQuery: regFor(''), exists: () => Promise.resolve(false), ours: null };
    expect(await findOtherOdm({ ...d, env: { QUADRION_ODM_OTHER: 'D:\\O' } })).toBeNull();
    expect(
      await findOtherOdm({ ...d, env: { QUADRION_E2E: '1', QUADRION_ODM_OTHER: 'D:\\O' } }),
    ).toEqual({ dir: 'D:\\O' });
  });
});

describe('the GPU line', () => {
  it('nvcuda.dll in System32 means the CUDA driver is there', async () => {
    const seen: string[] = [];
    const exists = (p: string) => {
      seen.push(p);
      return Promise.resolve(true);
    };
    expect(await nvcudaPresent({ SYSTEMROOT: 'D:\\Win' }, exists)).toBe(true);
    expect(seen[0]?.toLowerCase()).toBe('d:\\win\\system32\\nvcuda.dll');
    expect(await nvcudaPresent({ SystemRoot: 'D:\\Win' }, () => Promise.resolve(false))).toBe(
      false,
    );
  });

  it("lists the files of Microsoft's x64 C++ runtime missing from System32", async () => {
    const seen: string[] = [];
    const exists = (p: string) => {
      seen.push(p.toLowerCase());
      return Promise.resolve(!p.toLowerCase().endsWith('vcruntime140_1.dll'));
    };
    expect(await missingVcRuntime({ SYSTEMROOT: 'D:\\Win' }, exists)).toEqual([
      'vcruntime140_1.dll',
    ]);
    expect(seen).toEqual([
      'd:\\win\\system32\\vcruntime140.dll',
      'd:\\win\\system32\\vcruntime140_1.dll',
      'd:\\win\\system32\\msvcp140.dll',
    ]);
    expect(await missingVcRuntime({ SystemRoot: 'D:\\Win' }, () => Promise.resolve(true))).toEqual(
      [],
    );
  });

  it('names the NVIDIA card', () => {
    expect(nvidiaName([])).toBeNull();
    expect(nvidiaName([{ name: 'Intel(R) UHD Graphics', vendor: 'Intel' }])).toBeNull();
    expect(
      nvidiaName([
        { name: 'Intel(R) UHD Graphics', vendor: 'Intel' },
        { name: 'NVIDIA GeForce RTX 5070 Ti' },
      ]),
    ).toBe('NVIDIA GeForce RTX 5070 Ti');
    expect(nvidiaName([{ name: 'GeForce GTX 1080', vendor: 'NVIDIA Corporation' }])).toBe(
      'GeForce GTX 1080',
    );
  });
});
