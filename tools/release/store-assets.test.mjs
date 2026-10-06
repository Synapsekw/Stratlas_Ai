import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { root } from './icon-render.mjs';
import { appxFiles, LISTING_IMAGES } from './store-assets.mjs';

const appxDir = join(root, 'apps/desktop/build/appx');
const listingDir = join(root, 'docs/release/store-listing/images');

describe('MSIX assets', () => {
  it('follow Microsoft sizes for every scale', () => {
    const size = (file) => {
      const f = appxFiles().find((x) => x.file === file);
      return f && [f.w, f.h];
    };
    expect(size('Square44x44Logo.scale-200.png')).toEqual([88, 88]);
    expect(size('Square150x150Logo.scale-400.png')).toEqual([600, 600]);
    expect(size('Wide310x150Logo.scale-125.png')).toEqual([388, 188]);
    expect(size('SmallTile.scale-125.png')).toEqual([89, 89]);
    expect(size('StoreLogo.scale-150.png')).toEqual([75, 75]);
    expect(size('Square44x44Logo.targetsize-256_altform-unplated.png')).toEqual([256, 256]);
  });

  it('are committed with the planned pixel sizes and nothing unqualified', async () => {
    const files = appxFiles();
    expect(
      readdirSync(appxDir)
        .filter((f) => f.endsWith('.png'))
        .sort(),
    ).toEqual(files.map((f) => f.file).sort());
    for (const f of files) {
      const meta = await sharp(join(appxDir, f.file)).metadata();
      expect([f.file, meta.width, meta.height]).toEqual([f.file, f.w, f.h]);
    }
  });
});

describe('Store listing images', () => {
  it('exist at the sizes Partner Center asks for', async () => {
    for (const img of LISTING_IMAGES) {
      const file = join(listingDir, img.file);
      expect(existsSync(file), img.file).toBe(true);
      const meta = await sharp(file).metadata();
      expect([img.file, meta.width, meta.height]).toEqual([img.file, img.w, img.h]);
    }
  });
});
