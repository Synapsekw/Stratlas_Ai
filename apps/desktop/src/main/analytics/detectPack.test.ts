import { describe, expect, it } from 'vitest';
import {
  DETECT_EXAMPLES_MIN_PACK,
  DETECT_FRAMES_PACK_FEATURE,
  DETECT_MIN_PACK,
  DETECT_PACK_FEATURE,
  detectPackRefusal,
  packTakesExamples,
} from './detectPack';

describe('pack gate for detect.vlm', () => {
  it('detect.vlm needs processing tools 0.28.0', () => {
    expect(DETECT_MIN_PACK).toBe('0.28.0');
    expect(DETECT_PACK_FEATURE).toEqual({ label: 'Detectors', minVersion: '0.28.0' });
    expect(detectPackRefusal('detect.vlm', '0.27.0')).toBe(
      'Detectors need processing tools 0.28.0 or later (these are 0.27.0). Update them in Settings, Processing tools.',
    );
    expect(detectPackRefusal('detect.vlm', '0.28.0')).toBeNull();
    expect(detectPackRefusal('detect.vlm', '0.28.1')).toBeNull();
    // a development pack, and no pack (the job runner says so itself), pass
    expect(detectPackRefusal('detect.vlm', 'dev')).toBeNull();
    expect(detectPackRefusal('detect.vlm', null)).toBeNull();
    expect(detectPackRefusal('rf.coverage', '0.10.0')).toBeNull();
  });
});

describe('detect.vlm on walk frames needs the newer processing tools', () => {
  const frames = { photos: [], frames: [{ layer: 'walk-1', t: 2 }] };
  it('refuses a run over frames below 0.35.0, photos-only runs are unchanged', () => {
    expect(DETECT_FRAMES_PACK_FEATURE).toEqual({
      label: 'Detectors on 360 walks',
      minVersion: '0.35.0',
    });
    expect(detectPackRefusal('detect.vlm', '0.34.0', frames)).toBe(
      'Detectors on 360 walks need processing tools 0.35.0 or later (these are 0.34.0). Update them in Settings, Processing tools.',
    );
    expect(detectPackRefusal('detect.vlm', '0.35.0', frames)).toBeNull();
    expect(detectPackRefusal('detect.vlm', 'dev', frames)).toBeNull();
    expect(detectPackRefusal('detect.vlm', '0.34.0', { photos: ['p1'] })).toBeNull();
    expect(detectPackRefusal('detect.vlm', '0.34.0', { photos: ['p1'], frames: [] })).toBeNull();
    expect(detectPackRefusal('detect.vlm', '0.34.0')).toBeNull();
    // the older floor still speaks first
    expect(detectPackRefusal('detect.vlm', '0.27.0', frames)).toMatch(/0\.28\.0 or later/);
  });
});

describe('few-shot examples need the newer processing tools', () => {
  it('only from DETECT_EXAMPLES_MIN_PACK, and on a development pack', () => {
    expect(DETECT_EXAMPLES_MIN_PACK).toBe('0.33.0');
    expect(packTakesExamples('0.32.9')).toBe(false);
    expect(packTakesExamples('0.28.0')).toBe(false);
    expect(packTakesExamples(DETECT_EXAMPLES_MIN_PACK)).toBe(true);
    expect(packTakesExamples('0.34.0')).toBe(true);
    expect(packTakesExamples('dev')).toBe(true);
    expect(packTakesExamples(null)).toBe(false);
  });
});
