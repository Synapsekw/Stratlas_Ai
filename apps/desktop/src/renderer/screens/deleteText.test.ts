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
    expect(deleteText(entry({ package: { encrypted: false, readOnly: true } }))).toEqual({
      text: 'library.delete.text.package',
      label: 'library.delete.file',
      path: 'D:\\Survey Data\\projects\\north-yard',
    });
  });
  it('names the export folder for a kit', () => {
    expect(deleteText(entry({ kind: 'road' }))).toEqual({
      text: 'library.delete.text.kit',
      label: 'library.delete.folder',
      path: 'D:\\Survey Data\\projects\\north-yard',
    });
  });
  it('names the working copy for a demo, never the folder that ships with the app', () => {
    const copy = 'C:\\Users\\a\\AppData\\Roaming\\app\\demo\\survey-demo';
    const bundled = 'C:\\Program Files\\app\\resources\\demo\\survey-demo';
    expect(deleteText(entry({ path: bundled, demo: { primary: false, copy } }))).toEqual({
      text: 'library.delete.text.demo',
      label: 'library.delete.folder',
      path: copy,
    });
  });
  it('says nothing is on disk for a demo without a working copy', () => {
    const bundled = 'C:\\Program Files\\app\\resources\\demo\\survey-demo';
    expect(deleteText(entry({ path: bundled, demo: { primary: true } }))).toEqual({
      text: 'library.delete.text.demoNone',
      label: 'library.delete.folder',
      path: null,
    });
  });
  it('keeps the project folder text for a native folder, inside the data folder or not', () => {
    const want = { text: 'library.delete.text', label: 'library.delete.folder' };
    expect(deleteText(entry())).toEqual({ ...want, path: 'D:\\Survey Data\\projects\\north-yard' });
    expect(deleteText(entry({ path: 'E:\\Elsewhere\\north-yard' }))).toEqual({
      ...want,
      path: 'E:\\Elsewhere\\north-yard',
    });
  });
});
