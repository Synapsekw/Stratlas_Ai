import { describe, expect, it } from 'vitest';
import { detectPackageKind } from './index';

describe('detectPackageKind', () => {
  it('detects a native package from manifest.json alone', () => {
    expect(detectPackageKind(['manifest.json'])).toBe('native');
    expect(detectPackageKind(['manifest.json', 'issues.json', 'models/tank.glb'])).toBe('native');
  });

  it('prefers native over other kinds when manifest.json is present', () => {
    expect(detectPackageKind(['manifest.json', 'layers.json', 'flights.json'])).toBe('native');
  });

  it('detects the HCl tank offline report', () => {
    expect(detectPackageKind(['HCl Tank 710-D-130335 - 3D Report.html', 'data/flight101.js'])).toBe(
      'aik',
    );
  });

  it('detects a volumetric review', () => {
    expect(detectPackageKind(['data/config.js', 'data/piles/P01.js'])).toBe('volumetric');
  });

  it('detects the road review', () => {
    expect(detectPackageKind(['ortho/index.json', 'data/defects.json'])).toBe('road');
  });

  it('detects the plant twin export', () => {
    expect(detectPackageKind(['layers.json', 'flights.json'])).toBe('twin');
  });

  it('returns null for an unrelated folder', () => {
    expect(detectPackageKind(['notes.txt'])).toBeNull();
  });
});
