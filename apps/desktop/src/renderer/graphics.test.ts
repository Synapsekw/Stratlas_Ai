import { createPointcloudSettings } from '@aio/pointcloud';
import { describe, expect, it } from 'vitest';
import {
  GPU_TIERS,
  PRESSURE_FLOOR_POINTS,
  createGraphics,
  detectGpuTier,
  detectTier,
  isIntegratedGpu,
  type GpuTier,
} from './graphics';

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

  // integrated and software graphics, as Chromium names them on Windows, macOS and Linux
  const D3D = 'Direct3D11 vs_5_0 ps_5_0, D3D11';
  const table: [string, GpuTier, boolean][] = [
    // [renderer, tier, integrated]
    [`ANGLE (Intel, Intel(R) UHD Graphics 630 (0x00003E92) ${D3D})`, 'low', true],
    [`ANGLE (Intel, Intel(R) Iris(R) Xe Graphics (0x00009A49) ${D3D})`, 'low', true],
    [`ANGLE (Intel, Intel(R) HD Graphics 520 ${D3D})`, 'low', true],
    [`ANGLE (Intel, Intel(R) Arc(TM) Graphics (0x00007D55) ${D3D})`, 'low', true],
    [`ANGLE (Intel, Intel(R) Arc(TM) 140V GPU (16GB) (0x000064A0) ${D3D})`, 'low', true],
    [`ANGLE (Intel, Intel(R) Arc(TM) B580 Graphics ${D3D})`, 'medium', false],
    [`ANGLE (AMD, AMD Radeon(TM) Vega 8 Graphics (0x000015D8) ${D3D})`, 'low', true],
    [`ANGLE (AMD, AMD Radeon 680M (0x00001681) ${D3D})`, 'low', true],
    [`ANGLE (AMD, AMD Radeon 780M Graphics (0x000015BF) ${D3D})`, 'low', true],
    [`ANGLE (AMD, AMD Radeon(TM) R5 Graphics ${D3D})`, 'low', true],
    [`ANGLE (AMD, Radeon RX Vega 56 ${D3D})`, 'medium', false],
    [`ANGLE (AMD, AMD Radeon Pro W6800 ${D3D})`, 'high', false],
    [`ANGLE (Qualcomm, Qualcomm(R) Adreno(TM) X1-85 GPU (0x36334330) ${D3D})`, 'low', true],
    [`ANGLE (Qualcomm, Qualcomm(R) Adreno(TM) 690 GPU ${D3D})`, 'low', true],
    ['ANGLE (Apple, ANGLE Metal Renderer: Apple M1, Unspecified Version)', 'medium', false],
    ['ANGLE (Apple, ANGLE Metal Renderer: Apple M2 Pro, Unspecified Version)', 'high', false],
    ['ANGLE (Apple, ANGLE Metal Renderer: Apple M4 Max, Unspecified Version)', 'high', false],
    [
      'ANGLE (Apple, ANGLE Metal Renderer: Apple Paravirtual device, Unspecified Version)',
      'low',
      true,
    ],
    [
      'ANGLE (Intel Inc., ANGLE Metal Renderer: Intel(R) Iris(TM) Plus Graphics 655, Unspecified Version)',
      'low',
      true,
    ],
    [
      'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)',
      'low',
      true,
    ],
    ['ANGLE (Mesa, llvmpipe (LLVM 17.0.6, 256 bits), OpenGL 4.5)', 'low', true],
    [`ANGLE (Microsoft, Microsoft Basic Render Driver ${D3D})`, 'low', true],
    [`ANGLE (NVIDIA, NVIDIA GeForce MX450 ${D3D})`, 'low', false],
    [`ANGLE (NVIDIA, NVIDIA GeForce GT 1030 ${D3D})`, 'low', false],
    [`ANGLE (NVIDIA, NVIDIA GeForce GTX 1060 6GB ${D3D})`, 'medium', false],
    [`ANGLE (AMD, AMD Radeon RX 6800 XT ${D3D})`, 'high', false],
  ];
  it.each(table)('%s is %s (integrated %s)', (renderer, tier, integrated) => {
    expect(detectGpuTier(renderer)).toBe(tier);
    expect(isIntegratedGpu(renderer)).toBe(integrated);
  });

  it('falls back to medium when the GPU is unknown or hidden', () => {
    expect(detectGpuTier(null)).toBe('medium');
    expect(detectGpuTier('Some future GPU')).toBe('medium');
  });
});

