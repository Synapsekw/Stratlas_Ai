import { describe, expect, it } from 'vitest';
import { EdlPass, edlNeighbours } from './edl';
import {
  FLIGHT_PALETTE,
  MODE_INDEX,
  applyChangeUniforms,
  createPointMaterial,
  pointSizePx,
} from './material';

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

  it('reads ASPRS classes when the cloud has them, with a colour and a show flag per class', () => {
    const copc = createPointMaterial({
      hasRgb: true,
      hasIntensity: true,
      hasClass: true,
      baseSize: 0.1,
      tint: '#000000',
    });
    expect(copc.defines).toEqual({ HAS_RGB: '', HAS_INTENSITY: '', HAS_CLASS: '' });
    expect(copc.uniforms.uClassColours.value).toHaveLength(32);
    expect(copc.uniforms.uClassShown.value).toHaveLength(32);
    expect(copc.uniforms.uClassShown.value.every((v: number) => v === 1)).toBe(true);
    expect(copc.vertexShader).toContain('uClassColours[');
  });

  it('maps every colour mode and keeps the HCl flight palette', () => {
    expect(Object.values(MODE_INDEX).sort()).toEqual([0, 1, 2, 3, 4, 5]);
    expect(MODE_INDEX.change).toBe(5);
    expect(FLIGHT_PALETTE[0]).toBe('#5ab0ff');
    expect(FLIGHT_PALETTE).toHaveLength(10);
  });
});

describe('the change colour mode', () => {
  const base = { hasRgb: false, hasIntensity: true, baseSize: 1, tint: '#000000' };

  it('reads the scalar attribute only when the cloud has one', () => {
    expect(createPointMaterial(base).defines).not.toHaveProperty('HAS_SCALAR');
    const change = createPointMaterial({ ...base, hasScalar: true });
    expect(change.defines).toHaveProperty('HAS_SCALAR', '');
    expect(change.vertexShader).toContain('attribute float aScalar');
    expect(change.vertexShader).toContain('changeRamp(');
  });

  it('starts with the founder far distance as range, nothing hidden and no divergence', () => {
    const m = createPointMaterial({ ...base, hasScalar: true });
    expect(m.uniforms.uScalarRange.value).toBe(0.3);
    expect(m.uniforms.uThreshold.value).toBe(0);
    expect(m.uniforms.uDiverging.value).toBe(0);
    expect(m.uniforms.uHideNoScalar.value).toBe(0);
  });

  it('applies the change uniforms of a layer', () => {
    const m = createPointMaterial({ ...base, hasScalar: true });
    applyChangeUniforms(m, { range: 0.5, threshold: 0.1, diverging: true, hideNoScalar: true });
    expect(m.uniforms.uScalarRange.value).toBe(0.5);
    expect(m.uniforms.uThreshold.value).toBe(0.1);
    expect(m.uniforms.uDiverging.value).toBe(1);
    expect(m.uniforms.uHideNoScalar.value).toBe(1);
  });
});

describe('point size on screen', () => {
  // a 2.5 cm kit point 60 m away at 1909 px per metre: 0.8 px, under the 1 px floor
  const far = (scale: number) => pointSizePx(0.025, 1909, 60, 1, 48, scale);
  // the same point 2 m away: 24 px, near the 48 px ceiling
  const near = (scale: number) => pointSizePx(0.025, 1909, 2, 1, 48, scale);

  it('scales the size after the pixel clamp, so the slider works at both ends', () => {
    expect([0.25, 1, 2, 4].map(far)).toEqual([1, 1, 2, 4]);
    expect(near(1)).toBeCloseTo(23.86, 2);
    expect(near(4)).toBeCloseTo(4 * near(1), 6);
    expect(near(0.25)).toBeCloseTo(near(1) / 4, 6);
  });

  it('is what the vertex shader computes, from a uniform shared by every depth material', () => {
    const m = createPointMaterial({ hasRgb: true, hasIntensity: false, baseSize: 1, tint: '#fff' });
    expect(m.uniforms.uScale.value).toBe(1);
    expect(m.vertexShader).toContain(
      'gl_PointSize = max(1.0, clamp(uSize * uPxPerM / max(0.01, -mvPosition.z), uMinPx, uMaxPx) * uScale);',
    );
  });
});

describe('EDL', () => {
  it('samples eight unit neighbours around the pixel', () => {
    const n = edlNeighbours();
    expect(n).toHaveLength(16);
    expect(n.slice(0, 2)).toEqual([1, 0]);
    for (let i = 0; i < 16; i += 2) expect(Math.hypot(n[i] ?? 0, n[i + 1] ?? 0)).toBeCloseTo(1, 5);
  });

  it('lists its cloud scene as offscreen content, so the perf HUD counts the clouds', () => {
    const pass = new EdlPass(false);
    expect(pass.quad.userData.offscreen).toEqual([pass.cloudScene]);
    pass.dispose();
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
