// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { Tab, TabId } from './tabsModel';
import { visibleTabs } from './view';

const tab = (id: TabId): Tab => ({ id, live: false, pinned: false, fixed: true });
const ALL = (['selection', 'issues', 'volumes', 'changes', 'clouds', 'cleanup'] as const).map(tab);
const ids = (tabs: readonly Tab[]) => tabs.map((x) => x.id);

describe('visibleTabs', () => {
  it('leaves Volumes out without volumes and Changes out without two dates', () => {
    expect(ids(visibleTabs(ALL, { volumes: false, dated: false, clouds: true }))).toEqual([
      'selection',
      'issues',
      'clouds',
      'cleanup',
    ]);
  });

  it('leaves the cloud tabs out of a project without a point cloud', () => {
    expect(ids(visibleTabs(ALL, { volumes: true, dated: true, clouds: false }))).toEqual([
      'selection',
      'issues',
      'volumes',
      'changes',
    ]);
  });

  it('keeps every tab that applies', () => {
    expect(ids(visibleTabs(ALL, { volumes: true, dated: true, clouds: true }))).toEqual(ids(ALL));
  });
});
