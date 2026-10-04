import { createPointcloudSettings } from '@aio/pointcloud';
import { describe, expect, it } from 'vitest';
import { GPU_TIERS, createGraphics, detectGpuTier } from './graphics';

function memory(): Storage {
  const m = new Map<string, string>();
  return {
    get length() {
      return m.size;
    },
    clear: () => {
      m.clear();
    },
    getItem: (k) => m.get(k) ?? null,
    key: (i) => [...m.keys()][i] ?? null,
    removeItem: (k) => m.delete(k),
    setItem: (k, v) => m.set(k, v),
  };
}

describe('detectGpuTier', () => {
  it.each([
    [
      'ANGLE (NVIDIA, NVIDIA GeForce RTX 5070 Ti (0x00002C05) Direct3D11 vs_5_0 ps_5_0, D3D11)',
      'ultra',
    ],
    ['ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 Direct3D11 vs_5_0 ps_5_0, D3D11)', 'ultra'],
    [
      'ANGLE (NVIDIA, NVIDIA GeForce RTX 4060 Laptop GPU Direct3D11 vs_5_0 ps_5_0, D3D11)',
      'medium',
    ],
    ['ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)', 'high'],
    ['ANGLE (NVIDIA, NVIDIA GeForce GTX 1650 Direct3D11 vs_5_0 ps_5_0, D3D11)', 'medium'],
    ['ANGLE (NVIDIA, NVIDIA RTX A5000 Direct3D11 vs_5_0 ps_5_0, D3D11)', 'ultra'],
    ['ANGLE (AMD, AMD Radeon RX 7900 XTX Direct3D11 vs_5_0 ps_5_0, D3D11)', 'ultra'],
    ['ANGLE (AMD, AMD Radeon RX 6600 Direct3D11 vs_5_0 ps_5_0, D3D11)', 'medium'],
    ['ANGLE (AMD, AMD Radeon(TM) Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)', 'low'],
    ['ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)', 'low'],
    ['ANGLE (Intel, Intel(R) Arc(TM) A770 Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)', 'medium'],
    ['ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)', 'low'],
    ['Apple M3 Max', 'high'],
    ['Apple M1', 'medium'],
  ])('%s is %s', (renderer, tier) => {
    expect(detectGpuTier(renderer)).toBe(tier);
  });

  it('falls back to medium when the GPU is unknown or hidden', () => {
    expect(detectGpuTier(null)).toBe('medium');
    expect(detectGpuTier('Some future GPU')).toBe('medium');
  });
});

describe('GPU tiers', () => {
  it('scale point budget, EDL, shadow map and pixel ratio from Low to Ultra', () => {
    const order = ['low', 'medium', 'high', 'ultra'] as const;
    for (let i = 1; i < order.length; i++) {
      const a = GPU_TIERS[order[i - 1] ?? 'low'];
      const b = GPU_TIERS[order[i] ?? 'low'];
      expect(b.pointBudget).toBeGreaterThan(a.pointBudget);
      expect(b.shadowMapSize).toBeGreaterThanOrEqual(a.shadowMapSize);
      expect(b.maxPixelRatio).toBeGreaterThanOrEqual(a.maxPixelRatio);
    }
    expect(GPU_TIERS.low.edl).toBe(false);
    expect(GPU_TIERS.ultra.edl).toBe(true);
  });
});

describe('graphics store', () => {
  it('uses the detected tier, applies its budget and EDL once, and remembers an override', () => {
    const storage = memory();
    const clouds = createPointcloudSettings(null);
    const g = createGraphics({ renderer: 'NVIDIA GeForce RTX 5070 Ti', storage, clouds });
    expect(g.getState().detected).toBe('ultra');
    expect(g.getState().tier).toBe('ultra');
    g.getState().apply();
    expect(clouds.getState().budget).toBe(GPU_TIERS.ultra.pointBudget);
    // a budget the person picks later survives a restart on the same tier
    clouds.getState().setBudget(4_000_000);
    createGraphics({ renderer: 'NVIDIA GeForce RTX 5070 Ti', storage, clouds }).getState().apply();
    expect(clouds.getState().budget).toBe(4_000_000);
    // choosing a preset in Settings applies it and is remembered
    g.getState().setOverride('low');
    expect(g.getState().tier).toBe('low');
    expect(clouds.getState().budget).toBe(GPU_TIERS.low.pointBudget);
    expect(clouds.getState().edl).toBe(false);
    const again = createGraphics({ renderer: 'NVIDIA GeForce RTX 5070 Ti', storage, clouds });
    expect(again.getState().override).toBe('low');
    expect(again.getState().tier).toBe('low');
    again.getState().setOverride(null);
    expect(again.getState().tier).toBe('ultra');
  });
});
