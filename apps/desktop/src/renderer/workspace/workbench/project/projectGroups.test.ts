import { describe, expect, it } from 'vitest';
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
    expect(orderGroups('survey', all({ sectors: { count: 1 } }))).toEqual([
      'measurements',
      'issues',
      'sectors',
    ]);
  });
});

describe('projectCategory', () => {
  const none = { purpose: undefined, hasAntennas: false, hasRfPlan: false, hasVolumes: false };

  it('maps the four known purposes to themselves', () => {
    for (const purpose of ['telecom', 'survey', 'construction', 'vertical-asset'] as const) {
      expect(projectCategory({ ...none, purpose })).toBe(purpose);
    }
  });

  it('maps another purpose to the default', () => {
    expect(projectCategory({ ...none, purpose: 'road' })).toBe('default');
    expect(projectCategory({ ...none, purpose: 'confined-space', hasAntennas: true })).toBe(
      'default',
    );
  });

  it('lets a purpose win over the contents', () => {
    expect(projectCategory({ ...none, purpose: 'survey', hasAntennas: true })).toBe('survey');
  });

  it('with no purpose, antennas or an RF plan make it telecom', () => {
    expect(projectCategory({ ...none, hasAntennas: true })).toBe('telecom');
    expect(projectCategory({ ...none, hasRfPlan: true, hasVolumes: true })).toBe('telecom');
  });

  it('with no purpose, volumes make it a survey and nothing makes it the default', () => {
    expect(projectCategory({ ...none, hasVolumes: true })).toBe('survey');
    expect(projectCategory(none)).toBe('default');
  });
});
