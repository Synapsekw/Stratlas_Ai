import { describe, expect, it } from 'vitest';
import {
  THERMAL_HOTSPOTS_PACK_FEATURE,
  THERMAL_PACK_FEATURE,
  thermalPackRefusal,
} from './thermalPack';

describe('pack gate for thermal.decode', () => {
  it('requires processing tools 0.22.0 for thermal.decode only', () => {
    expect(thermalPackRefusal('thermal.decode', '0.20.3')).toBe(
      'Thermal analysis needs processing tools 0.22.0 or later (these are 0.20.3). Update them in Settings, Processing tools.',
    );
    expect(thermalPackRefusal('thermal.decode', '0.8.0')).toContain('(these are 0.8.0)');
    expect(thermalPackRefusal('thermal.decode', '0.22.0')).toBeNull();
    expect(thermalPackRefusal('thermal.decode', '0.22.1')).toBeNull();
    expect(thermalPackRefusal('thermal.decode', 'dev')).toBeNull();
    expect(thermalPackRefusal('thermal.decode', null)).toBeNull();
    expect(thermalPackRefusal('telecom.antennas', '0.10.0')).toBeNull();
  });
  it('requires processing tools 0.32.0 for thermal.hotspots', () => {
    expect(thermalPackRefusal('thermal.hotspots', '0.28.0')).toBe(
      'Thermal hot spots need processing tools 0.32.0 or later (these are 0.28.0). Update them in Settings, Processing tools.',
    );
    expect(thermalPackRefusal('thermal.hotspots', '0.22.0')).toContain('(these are 0.22.0)');
    expect(thermalPackRefusal('thermal.hotspots', '0.32.0')).toBeNull();
    expect(thermalPackRefusal('thermal.hotspots', 'dev')).toBeNull();
    expect(thermalPackRefusal('thermal.hotspots', null)).toBeNull();
    // decode keeps its own bar
    expect(thermalPackRefusal('thermal.decode', '0.28.0')).toBeNull();
  });
  it('lists the features for Settings, Processing tools', () => {
    expect(THERMAL_PACK_FEATURE).toEqual({ label: 'Thermal analysis', minVersion: '0.22.0' });
    expect(THERMAL_HOTSPOTS_PACK_FEATURE).toEqual({
      label: 'Thermal hot spots',
      minVersion: '0.32.0',
    });
  });
});
