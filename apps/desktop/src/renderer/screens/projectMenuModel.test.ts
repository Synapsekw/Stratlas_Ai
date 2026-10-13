import type { LibraryEntry } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { inDataFolder, projectActions } from './projectMenuModel';

const DATA = 'D:\\Survey Data';
const entry = (over: Partial<LibraryEntry> = {}): LibraryEntry => ({
  id: 'north-yard',
  name: 'North yard',
  path: `${DATA}\\projects\\north-yard`,
  kind: 'native',
  ...over,
});
const ids = (e: LibraryEntry, current = false) =>
  projectActions(e, { dataRoot: DATA, current }).map((a) => (a.why ? `${a.id}:${a.why}` : a.id));

describe('inDataFolder', () => {
  it('is true for a folder directly inside <data folder>/projects', () => {
    expect(inDataFolder(DATA, `${DATA}\\projects\\north-yard`)).toBe(true);
    expect(inDataFolder('/Users/sam/Data', '/Users/sam/Data/projects/north-yard')).toBe(true);
  });
  it('ignores case, the kind of slash and a trailing separator on Windows', () => {
    expect(inDataFolder('d:/survey data/', 'D:\\Survey Data\\Projects\\North-Yard')).toBe(true);
  });
  it('keeps case on other systems', () => {
    expect(inDataFolder('/data', '/Data/projects/a')).toBe(false);
  });
  it('is false for the data folder, its projects folder, deeper folders and other places', () => {
    for (const p of [
      DATA,
      `${DATA}\\projects`,
      `${DATA}\\projects\\group\\inner`,
      `${DATA}\\packs\\north-yard`,
      `${DATA} old\\projects\\north-yard`,
      'C:\\Users\\sam\\Desktop\\north-yard',
      `${DATA}\\projects\\..\\north-yard`,
      `${DATA}\\projects\\north-yard\\..`,
    ])
      expect(inDataFolder(DATA, p), p).toBe(false);
  });
  it('is false while no data folder is set', () => {
    expect(inDataFolder('', '\\projects\\a')).toBe(false);
  });
});

describe('projectActions', () => {
  it('offers Open, Rename, Show in folder and Delete for a project in the data folder', () => {
    expect(ids(entry())).toEqual(['open', 'rename', 'reveal', 'emptyTrash', 'delete']);
  });
  it('offers Empty project trash right after Show in folder, greyed for a package', () => {
    const list = ids(entry());
    expect(list.indexOf('emptyTrash')).toBe(list.indexOf('reveal') + 1);
    expect(ids(entry({ package: { encrypted: false, readOnly: true } }))).toContain(
      'emptyTrash:package',
    );
  });
  it('adds Export package and Close project on the open project, and holds Delete back', () => {
    expect(ids(entry(), true)).toEqual([
      'open',
      'rename',
      'reveal',
      'emptyTrash',
      'export',
      'close',
      'delete:open',
    ]);
  });
  it('greys Rename and Delete for a package, which is never exported again', () => {
    const pkg = entry({
      path: `${DATA}\\projects\\handover.aio`,
      package: { encrypted: false, readOnly: true },
    });
    expect(ids(pkg)).toEqual([
      'open',
      'rename:package',
      'reveal',
      'emptyTrash:package',
      'delete:package',
    ]);
    expect(ids(pkg, true)).toEqual([
      'open',
      'rename:package',
      'reveal',
      'emptyTrash:package',
      'close',
      'delete:package',
    ]);
  });
  it('greys Rename and Delete for a demo project, a kit export and a folder added from elsewhere', () => {
    expect(ids(entry({ demo: { primary: true } }))).toEqual([
      'open',
      'rename:demo',
      'reveal',
      'emptyTrash',
      'delete:demo',
    ]);
    expect(ids(entry({ kind: 'volumetric' }))).toEqual([
      'open',
      'rename:kit',
      'reveal',
      'emptyTrash:kit',
      'delete:kit',
    ]);
    expect(ids(entry({ path: 'C:\\Jobs\\north-yard' }))).toEqual([
      'open',
      'rename:outside',
      'reveal',
      'emptyTrash',
      'delete:outside',
    ]);
  });
});
