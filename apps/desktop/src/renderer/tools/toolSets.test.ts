import { ProjectPurpose, ProjectType, ToolSet } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import {
  FAMILY_SET,
  GROUP_SET,
  inSets,
  MODE_SET,
  NOTHING_HELD,
  PROJECT_GROUP_SET,
  PURPOSE_SETS,
  SECTION_SET,
  switchesFor,
  toggled,
  toolSetsFor,
  type Held,
} from './toolSets';

const held = (...sets: ToolSet[]): Held => ({
  ...NOTHING_HELD,
  ...Object.fromEntries(sets.map((s) => [s, true])),
});
const of = (manifest: Parameters<typeof toolSetsFor>[0], h: Held = NOTHING_HELD) =>
  [...toolSetsFor(manifest, h)].sort();

describe('the sets a project type gives', () => {
  it('the table, one row per type', () => {
    expect(PURPOSE_SETS).toEqual({
      survey: ['earthworks'],
      construction: ['earthworks'],
      'vertical-asset': ['thermal'],
      'confined-space': [],
      'data-fusion': ['earthworks', 'road', 'telecom', 'thermal'],
      road: ['road'],
      telecom: ['telecom'],
    });
  });

  it('a project follows its type', () => {
    for (const purpose of ProjectPurpose.options)
      expect(of({ purpose })).toEqual([...PURPOSE_SETS[purpose]].sort());
  });

  it('a confined space project has no telecom tools', () => {
    expect(toolSetsFor({ purpose: 'confined-space' }, NOTHING_HELD).size).toBe(0);
  });

  it('an older project follows what its type stands for', () => {
    const byType: Record<ProjectType, ProjectPurpose> = {
      volumetric: 'survey',
      road: 'road',
      inspection: 'vertical-asset',
      fusion: 'data-fusion',
      twin: 'data-fusion',
    };
    for (const type of ProjectType.options)
      expect(of({ type })).toEqual([...PURPOSE_SETS[byType[type]]].sort());
  });

  it('a project with neither opens as a vertical asset; a type of a later build falls back', () => {
    expect(of({})).toEqual(['thermal']);
    expect(of({ purpose: 'tunnel', type: 'volumetric' })).toEqual(['earthworks']);
  });

  it('no project: nothing', () => {
    expect(of(null, held('telecom'))).toEqual([]);
  });
});

describe('records and switches', () => {
  it('the records a project holds bring their set, whatever the type', () => {
    for (const purpose of ProjectPurpose.options)
      for (const set of ToolSet.options)
        expect(toolSetsFor({ purpose }, held(set)).has(set)).toBe(true);
  });

  it('the list a person chose replaces the type table', () => {
    expect(of({ purpose: 'survey', toolSets: ['telecom'] })).toEqual(['telecom']);
    expect(of({ purpose: 'vertical-asset', toolSets: [] })).toEqual([]);
  });

  it('a set with records stays on though the list leaves it out', () => {
    expect(of({ purpose: 'survey', toolSets: [] }, held('telecom'))).toEqual(['telecom']);
  });

  it('the switches: on by type, by choice or by records, locked only by records', () => {
    expect(switchesFor({ purpose: 'vertical-asset' }, held('telecom'))).toEqual([
      { set: 'earthworks', on: false, locked: false },
      { set: 'road', on: false, locked: false },
      { set: 'telecom', on: true, locked: true },
      { set: 'thermal', on: true, locked: false },
    ]);
  });

  it('a switch saves the whole list: a set of the type can go off, a locked one cannot', () => {
    const m = { purpose: 'vertical-asset' };
    expect(toggled(m, NOTHING_HELD, 'telecom', true)).toEqual(['telecom', 'thermal']);
    expect(toggled(m, NOTHING_HELD, 'thermal', false)).toEqual([]);
    expect(toggled(m, held('thermal'), 'thermal', false)).toBeNull();
    expect(toggled(m, NOTHING_HELD, 'thermal', true)).toBeNull();
  });
});

describe('what belongs to which set', () => {
  const inSet = (table: Record<string, ToolSet | null>) =>
    Object.fromEntries(Object.entries(table).filter(([, set]) => set !== null));

  it('the tool groups: everything else is in every project', () => {
    expect(inSet(GROUP_SET)).toEqual({
      volumes: 'earthworks',
      checks: 'earthworks',
      road: 'road',
      coverage: 'telecom',
      thermal: 'thermal',
    });
    // founder, 18 Nov 2026: Terrain analysis and the engineering model are in every project
    expect(GROUP_SET.terrain).toBeNull();
    expect(GROUP_SET.engineering).toBeNull();
  });

  it('the right panel sections', () => {
    expect(inSet(SECTION_SET)).toEqual({
      'tools.volumes': 'earthworks',
      'tools.checks': 'earthworks',
      'layers.show': 'earthworks',
      'project.volumes': 'earthworks',
      'tools.road': 'road',
      'project.road': 'road',
      'tools.coverage': 'telecom',
      'tools.thermal': 'thermal',
    });
  });

  it('the measure families, the stage tools modes and the project list groups', () => {
    expect(inSet(FAMILY_SET)).toEqual({ telecom: 'telecom' });
    expect(inSet(MODE_SET)).toEqual({ volumes: 'earthworks', road: 'road' });
    expect(inSet(PROJECT_GROUP_SET)).toEqual({
      antennas: 'telecom',
      sectors: 'telecom',
      coverage: 'telecom',
      stockpiles: 'earthworks',
    });
  });

  it('a thing outside every set always passes; one in a set only with that set', () => {
    const sets = new Set<ToolSet>(['road']);
    expect(inSets(sets, null)).toBe(true);
    expect(inSets(sets, 'road')).toBe(true);
    expect(inSets(sets, 'telecom')).toBe(false);
  });
});
