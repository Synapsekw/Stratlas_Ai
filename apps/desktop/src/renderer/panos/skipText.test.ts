import { describe, expect, it } from 'vitest';
import { fisheyeSkipNote, panoSkipText } from './skipText';

const FISHEYE =
  'Two fisheye circles, not a 360 yet: export it as a 360 photo from Insta360 Studio first.';

describe('panoSkipText', () => {
  it('words every skip reason, the dual-fisheye one through its own key', () => {
    expect(panoSkipText('few-frames')).toBe('Moving drone or single shot');
    expect(panoSkipText('dual-fisheye')).toBe(FISHEYE);
  });
});

describe('fisheyeSkipNote', () => {
  it('names the skipped fisheye stills and says what to do, or nothing when there are none', () => {
    expect(
      fisheyeSkipNote([
        { file: 'D:\\Pano\\IMG_1.insp', reason: 'dual-fisheye' },
        { file: 'D:/Pano/x.JPG', reason: 'few-frames' },
        { file: 'D:/Pano/IMG_2.insp', reason: 'dual-fisheye' },
      ]),
    ).toBe(`IMG_1.insp, IMG_2.insp: ${FISHEYE}`);
    expect(fisheyeSkipNote([{ file: 'D:/Pano/x.JPG', reason: 'few-frames' }])).toBeNull();
  });
});
