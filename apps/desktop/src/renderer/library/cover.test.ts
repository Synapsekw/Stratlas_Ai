import { describe, expect, it } from 'vitest';
import { BUILTIN_COVERS, coverBytes, coverPalette, fitCover } from './cover';

const pal = coverPalette('survey');

describe('cover', () => {
  it('fits a wide image to 640 across and keeps a small one as it is', () => {
    expect(fitCover(4000, 3000)).toEqual({ width: 640, height: 480 });
    expect(fitCover(300, 200)).toEqual({ width: 300, height: 200 });
    expect(fitCover(1000, 4000)).toEqual({ width: 160, height: 640 });
    expect(fitCover(1001, 999, 100)).toEqual({ width: 100, height: 100 });
  });

  it('colours a kit export like its project type, and an unknown purpose neutral', () => {
    expect(coverPalette(undefined, 'volumetric')).toEqual(coverPalette('survey'));
    expect(coverPalette(undefined, 'road')).toEqual(coverPalette('road'));
    expect(coverPalette(undefined, 'aik')).toEqual(coverPalette('vertical-asset'));
    expect(coverPalette(undefined, 'twin')).toEqual(coverPalette('data-fusion'));
    // the manifest's purpose wins over the kit kind
    expect(coverPalette('construction', 'volumetric')).toEqual(coverPalette('construction'));
    const neutral = coverPalette(undefined);
    expect(coverPalette(undefined, 'native')).toEqual(neutral);
    expect(neutral).not.toEqual(pal);
    const purposes = [
      'survey',
      'construction',
      'vertical-asset',
      'confined-space',
      'data-fusion',
      'road',
    ] as const;
    expect(new Set(purposes.map((p) => coverPalette(p).accent)).size).toBe(purposes.length);
  });

  it('offers four built-in covers', () => {
    expect(BUILTIN_COVERS).toEqual(['contours', 'grid', 'ridge', 'dots']);
  });

  it('sends nothing for No cover and null for the project picture', async () => {
    expect(await coverBytes({ kind: 'none' }, pal)).toBeUndefined();
    expect(await coverBytes({ kind: 'reset' }, pal)).toBeNull();
    const data = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
    expect(await coverBytes({ kind: 'image', data, url: 'blob:x' }, pal)).toBe(data);
  });
});
