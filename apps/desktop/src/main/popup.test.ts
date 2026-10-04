import { describe, expect, it } from 'vitest';
import { popupAction } from './popup';

const known = (id: string) => id === 'masafi';

describe('popupAction', () => {
  it('opens a project file (the legacy report PDF) in a Stratlas viewer window', () => {
    expect(
      popupAction('aio://project/masafi/legacy/Masafi%20Stockpile%20Volume%20Report.pdf', known),
    ).toEqual({
      kind: 'viewer',
      url: 'aio://project/masafi/legacy/Masafi%20Stockpile%20Volume%20Report.pdf',
      title: 'Masafi Stockpile Volume Report.pdf',
    });
  });

  it('hands https links to the system browser', () => {
    const url = 'https://www.google.com/maps/search/?api=1&query=29.3,47.9';
    expect(popupAction(url, known)).toEqual({ kind: 'external', url });
  });

  it('denies unknown projects, other aio hosts, other schemes and junk', () => {
    for (const url of [
      'aio://project/other/legacy/x.pdf',
      'aio://project/masafi',
      'aio://packs/gcc.pmtiles',
      'http://example.com/',
      'file:///C:/Windows/win.ini',
      'blob:aio://project/1234',
      'javascript:alert(1)',
      'not a url',
    ]) {
      expect(popupAction(url, known), url).toEqual({ kind: 'deny' });
    }
  });
});
