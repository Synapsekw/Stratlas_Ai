import { describe, expect, it } from 'vitest';
import { projectKind } from '../../../builder/model';
import { ALL_SETS, type ToolSet } from '../../../tools/toolSets';
import { CATEGORY_ORDER, orderGroups, projectCategory, type GroupId } from './projectGroups';

const all = (over: Partial<Record<GroupId, { count?: number; applies?: boolean }>> = {}) =>
  (['antennas', 'sectors', 'coverage', 'measurements', 'issues'] as const).map((id) => ({
    id,
    count: over[id]?.count ?? 0,
    applies: over[id]?.applies ?? true,
  }));

describe('orderGroups', () => {
  it('orders a telecom project: antennas, sectors, coverage, measurements, issues', () => {
    expect(orderGroups('telecom', all(), ALL_SETS)).toEqual([
      'antennas',
      'sectors',
      'coverage',
      'measurements',
      'issues',
    ]);
  });

  it('orders a survey project and skips groups that are not built yet', () => {
    expect(orderGroups('survey', all(), ALL_SETS)).toEqual(['measurements', 'issues']);
  });

  it('orders a construction project, skipping the unbuilt Changes and Photos', () => {
    expect(orderGroups('construction', all(), ALL_SETS)).toEqual(['measurements', 'issues']);
  });

  it('puts a group outside the list at the end once it has items', () => {
    expect(orderGroups('default', all({ antennas: { count: 3 } }), ALL_SETS)).toEqual([
      'measurements',
      'issues',
      'antennas',
    ]);
    expect(orderGroups('default', all(), ALL_SETS)).toEqual(['measurements', 'issues']);
  });

  it('vertical-asset shows Antennas only with antennas, after its own groups', () => {
    expect(orderGroups('vertical-asset', all(), ALL_SETS)).toEqual(['issues', 'measurements']);
    expect(orderGroups('vertical-asset', all({ antennas: { count: 2 } }), ALL_SETS)).toEqual([
      'issues',
      'measurements',
      'antennas',
    ]);
  });

  it('leaves out a group that does not apply, even in its category', () => {
    expect(orderGroups('telecom', all({ sectors: { applies: false } }), ALL_SETS)).toEqual([
      'antennas',
      'coverage',
      'measurements',
      'issues',
    ]);
  });

  it('puts a group with items that the category does not name after the named ones', () => {
    expect(orderGroups('default', all({ sectors: { count: 1 } }), ALL_SETS)).toEqual([
      'measurements',
      'issues',
      'sectors',
    ]);
  });

  it('shows the tower groups only where Telecom is part of the project', () => {
    const items = all({ antennas: { count: 3 }, sectors: { count: 2 }, coverage: { count: 1 } });
    const none = new Set<ToolSet>(['earthworks', 'road', 'thermal']);
    for (const category of ['telecom', 'survey', 'construction', 'default'] as const)
      expect(orderGroups(category, items, none), category).toEqual(['measurements', 'issues']);
    expect(orderGroups('telecom', all(), none)).toEqual(['measurements', 'issues']);
  });

  it('a survey that holds antennas lists them: its records bring Telecom', () => {
    const items = all({ antennas: { count: 3 }, sectors: { count: 2 }, coverage: { count: 1 } });
    const telecom = new Set<ToolSet>(['earthworks', 'telecom']);
    expect(orderGroups('survey', items, telecom)).toEqual([
      'measurements',
      'issues',
      'antennas',
      'sectors',
      'coverage',
    ]);
    expect(orderGroups('construction', items, telecom)).toContain('antennas');
  });
});

describe('the groups a category orders', () => {
  it('names no Stockpiles group: Project > Volumes is that list (the dead id is gone)', () => {
    const ordered = Object.values(CATEGORY_ORDER).flatMap((groups) => groups.map((g) => g.id));
    expect(ordered).not.toContain('stockpiles');
    expect(CATEGORY_ORDER.survey.map((g) => g.id)).toEqual(['measurements', 'issues']);
  });
});

describe('projectCategory', () => {
  const none = { kind: null, hasAntennas: false, hasRfPlan: false, hasVolumes: false };

  it('maps the four known purposes to themselves', () => {
    for (const kind of ['telecom', 'survey', 'construction', 'vertical-asset'] as const) {
      expect(projectCategory({ ...none, kind })).toBe(kind);
    }
  });

  it('maps another kind to the default', () => {
    expect(projectCategory({ ...none, kind: 'road' })).toBe('default');
    expect(projectCategory({ ...none, kind: 'confined-space', hasAntennas: true })).toBe('default');
  });

  it('lets a kind win over the contents', () => {
    expect(projectCategory({ ...none, kind: 'survey', hasAntennas: true })).toBe('survey');
  });

  it('takes the kind from an older type without a purpose: a volumetric project is a survey', () => {
    const kind = projectKind({ type: 'volumetric' });
    expect(projectCategory({ ...none, kind, hasAntennas: true, hasRfPlan: true })).toBe('survey');
  });

  it('lets the contents decide for an older inspection or twin, which says nothing more', () => {
    expect(projectCategory({ ...none, kind: 'inspection', hasAntennas: true })).toBe('telecom');
    expect(projectCategory({ ...none, kind: 'twin', hasVolumes: true })).toBe('survey');
  });

  it('with no kind, antennas or an RF plan make it telecom', () => {
    expect(projectCategory({ ...none, hasAntennas: true })).toBe('telecom');
    expect(projectCategory({ ...none, hasRfPlan: true, hasVolumes: true })).toBe('telecom');
  });

  it('with no kind, volumes make it a survey and nothing makes it the default', () => {
    expect(projectCategory({ ...none, hasVolumes: true })).toBe('survey');
    expect(projectCategory(none)).toBe('default');
  });
});
