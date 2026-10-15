import type { LibraryEntry, LibraryFolder } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { folderCounts, matches, settlePlace, visibleEntries } from './libraryFolderModel';

const entry = (id: string, more: Partial<LibraryEntry> = {}): LibraryEntry => ({
  id,
  name: id,
  path: `D:\\data\\projects\\${id}`,
  kind: 'native',
  ...more,
});

const SURVEYS: LibraryFolder = { id: 'f_aaaaaaaaaa', name: 'Surveys' };
const OLD: LibraryFolder = { id: 'f_bbbbbbbbbb', name: 'Old' };
const folders = [SURVEYS, OLD];

const list = [
  entry('north-yard', { customer: 'Harbour works' }),
  entry('quarry', { folderId: SURVEYS.id, site: 'East pit' }),
  entry('bridge', { folderId: SURVEYS.id }),
  entry('depot', { folderId: OLD.id }),
];
const [loose, quarry] = [list[0] ?? entry('x'), list[1] ?? entry('y')];
const ids = (l: readonly LibraryEntry[]) => l.map((e) => e.id);

describe('libraryFolderModel', () => {
  it('All shows loose cards only, a folder its own', () => {
    expect(ids(visibleEntries(list, { kind: 'all' }, '', folders))).toEqual(['north-yard']);
    expect(ids(visibleEntries(list, { kind: 'folder', id: SURVEYS.id }, '', folders))).toEqual([
      'quarry',
      'bridge',
    ]);
    expect(ids(visibleEntries(list, { kind: 'folder', id: OLD.id }, '   ', folders))).toEqual([
      'depot',
    ]);
  });

  it('a search finds cards in every folder', () => {
    expect(ids(visibleEntries(list, { kind: 'all' }, 'PIT', folders))).toEqual(['quarry']);
    expect(ids(visibleEntries(list, { kind: 'folder', id: OLD.id }, 'harbour', folders))).toEqual([
      'north-yard',
    ]);
    expect(ids(visibleEntries(list, { kind: 'all' }, 'r', folders))).toEqual([
      'north-yard',
      'quarry',
      'bridge',
    ]);
  });

  it('matches on name, customer and site', () => {
    expect(matches(loose, 'harb')).toBe(true);
    expect(matches(quarry, ' east ')).toBe(true);
    expect(matches(quarry, 'nothing')).toBe(false);
    expect(matches(quarry, '')).toBe(true);
  });

  it('counts cards per folder', () => {
    const c = folderCounts(list);
    expect(c.get(SURVEYS.id)).toBe(2);
    expect(c.get(OLD.id)).toBe(1);
    expect(c.size).toBe(2);
  });

  it('falls back to All when the open folder was deleted', () => {
    expect(settlePlace({ kind: 'folder', id: OLD.id }, [SURVEYS])).toEqual({ kind: 'all' });
    const open = { kind: 'folder', id: SURVEYS.id } as const;
    expect(settlePlace(open, folders)).toBe(open);
    const all = { kind: 'all' } as const;
    expect(settlePlace(all, [])).toBe(all);
  });

  it('treats a folderId with no folder as loose', () => {
    const stray = [...list, entry('lost', { folderId: 'f_cccccccccc' })];
    expect(ids(visibleEntries(stray, { kind: 'all' }, '', folders))).toEqual([
      'north-yard',
      'lost',
    ]);
    expect(ids(visibleEntries(stray, { kind: 'folder', id: 'f_cccccccccc' }, '', folders))).toEqual(
      [],
    );
  });
});
