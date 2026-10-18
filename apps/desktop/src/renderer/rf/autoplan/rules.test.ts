import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { AntennaUnit, RfCatalogueEntry } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { rulesPick } from './rules';

const CATALOGUE = (
  JSON.parse(
    readFileSync(
      fileURLToPath(
        new URL('../../../../../../packages/rf/catalogue/generic.json', import.meta.url),
      ),
      'utf8',
    ),
  ) as { entries: RfCatalogueEntry[] }
).entries;

function measured(value: number) {
  return {
    value,
    basis: 'measured',
    quality: { basis: 'measured' },
  };
}

function unit(size: { widthM?: number; depthM?: number }): AntennaUnit {
  return {
    id: 'ant-1',
    name: 'A1',
    kind: 'panel',
    ...(size.widthM === undefined ? {} : { widthM: measured(size.widthM) }),
    ...(size.depthM === undefined ? {} : { depthM: measured(size.depthM) }),
  } as unknown as AntennaUnit;
}

function catalogueWithoutB3Radio(): RfCatalogueEntry[] {
  return CATALOGUE.map((e) =>
    e.kind === 'radio' && e.id === 'generic-rru-4t4r-4x40w'
      ? { ...e, bandRangeMhz: [3300, 3800] as [number, number] }
      : e,
  );
}

describe('rulesPick', () => {
  it('picks the n78 AAU for a deep wide face', () => {
    const p = rulesPick(unit({ widthM: 0.5, depthM: 0.2 }), CATALOGUE);
    expect(p.equipment).toEqual({ kind: 'aau', aau: 'generic-aau-64t64r-n78' });
    expect(p.carrier).toMatchObject({ band: 'n78', tech: 'nr', bandwidthMhz: 100 });
    expect(p).toMatchObject({ by: 'rules', confidence: 'medium' });
    expect(p.reason).toBe('0.50 m × 0.20 m deep face: AAU');
  });
  it('picks panel plus RRU on B3 for a thin face', () => {
    const p = rulesPick(unit({ widthM: 0.3, depthM: 0.1 }), CATALOGUE);
    expect(p.equipment).toEqual({
      kind: 'separate',
      antenna: 'generic-panel-65-17',
      radio: 'generic-rru-4t4r-4x40w',
    });
    expect(p.carrier).toMatchObject({ band: 'B3', tech: 'lte', bandwidthMhz: 20 });
    expect(p.confidence).toBe('medium');
  });
  it('falls back to the AAU rule with low confidence when the panel or radio cannot do B3', () => {
    const p = rulesPick(unit({ widthM: 0.3, depthM: 0.1 }), catalogueWithoutB3Radio());
    expect(p.equipment.kind).toBe('aau');
    expect(p.confidence).toBe('low');
  });
  it('treats missing measurements as a thin face with low confidence', () => {
    expect(rulesPick(unit({}), CATALOGUE).confidence).toBe('low');
    expect(rulesPick(unit({}), CATALOGUE).equipment.kind).toBe('separate');
  });
});
