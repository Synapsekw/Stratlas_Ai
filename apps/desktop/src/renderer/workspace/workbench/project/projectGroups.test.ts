import { describe, expect, it } from 'vitest';
import { projectKind } from '../../../builder/model';
import { orderGroups, projectCategory, type GroupId } from './projectGroups';

const all = (over: Partial<Record<GroupId, { count?: number; applies?: boolean }>> = {}) =>
  (['antennas', 'sectors', 'coverage', 'measurements', 'issues'] as const).map((id) => ({
    id,
    count: over[id]?.count ?? 0,
    applies: over[id]?.applies ?? true,
  }));

describe('orderGroups', () => {
  it('orders a telecom project: antennas, sectors, coverage, measurements, issues', () => {
    expect(orderGroups('telecom', all())).toEqual([
      'antennas',
      'sectors',
      'coverage',
      'measurements',
      'issues',
    ]);
  });

  it('orders a survey project and skips groups that are not built yet', () => {
    expect(orderGroups('survey', all())).toEqual(['measurements', 'issues']);
  });

  it('orders a construction project, skipping the unbuilt Changes and Photos', () => {
    expect(orderGroups('construction', all())).toEqual(['measurements', 'issues']);
  });

  it('puts a group outside the list at the end once it has items', () => {
    expect(orderGroups('default', all({ antennas: { count: 3 } }))).toEqual([
      'measurements',
      'issues',
      'antennas',
    ]);
    expect(orderGroups('default', all())).toEqual(['measurements', 'issues']);
  });

  it('vertical-asset shows Antennas only with antennas', () => {
    expect(orderGroups('vertical-asset', all())).toEqual(['issues', 'measurements']);
    expect(orderGroups('vertical-asset', all({ antennas: { count: 2 } }))).toEqual([
      'issues',
      'measurements',
      'antennas',
    ]);
  });

  it('leaves out a group that does not apply, even in its category', () => {
    expect(orderGroups('telecom', all({ sectors: { applies: false } }))).toEqual([
      'antennas',
      'coverage',
      'measurements',
      'issues',
    ]);
  });

  it('puts a group with items that the category does not name after the named ones', () => {
    expect(orderGroups('default', all({ sectors: { count: 1 } }))).toEqual([
      'measurements',
      'issues',
      'sectors',
    ]);
  });

  it('never shows the telecom groups in a survey or construction project, items or not', () => {
    const items = all({ antennas: { count: 3 }, sectors: { count: 2 }, coverage: { count: 1 } });
    expect(orderGroups('survey', items)).toEqual(['measurements', 'issues']);
    expect(orderGroups('construction', items)).toEqual(['measurements', 'issues']);
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
