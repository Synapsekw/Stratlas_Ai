import { Scene, type Mesh, type Object3D, type WebGLRenderer } from 'three';
import type * as Three from 'three';
import { describe, expect, it, vi } from 'vitest';

// A PMREM generator that works without WebGL: hands out a target and watches the meshes it lit.
const lit: { target: { disposed: boolean }; geometries: { disposed: boolean }[] }[] = [];
vi.mock('three', async (original) => {
  const three = await original<typeof Three>();
  return {
    ...three,
    PMREMGenerator: class {
      fromScene(scene: Object3D) {
        const target = new three.WebGLRenderTarget(4, 4);
        const entry = { target: { disposed: false }, geometries: [] as { disposed: boolean }[] };
        target.addEventListener('dispose', () => {
          entry.target.disposed = true;
        });
        scene.traverse((o) => {
          const g = (o as Partial<Mesh>).geometry;
          if (!g) return;
          const state = { disposed: false };
          g.addEventListener('dispose', () => {
            state.disposed = true;
          });
          entry.geometries.push(state);
        });
        lit.push(entry);
        return target;
      }
      dispose() {
        /* nothing held */
      }
    },
  };
});

const { Environment } = await import('./environment');

const renderer = {
  capabilities: { maxTextureSize: 4096, getMaxAnisotropy: () => 8 },
  toneMapping: 0,
  toneMappingExposure: 1,
} as unknown as WebGLRenderer;

describe('studio light', () => {
  // Soak, 8 Oct: one 768 x 1024 PMREM target and one sphere per stage outlived it.
  it('frees the sphere it was lit from at once, and its PMREM target with the environment', () => {
    lit.length = 0;
    const env = new Environment(new Scene(), renderer);
    const studio = lit[0];
    expect(studio?.geometries).toEqual([{ disposed: true }]);
    expect(studio?.target.disposed).toBe(false);
    env.dispose();
    expect(studio?.target.disposed).toBe(true);
  });
});
