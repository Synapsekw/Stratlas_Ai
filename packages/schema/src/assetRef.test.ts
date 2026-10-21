import { describe, expect, it } from 'vitest';
import { ImageGeom } from './annotation';
import { AssetRef, ProjectPath } from './common';

const BS = '\\';

describe('AssetRef path', () => {
  it.each([
    'photos/p1.jpg',
    `photos${BS}p1.jpg`,
    'models/a b.glb',
    './rasters/x/tiles.json',
    'a..b/c',
  ])('accepts %s inside the project', (path) => {
    expect(AssetRef.safeParse({ path }).success).toBe(true);
  });

  it.each([
    '../../.ssh/id_rsa',
    'photos/../../secret.txt',
    `photos${BS}..${BS}..${BS}secret.txt`,
    '/etc/passwd',
    `${BS}Windows${BS}win.ini`,
    `${BS}${BS}server${BS}share${BS}pic.png`,
    `C:${BS}Users${BS}me${BS}id_rsa`,
    'c:secret.txt',
    'photos/p1.jpg\u0000.png',
  ])('refuses %j, which leaves the project', (path) => {
    expect(AssetRef.safeParse({ path }).success).toBe(false);
  });

  it('refuses a mask outside the project in an image sighting', () => {
    const r = ImageGeom.safeParse({ type: 'mask', src: { path: '../../.ssh/id_rsa' } });
    expect(r.success).toBe(false);
  });

  it('ProjectPath refuses a NUL byte too', () => {
    expect(ProjectPath.safeParse('out/a\u0000b').success).toBe(false);
  });
});
