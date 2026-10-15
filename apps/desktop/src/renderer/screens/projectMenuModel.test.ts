import type { LibraryEntry } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { inDataFolder, projectActions, samePathText } from './projectMenuModel';

const DATA = 'D:\\Survey Data';
const entry = (over: Partial<LibraryEntry> = {}): LibraryEntry => ({
  id: 'north-yard',
  name: 'North yard',
  path: `${DATA}\\projects\\north-yard`,
  kind: 'native',
  ...over,
});
const ids = (e: LibraryEntry, current = false, jobRunning = false) =>
  projectActions(e, { dataRoot: DATA, current, jobRunning }).map((a) =>
    a.why ? `${a.id}:${a.why}` : a.id,
  );

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

describe('samePathText', () => {
  it('ignores case and the kind of slash on Windows paths', () => {
    expect(samePathText('D:\\Jobs\\A', 'd:/jobs/a/')).toBe(true);
    expect(samePathText('D:\\Jobs\\A', 'D:\\Jobs\\B')).toBe(false);
    expect(samePathText('/Data/a', '/data/a')).toBe(false);
  });
});

describe('projectActions', () => {
  const pkg = entry({
    path: `${DATA}\\projects\\handover.aio`,
    package: { encrypted: false, readOnly: true },
  });
  const encrypted = entry({ package: { encrypted: true, readOnly: true } });
  const demo = entry({ demo: { primary: true } });
  const kit = entry({ kind: 'volumetric' });
  const outside = entry({ path: 'C:\\Jobs\\north-yard' });
  const inData = entry();

  it('lists the actions of a project in the data folder in order', () => {
    expect(ids(entry())).toEqual([
      'open',
      'rename',
      'reveal',
      'thumbnail',
      'move',
      'emptyTrash',
      'remove',
      'delete',
    ]);
  });
  it('offers Empty project trash right after Change thumbnail and Move, greyed for a package', () => {
    const list = ids(entry());
    expect(list.indexOf('emptyTrash')).toBe(list.indexOf('move') + 1);
    expect(ids(pkg)).toContain('emptyTrash:package');
  });
  it('adds Export package and Close project on the open project, and holds Delete back', () => {
    expect(ids(entry(), true)).toEqual([
      'open',
      'rename',
      'reveal',
      'thumbnail',
      'move',
      'emptyTrash',
      'export',
      'close',
      'remove',
      'delete:open',
    ]);
  });
  it('offers Remove and Delete for every kind of card', () => {
    for (const e of [pkg, encrypted, demo, kit, outside, inData]) {
      const a = projectActions(e, { dataRoot: DATA, current: false, jobRunning: false });
      expect(a.find((x) => x.id === 'remove')).toEqual({ id: 'remove' });
      expect(a.find((x) => x.id === 'delete')).toEqual({ id: 'delete' });
    }
  });
  it('holds Delete back on the open project and while a job runs, never Remove', () => {
    const open = projectActions(pkg, { dataRoot: DATA, current: true, jobRunning: true });
    expect(open.find((x) => x.id === 'delete')).toEqual({ id: 'delete', why: 'open' });
    expect(open.find((x) => x.id === 'remove')).toEqual({ id: 'remove' });
    const job = projectActions(demo, { dataRoot: DATA, current: false, jobRunning: true });
    expect(job.find((x) => x.id === 'delete')).toEqual({ id: 'delete', why: 'job' });
    expect(job.find((x) => x.id === 'remove')).toEqual({ id: 'remove' });
  });
  it('still greys Rename for a package, a demo, a kit export and a folder from elsewhere', () => {
    expect(ids(pkg)).toContain('rename:package');
    expect(ids(demo)).toContain('rename:demo');
    expect(ids(kit)).toContain('rename:kit');
    expect(ids(outside)).toContain('rename:outside');
  });
  it('offers Change thumbnail and Move to folder for every card', () => {
    for (const e of [pkg, encrypted, demo, kit, outside, inData]) {
      const list = ids(e);
      expect(list).toContain('thumbnail');
      expect(list).toContain('move');
    }
  });
});
