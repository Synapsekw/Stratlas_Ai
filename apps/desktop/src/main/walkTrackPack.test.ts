import { describe, expect, it } from 'vitest';
import { WALK_TRACK_PACK_FEATURE, walkTrackPackRefusal } from './walkTrackPack';

describe('pack gate for walk.track', () => {
  it('needs processing tools 0.35.0', () => {
    expect(WALK_TRACK_PACK_FEATURE).toEqual({
      label: 'Walk detections tracked and placed',
      minVersion: '0.35.0',
    });
    expect(walkTrackPackRefusal('walk.track', '0.34.0')).toBe(
      'Walk detections tracked and placed needs processing tools 0.35.0 or later (these are 0.34.0). Update them in Settings, Processing tools.',
    );
    expect(walkTrackPackRefusal('walk.track', '0.35.0')).toBeNull();
    expect(walkTrackPackRefusal('walk.track', '0.36.1')).toBeNull();
    // a development pack, and no pack (the job runner says so itself), pass
    expect(walkTrackPackRefusal('walk.track', 'dev')).toBeNull();
    expect(walkTrackPackRefusal('walk.track', null)).toBeNull();
    expect(walkTrackPackRefusal('walk.process', '0.10.0')).toBeNull();
  });
});
