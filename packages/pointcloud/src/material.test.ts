import { describe, expect, it } from 'vitest';
import { EdlPass, edlNeighbours } from './edl';
import { FLIGHT_PALETTE, MODE_INDEX, createPointMaterial } from './material';

describe('createPointMaterial', () => {
  it('compiles only the attributes the cloud has and clips with the shared planes', () => {
    const kit = createPointMaterial({
      hasRgb: false,
      hasIntensity: true,
      baseSize: 0.02,
      tint: '#ff0000',
    });
    expect(kit.defines).toEqual({ HAS_INTENSITY: '' });
    expect(kit.clipping).toBe(true);
    expect(kit.uniforms.uSize.value).toBe(0.02);
    expect(kit.uniforms.uTint.value.r).toBe(1);
    const png = createPointMaterial({
      hasRgb: true,
      hasIntensity: false,
      baseSize: 0.5,
      tint: '#000000',
    });
    expect(png.defines).toEqual({ HAS_RGB: '' });
  });

  it('maps every colour mode and keeps the HCl flight palette', () => {
    expect(Object.values(MODE_INDEX).sort()).toEqual([0, 1, 2, 3]);
    expect(FLIGHT_PALETTE[0]).toBe('#5ab0ff');
    expect(FLIGHT_PALETTE).toHaveLength(10);
  });
});

describe('EDL', () => {
  it('samples eight unit neighbours around the pixel', () => {
    const n = edlNeighbours();
    expect(n).toHaveLength(16);
    expect(n.slice(0, 2)).toEqual([1, 0]);
    for (let i = 0; i < 16; i += 2) expect(Math.hypot(n[i] ?? 0, n[i + 1] ?? 0)).toBeCloseTo(1, 5);
  });

  it('builds a non-pickable full-screen composite that writes depth', () => {
    const pass = new EdlPass(true);
    expect(pass.quad.frustumCulled).toBe(false);
    expect(pass.quad.material.depthWrite).toBe(true);
    expect(pass.quad.material.defines).toEqual({ LOG_DEPTH: '' });
    const hits: unknown[] = [];
    pass.quad.raycast({} as never, hits as never);
    expect(hits).toHaveLength(0);
    pass.dispose();
  });
});
