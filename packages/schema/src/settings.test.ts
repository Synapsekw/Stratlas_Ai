import { describe, expect, it } from 'vitest';
import { Settings } from './index';

const base = {
  cloudAi: false,
  theme: 'dark',
  sidebarCollapsed: false,
  dataRoot: 'D:/Data',
  routes: [],
};

describe('Settings.autoPrepareSurfaces', () => {
  it('autoPrepareSurfaces is optional', () => {
    const without = Settings.parse(base);
    expect(without.autoPrepareSurfaces).toBeUndefined();
    expect(Settings.parse({ ...base, autoPrepareSurfaces: false }).autoPrepareSurfaces).toBe(false);
    expect(Settings.parse({ ...base, autoPrepareSurfaces: true }).autoPrepareSurfaces).toBe(true);
    expect(Settings.safeParse({ ...base, autoPrepareSurfaces: 'yes' }).success).toBe(false);
  });
});
