// The renderable demo world for one survey date: ground textures, the stockyard surface, the
// asset, and a renderer lit by the demo sun. Used by the builder and by its frame workers.

import { Renderer } from './render.mjs';
import {
  SUN,
  YARD,
  buildAsset,
  groundMesh,
  sandAt,
  sandTextures,
  siteTexture,
  yardMesh,
  yardTexture,
} from './scene.mjs';

/**
 * @param {number} seed
 * @param {'e1' | 'e2'} epoch  the stockyard survey shown
 * @param {{ yardCell?: number, sand?: ReturnType<typeof sandTextures>, site?: import('./render.mjs').Texture }} [o]
 */
export function createWorld(seed, epoch, o = {}) {
  const sand = o.sand ?? sandTextures(seed);
  const site = o.site ?? siteTexture(sand, seed);
  const yard = yardTexture(sand, epoch, seed);
  const asset = buildAsset(seed);
  const parts = asset.parts.map((p) => p.arrays());
  // structures first: the depth test then rejects most ground pixels before they are written
  const items = [...parts, yardMesh(epoch, seed, o.yardCell ?? 0.5), groundMesh()];
  const ground = (x, z, foot, out) => {
    if (x >= YARD.x0 && x < YARD.x1 && z >= YARD.z0 && z < YARD.z1) yard.sample(x, z, foot, out);
    else if (site.contains(x, z)) site.sample(x, z, foot, out);
    else sandAt(sand, x, z, foot, out);
  };
  const renderer = new Renderer(items, {
    sun: SUN,
    ground,
    shadow: { x0: -72, z0: -72, x1: YARD.x1 + 8, z1: 72, size: 4096 },
  });
  return { sand, site, yard, asset, parts, renderer, ground };
}
