import { describe, expect, it } from 'vitest';
import { readPhotoMeta } from './exif';
import { findTwin, needsTwin, twinFix, type TwinCandidate } from './thermalTwin';
import { xt2Jpeg, xt2Thermal, xt2Visual } from './xt2Fixture';

const AT = '2026:03:03 10:00:00';

describe('needsTwin', () => {
  it('takes a thermal _R photo without DJI XMP, whatever its altitude', () => {
    for (const alt of [12.5, -4.502, undefined]) {
      const meta = readPhotoMeta(
        xt2Thermal({ dateTimeOriginal: AT, lat: 29.38, lon: 47.98, ...(alt ? { alt } : {}) }),
      );
      expect(needsTwin('X_0005_R.JPG', meta)).toBe(true);
    }
    const dropped = readPhotoMeta(
      xt2Jpeg({ lat: 29.38, lon: 47.98, alt: { type: 5, num: 25000000, den: 1000 } }),
    );
    expect(dropped.gps?.altDropped).toBe(true);
    expect(needsTwin('x_0005_r.jpeg', dropped)).toBe(true);
  });

  it('refuses a photo with DJI XMP, a name without _R, or no lat/lon', () => {
    const visual = readPhotoMeta(
      xt2Visual({ dateTimeOriginal: AT, lat: 29.38, lon: 47.98, absAlt: -31.5, relAlt: 14.7 }),
    );
    expect(needsTwin('X_0005_R.JPG', visual)).toBe(false);
    const plain = readPhotoMeta(xt2Thermal({ dateTimeOriginal: AT, lat: 29.38, lon: 47.98 }));
    expect(needsTwin('X_0005.JPG', plain)).toBe(false);
    expect(needsTwin('X_0005_R.png', plain)).toBe(false);
    expect(needsTwin('X_0005_RR.JPG', plain)).toBe(false);
    expect(needsTwin('X_0005_R.JPG', readPhotoMeta(xt2Thermal({ dateTimeOriginal: AT })))).toBe(
      false,
    );
  });
});

describe('findTwin', () => {
  const thermal = { name: 'X_0005_R.JPG', takenAt: '2026-03-03T10:00:00+03:00' };
  const cand = (name: string, takenAt: string | undefined, over: Partial<TwinCandidate> = {}) => ({
    name,
    ...(takenAt ? { takenAt } : {}),
    pos: [1, 2, 3] as [number, number, number],
    ...over,
  });

  it('takes number plus one within 3 s first', () => {
    const plus = cand('X_0006.jpg', '2026-03-03T10:00:02+03:00');
    const minus = cand('X_0004.jpg', '2026-03-03T10:00:00+03:00');
    expect(findTwin(thermal, [minus, plus])).toBe(plus);
  });

  it('takes number minus one when plus one is missing or more than 3 s apart', () => {
    const minus = cand('X_0004.jpg', '2026-03-03T09:59:58+03:00');
    expect(findTwin(thermal, [minus])).toBe(minus);
    const late = cand('X_0006.jpg', '2026-03-03T10:00:04+03:00');
    expect(findTwin(thermal, [late, minus])).toBe(minus);
  });

  it('matches photo ids of the project as well as file names (same prefix, same padding)', () => {
    const id = cand('x-0006', '2026-03-03T10:00:01+03:00');
    expect(findTwin(thermal, [id])).toBe(id);
    expect(findTwin(thermal, [cand('X_006.jpg', '2026-03-03T10:00:01+03:00')])).toBeNull();
    expect(findTwin(thermal, [cand('Y_0006.jpg', '2026-03-03T10:00:01+03:00')])).toBeNull();
  });

  it('refuses a twin without a capture time, an unplaced one, or one that needs a twin', () => {
    expect(findTwin(thermal, [cand('X_0006.jpg', undefined)])).toBeNull();
    expect(findTwin({ name: thermal.name }, [cand('X_0006.jpg', thermal.takenAt)])).toBeNull();
    const unplaced: TwinCandidate = { name: 'X_0006.jpg', takenAt: thermal.takenAt };
    expect(findTwin(thermal, [unplaced])).toBeNull();
    const needy = cand('X_0006.jpg', thermal.takenAt, { needsTwin: true });
    expect(findTwin(thermal, [needy])).toBeNull();
    expect(findTwin(thermal, [])).toBeNull();
  });
});

describe('twinFix', () => {
  it('gives the offset to the twin (0.1 mm steps) and the twin q', () => {
    const q: [number, number, number, number] = [0, 0.7071068, 0, 0.7071068];
    expect(twinFix({ pos: [1, 2, 3] }, { pos: [1.00004, 6.5, -2.123456], q })).toEqual({
      offsetM: [0, 4.5, -5.1235],
      q,
    });
    expect(twinFix({ pos: [1, 2, 3] }, { pos: [2, 2, 3] })).toEqual({ offsetM: [1, 0, 0] });
    expect(twinFix({}, { pos: [2, 2, 3] })).toBeNull();
    expect(twinFix({ pos: [2, 2, 3] }, {})).toBeNull();
  });
});
