import { describe, expect, it } from 'vitest';
import { externalLinkAllowed, linkHost, popupAction } from './popup';

describe('popupAction', () => {
  it('hands links to the app link hosts to the system browser', () => {
    for (const url of [
      'https://github.com/OpenDroneMap/ODM/blob/master/LICENSE',
      'https://opendronemap.org/odm/',
      'https://apps.mapbox.com/feedback/',
    ])
      expect(popupAction(url)).toEqual({ kind: 'external', url });
  });

  it('refuses https links to any other host', () => {
    for (const url of [
      'https://www.google.com/maps/search/?api=1&query=29.3,47.9',
      'https://evil.test/',
      'https://github.com.evil.test/',
      'https://github.com:8443/',
      'https://user:pw@github.com/',
    ])
      expect(popupAction(url), url).toEqual({ kind: 'deny' });
  });

  it('allows the configured privacy policy host', () => {
    const extra = [linkHost('https://legal.example.org/privacy')].filter(
      (h): h is string => h !== null,
    );
    expect(externalLinkAllowed('https://legal.example.org/privacy', extra)).toBe(true);
    expect(linkHost('http://legal.example.org/')).toBeNull();
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
