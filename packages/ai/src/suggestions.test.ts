import type { WindowKind } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { SUGGESTIONS, suggestionsFor, type SuggestionFacts } from './suggestions';

const ALL: SuggestionFacts = { hasPhotos: true, hasIssues: true, hasAssets: true, hasClips: true };
const WINDOWS = Object.keys(SUGGESTIONS) as WindowKind[];

describe('suggested requests', () => {
  it('puts the three new requests first and offers four', () => {
    for (const w of WINDOWS) {
      const s = suggestionsFor(w, ALL);
      expect(s, w).toHaveLength(4);
      expect(s.slice(0, 3), w).toEqual([
        'Take me to the most severe finding',
        'Show the photos with the highest severity',
        'Which asset has the most findings?',
      ]);
    }
  });

  it('offers no photo request when the project has no photos', () => {
    for (const w of WINDOWS) {
      const s = suggestionsFor(w, { ...ALL, hasPhotos: false });
      expect(
        s.some((x) => /photo/i.test(x)),
        w,
      ).toBe(false);
    }
  });

  it('offers no clip request when the project has no clips', () => {
    for (const w of WINDOWS) {
      const s = suggestionsFor(w, { ...ALL, hasClips: false });
      expect(
        s.some((x) => /clip/i.test(x)),
        w,
      ).toBe(false);
    }
  });

  it('offers no request about findings when the project has none', () => {
    for (const w of WINDOWS) {
      const s = suggestionsFor(w, { ...ALL, hasIssues: false });
      expect(
        s.some((x) => /issue|finding/i.test(x)),
        w,
      ).toBe(false);
    }
  });

  it('leaves out the asset request when there are no tagged assets', () => {
    expect(suggestionsFor('scene3d', { ...ALL, hasAssets: false })).not.toContain(
      'Which asset has the most findings?',
    );
  });

  it('has at least one request in every window for a project with issues', () => {
    const facts: SuggestionFacts = {
      hasPhotos: false,
      hasIssues: true,
      hasAssets: false,
      hasClips: false,
    };
    for (const w of WINDOWS) expect(suggestionsFor(w, facts).length, w).toBeGreaterThan(0);
  });

  it('never repeats a request', () => {
    for (const w of WINDOWS) {
      const s = suggestionsFor(w, ALL);
      expect(new Set(s).size, w).toBe(s.length);
    }
  });
});
