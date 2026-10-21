import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  checkDataRootChange,
  createPickedFolders,
  dataRootError,
  dataRootShapeError,
} from './dataRoot';

describe('dataRootShapeError', () => {
  it.each(['C:\\Data', 'E:\\Stratlas Data', 'd:/projects'])(
    'accepts a local Windows path %s',
    (p) => {
      expect(dataRootShapeError(p, 'win32')).toBeNull();
    },
  );

  it.each([
    '\\\\server\\share',
    '//server/share',
    '\\\\?\\C:\\Data',
    '\\\\.\\PhysicalDrive0',
    'relative\\path',
    'C:Data',
    'C:\\Data:stream',
    'C:\\a\0b',
    '',
  ])('refuses %j on Windows', (p) => {
    expect(dataRootShapeError(p, 'win32')).not.toBeNull();
  });

  it('needs an absolute path elsewhere and refuses //host', () => {
    expect(dataRootShapeError('/home/x/data', 'linux')).toBeNull();
    expect(dataRootShapeError('data', 'linux')).not.toBeNull();
    expect(dataRootShapeError('//host/share', 'linux')).not.toBeNull();
  });
});

describe('dataRootError and checkDataRootChange', () => {
  let dir: string;
  let file: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'aio-dataroot-'));
    file = join(dir, 'evil.exe');
    await writeFile(file, 'x');
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('accepts an existing folder and refuses a file or a missing path', async () => {
    expect(await dataRootError(dir)).toBeNull();
    expect(await dataRootError(file)).toMatch(/not a folder/);
    expect(await dataRootError(join(dir, 'missing'))).toMatch(/does not exist/);
  });

  it('keeps the current folder without a pick', async () => {
    const picked = createPickedFolders();
    expect(await checkDataRootChange('X', 'X', picked)).toBeNull();
  });

  it('refuses a folder the dialog did not return', async () => {
    const picked = createPickedFolders();
    expect(await checkDataRootChange(dir, 'other', picked)).toMatch(/folder picker/);
  });

  it('accepts a picked existing folder, but never a picked file', async () => {
    const picked = createPickedFolders();
    picked.remember(dir);
    picked.remember(file);
    expect(await checkDataRootChange(dir, 'other', picked)).toBeNull();
    expect(await checkDataRootChange(file, 'other', picked)).toMatch(/not a folder/);
  });
});
