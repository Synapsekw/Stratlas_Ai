import type { LibraryEntry } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { deleteText } from './deleteText';

const entry = (over: Partial<LibraryEntry> = {}): LibraryEntry => ({
  id: 'north-yard',
  name: 'North yard',
  path: 'D:\\Survey Data\\projects\\north-yard',
  kind: 'native',
  ...over,
});

describe('deleteText', () => {
  it('names the package file for a package', () => {
    expect(deleteText(entry({ package: true }))).toEqual({
      text: 'library.delete.text.package',
      label: 'library.delete.file',
    });
  });
  it('names the export folder for a kit', () => {
    expect(deleteText(entry({ kind: 'road' }))).toEqual({
      text: 'library.delete.text.kit',
      label: 'library.delete.folder',
    });
  });
  it('names the working copy for a demo', () => {
    expect(deleteText(entry({ demo: true }))).toEqual({
      text: 'library.delete.text.demo',
      label: 'library.delete.folder',
    });
  });
  it('keeps the project folder text for a native folder, inside the data folder or not', () => {
    const want = { text: 'library.delete.text', label: 'library.delete.folder' };
    expect(deleteText(entry())).toEqual(want);
    expect(deleteText(entry({ path: 'E:\\Elsewhere\\north-yard' }))).toEqual(want);
  });
});
