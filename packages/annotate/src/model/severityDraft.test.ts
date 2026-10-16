import { describe, expect, it } from 'vitest';
import { generateSeverityModel, presetLevels, scalePresetName } from './severityDraft';

describe('generateSeverityModel', () => {
  it('builds a 1 to 3 scale with uncertain and a slug id', () => {
    const m = generateSeverityModel('  Coating condition ', '3');
    expect(m.id).toBe('coating-condition');
    expect(m.name).toBe('Coating condition');
    expect(m.levels.map((l) => l.value)).toEqual([1, 2, 3]);
    expect(m.levels.map((l) => l.label)).toEqual(['Minor', 'Moderate', 'Severe']);
    expect(m.uncertain?.label).toBe('Uncertain');
  });

  it('builds five grades and suffixes the id when the slug is taken', () => {
    const m = generateSeverityModel('Inspection 1 to 5', '5', new Set(['inspection-1-to-5']));
    expect(m.id).toBe('inspection-1-to-5-2');
    expect(m.levels).toHaveLength(5);
    expect(m.levels[0]?.label).toBe('Trace');
    expect(m.levels[4]?.label).toBe('Severe');
  });

  it('uses the preset name when the typed name is blank', () => {
    expect(generateSeverityModel('   ', '3').name).toBe(scalePresetName('3'));
    expect(presetLevels('5')).toHaveLength(5);
  });
});