describe('detectTier', () => {
  const GB = 2 ** 30;
  const RTX = 'ANGLE (NVIDIA, NVIDIA GeForce RTX 5070 Ti Direct3D11 vs_5_0 ps_5_0, D3D11)';
  const UHD = 'ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)';
  const M1 = 'ANGLE (Apple, ANGLE Metal Renderer: Apple M1, Unspecified Version)';
  it.each([
    // [renderer, max texture, memory GiB, tier, limits]
    [RTX, 32768, 64, 'ultra', []],
    [RTX, 32768, null, 'ultra', []],
    [RTX, 32768, 15.7, 'ultra', []],
    [RTX, 32768, 7.8, 'medium', ['memory']],
    [RTX, 32768, 4, 'low', ['memory']],
    [UHD, 16384, 7.4, 'low', []],
    [M1, 16384, 8, 'medium', []],
    [RTX, 4096, 32, 'low', ['texture']],
    [null, null, 7.8, 'medium', []],
    [null, null, 3.5, 'low', ['memory']],
  ] as const)('%s, %s px, %s GiB is %s', (renderer, maxTextureSize, gib, tier, limits) => {
    const r = detectTier({
      renderer,
      maxTextureSize,
      systemMemory: gib === null ? null : gib * GB,
    });
    expect(r.tier).toBe(tier);
    expect(r.limits).toEqual(limits);
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

  it('cap memory more on lower tiers', () => {
    const order = ['low', 'medium', 'high', 'ultra'] as const;
    for (let i = 1; i < order.length; i++) {
      const a = GPU_TIERS[order[i - 1] ?? 'low'];
      const b = GPU_TIERS[order[i] ?? 'low'];
      expect(b.maxPointBudget).toBeGreaterThanOrEqual(a.maxPointBudget);
      expect(b.maxTextureSize).toBeGreaterThanOrEqual(a.maxTextureSize);
      expect(b.gpuBytes).toBeGreaterThan(a.gpuBytes);
      expect(b.rasterTiles).toBeGreaterThanOrEqual(a.rasterTiles);
    }
    for (const t of order)
      expect(GPU_TIERS[t].maxPointBudget).toBeGreaterThanOrEqual(GPU_TIERS[t].pointBudget);
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

describe('memory pressure', () => {
  it('steps down one tier per call, then to the point floor, and an override clears it', () => {
    const clouds = createPointcloudSettings(null);
    const g = createGraphics({ renderer: 'NVIDIA GeForce RTX 3060', storage: memory(), clouds });
    g.getState().apply();
    expect(g.getState().tier).toBe('high');
    expect(clouds.getState().budgetCap).toBe(GPU_TIERS.high.maxPointBudget);
    clouds.getState().setBudget(16_000_000);

    expect(g.getState().relieve('context-lost')).toBe(true);
    expect(g.getState().tier).toBe('medium');
    expect(g.getState().pressureReason).toBe('context-lost');
    expect(clouds.getState().budget).toBe(GPU_TIERS.medium.pointBudget);
    expect(clouds.getState().budgetCap).toBe(GPU_TIERS.medium.pointBudget);

    expect(g.getState().relieve('memory')).toBe(true);
    expect(g.getState().tier).toBe('low');
    expect(g.getState().relieve('memory')).toBe(true);
    expect(g.getState().tier).toBe('low');
    expect(clouds.getState().budgetCap).toBe(PRESSURE_FLOOR_POINTS);
    // at the floor: nothing left to give
    expect(g.getState().relieve('memory')).toBe(false);

    g.getState().dismissPressure();
    expect(g.getState().pressureReason).toBe(null);
    expect(g.getState().pressure).toBe(3);

    g.getState().setOverride('high');
    expect(g.getState().pressure).toBe(0);
    expect(g.getState().tier).toBe('high');
    expect(clouds.getState().budgetCap).toBe(GPU_TIERS.high.maxPointBudget);
  });

  it('keeps the override as the base and does not remember the step down', () => {
    const storage = memory();
    const clouds = createPointcloudSettings(null);
    const g = createGraphics({ renderer: 'Intel(R) UHD Graphics 620', storage, clouds });
    expect(g.getState().tier).toBe('low');
    g.getState().setOverride('ultra');
    g.getState().relieve('memory');
    expect(g.getState().tier).toBe('high');
    const again = createGraphics({ renderer: 'Intel(R) UHD Graphics 620', storage, clouds });
    expect(again.getState().tier).toBe('ultra');
    expect(again.getState().pressure).toBe(0);
  });
});
