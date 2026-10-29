import { describe, expect, it } from 'vitest';
import { DETECT_MIN_PACK, DETECT_PACK_FEATURE, detectPackRefusal } from './detectPack';

describe('pack gate for detect.vlm', () => {
  it('detect.vlm needs processing tools 0.27.0', () => {
    expect(DETECT_MIN_PACK).toBe('0.27.0');
    expect(DETECT_PACK_FEATURE).toEqual({ label: 'Detectors', minVersion: '0.27.0' });
    expect(detectPackRefusal('detect.vlm', '0.26.0')).toBe(
      'Detectors need processing tools 0.27.0 or later (these are 0.26.0). Update them in Settings, Processing tools.',
    );
    expect(detectPackRefusal('detect.vlm', '0.27.0')).toBeNull();
    expect(detectPackRefusal('detect.vlm', '0.28.1')).toBeNull();
    // a development pack, and no pack (the job runner says so itself), pass
    expect(detectPackRefusal('detect.vlm', 'dev')).toBeNull();
    expect(detectPackRefusal('detect.vlm', null)).toBeNull();
    expect(detectPackRefusal('rf.coverage', '0.10.0')).toBeNull();
  });
});
