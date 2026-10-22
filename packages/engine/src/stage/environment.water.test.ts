import { Scene, type WebGLRenderer } from 'three';
import { describe, expect, it, vi } from 'vitest';
import type * as Water from './waterNormals';

const made = vi.hoisted(() => ({ count: 0 }));
vi.mock('./waterNormals', async (original) => {
  const real = await original<typeof Water>();
  return {
    waterNormalPixels: (size?: number, seed?: number) => {
      made.count += 1;
      return real.waterNormalPixels(size, seed);
    },
  };
});

const { Environment } = await import('./environment');

const renderer = {
  capabilities: { maxTextureSize: 4096, getMaxAnisotropy: () => 8 },
  toneMapping: 0,
  toneMappingExposure: 1,
} as unknown as WebGLRenderer;

describe('water normals', () => {
  // 64 to 80 ms of script on every return to the Scene screen (perf audit, 21 Oct)
  it('are made with the first water, once for every stage', () => {
    const a = new Environment(new Scene(), renderer);
    expect(made.count).toBe(0);
    a.setWater(0);
    a.setWater(null);
    a.setWater(1);
    const b = new Environment(new Scene(), renderer);
    b.setWater(0);
    expect(made.count).toBe(1);
    a.dispose();
    b.dispose();
  });
});
