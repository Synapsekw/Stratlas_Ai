import { describe, expect, it } from 'vitest';
import { popupAction } from './popup';

describe('popupAction', () => {
  it('hands https links to the system browser', () => {
    const url = 'https://www.google.com/maps/search/?api=1&query=29.3,47.9';
    expect(popupAction(url)).toEqual({ kind: 'external', url });
  });

  it('refuses a project file: nothing in the app opens a window of its own', () => {
    for (const url of [
      'aio://project/p1/report/Volume%20Report.pdf',
      'aio://project/p1/legacy/Old%20Review.html',
      'aio://project/p1/photos/IMG_0001.jpg',
    ]) {
      expect(popupAction(url), url).toEqual({ kind: 'deny' });
    }
  });

  it('denies other aio hosts, other schemes and junk', () => {
    for (const url of [
      'aio://project/p1',
      'aio://packs/gcc.pmtiles',
      'http://example.com/',
      'file:///C:/Windows/win.ini',
      'blob:aio://project/1234',
      'javascript:alert(1)',
      'not a url',
    ]) {
      expect(popupAction(url), url).toEqual({ kind: 'deny' });
    }
  });
});
