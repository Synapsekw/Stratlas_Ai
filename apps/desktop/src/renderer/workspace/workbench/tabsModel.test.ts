import { describe, expect, it } from 'vitest';
import {
  fitTabs,
  onToolStart,
  onToolStop,
  openPanel,
  orderTabs,
  paneWidth,
  type Tab,
  type TabId,
} from './tabsModel';

const tab = (id: TabId, over: Partial<Tab> = {}): Tab => ({
  id,
  live: false,
  pinned: false,
  fixed: false,
  ...over,
});
const fixedTabs = (): Tab[] => [
  tab('selection', { fixed: true }),
  tab('issues', { fixed: true }),
  tab('volumes', { fixed: true, minWidth: 470 }),
  tab('changes', { fixed: true, minWidth: 470 }),
];
const ids = (tabs: readonly Tab[]) => tabs.map((t) => t.id);

describe('orderTabs', () => {
  it('puts live tabs in island priority, then panels, then fixed tabs last', () => {
    const tabs = [
      ...fixedTabs(),
      tab('display'),
      tab('jobs', { live: true }),
      tab('video', { live: true }),
      tab('measure', { live: true }),
    ];
    expect(ids(orderTabs(tabs))).toEqual([
      'measure',
      'video',
      'jobs',
      'display',
      'selection',
      'issues',
      'volumes',
      'changes',
    ]);
  });

  it('keeps fixed tabs in their fixed order even when supplied shuffled', () => {
    const tabs = [
      tab('changes', { fixed: true }),
      tab('selection', { fixed: true }),
      tab('volumes', { fixed: true }),
    ];
    expect(ids(orderTabs(tabs))).toEqual(['selection', 'volumes', 'changes']);
  });
});

describe('openPanel', () => {
  it('keeps one unpinned panel when two are opened', () => {
    let tabs = fixedTabs();
    tabs = openPanel(tabs, 'display', { pinned: false });
    tabs = openPanel(tabs, 'clouds', { pinned: false });
    expect(ids(tabs).filter((i) => i === 'display' || i === 'clouds')).toEqual(['clouds']);
  });

  it('keeps pinned panels and does not duplicate a reopened one', () => {
    let tabs = openPanel(fixedTabs(), 'display', { pinned: true });
    tabs = openPanel(tabs, 'clouds', { pinned: false });
    tabs = openPanel(tabs, 'clouds', { pinned: false });
    expect(ids(tabs)).toEqual(['display', 'clouds', 'selection', 'issues', 'volumes', 'changes']);
  });

  it('pinning an open panel keeps it', () => {
    let tabs = openPanel(fixedTabs(), 'display', { pinned: false });
    tabs = openPanel(tabs, 'display', { pinned: true });
    tabs = openPanel(tabs, 'clouds', { pinned: false });
    expect(ids(tabs)).toContain('display');
  });

  it('does not add a second copy of a fixed tab', () => {
    const tabs = openPanel(fixedTabs(), 'volumes', { pinned: false });
    expect(ids(tabs).filter((i) => i === 'volumes')).toHaveLength(1);
  });
});

describe('onToolStart', () => {
  it('keeps pinned panels, closes unpinned ones and brings the tool tab to the front', () => {
    let tabs = openPanel(fixedTabs(), 'display', { pinned: true });
    tabs = openPanel(tabs, 'clouds', { pinned: false });
    const next = onToolStart({ tabs, front: 'selection', issueEditing: false }, 'measure');
    expect(ids(next.tabs)).toEqual([
      'measure',
      'display',
      'selection',
      'issues',
      'volumes',
      'changes',
    ]);
    expect(next.tabs[0]?.live).toBe(true);
    expect(next.front).toBe('measure');
    expect(next.attention).toBeNull();
  });

  it('follow never takes over an issue edit', () => {
    const next = onToolStart({ tabs: fixedTabs(), front: 'issues', issueEditing: true }, 'measure');
    expect(next.front).toBe('issues');
    expect(next.attention).toBe('measure');
    expect(next.tabs.find((t) => t.id === 'measure')?.live).toBe(true);
  });

  it('makes a fixed tab live in place', () => {
    const next = onToolStart(
      { tabs: fixedTabs(), front: 'selection', issueEditing: false },
      'volumes',
    );
    expect(next.tabs.filter((t) => t.id === 'volumes')).toHaveLength(1);
    expect(next.tabs[0]).toMatchObject({ id: 'volumes', live: true, fixed: true, minWidth: 470 });
  });
});

describe('onToolStop', () => {
  const running = () =>
    onToolStart({ tabs: fixedTabs(), front: 'selection', issueEditing: false }, 'measure');

  it('closes the tab and returns to selection when the tool opened it', () => {
    const s = running();
    const next = onToolStop({ tabs: s.tabs, front: s.front, issueEditing: false }, 'measure', {
      openedByTool: true,
    });
    expect(ids(next.tabs)).not.toContain('measure');
    expect(next.front).toBe('selection');
  });

  it('keeps the bench when the user had it open', () => {
    const s = running();
    const next = onToolStop({ tabs: s.tabs, front: s.front, issueEditing: false }, 'measure', {
      openedByTool: false,
    });
    expect(next.tabs.find((t) => t.id === 'measure')).toMatchObject({ live: false });
    expect(next.front).toBe('measure');
  });

  it('leaves another front tab alone, and keeps a fixed tab', () => {
    const tabs = onToolStart(
      { tabs: fixedTabs(), front: 'issues', issueEditing: true },
      'volumes',
    ).tabs;
    const next = onToolStop({ tabs, front: 'issues', issueEditing: true }, 'volumes', {
      openedByTool: true,
    });
    expect(next.front).toBe('issues');
    expect(next.tabs.find((t) => t.id === 'volumes')).toMatchObject({ live: false, fixed: true });
  });
});

describe('fitTabs', () => {
  const widths = new Map<TabId, number>(
    (['measure', 'display', 'selection', 'issues', 'volumes', 'changes'] as TabId[]).map((i) => [
      i,
      60,
    ]),
  );
  const ordered = orderTabs([...fixedTabs(), tab('display'), tab('measure', { live: true })]);

  it('shows everything when it fits', () => {
    const r = fitTabs(widths, ordered, 'measure', 400);
    expect(r.overflow).toEqual([]);
    expect(r.shown).toEqual(ids(ordered));
  });

  it('at 240 px keeps the live and front tabs and overflows fixed tabs first', () => {
    const r = fitTabs(widths, ordered, 'selection', 240);
    expect(r.shown).toEqual(['measure', 'display', 'selection', 'issues']);
    expect(r.overflow).toEqual(['volumes', 'changes']);
  });

  it('then overflows panels, keeping selection and live', () => {
    const r = fitTabs(widths, ordered, 'selection', 120);
    expect(r.shown).toEqual(['measure', 'selection']);
    expect(r.overflow).toEqual(['display', 'issues', 'volumes', 'changes']);
  });

  it('never overflows the front tab, even a fixed one', () => {
    const r = fitTabs(widths, ordered, 'changes', 120);
    expect(r.shown).toEqual(['measure', 'changes']);
  });

  it('drops selection before a live tab', () => {
    const r = fitTabs(widths, ordered, 'measure', 60);
    expect(r.shown).toEqual(['measure']);
  });
});

describe('paneWidth', () => {
  const volumes = tab('volumes', { fixed: true, minWidth: 470 });
  it('raises the preference to the tab minimum when there is room', () => {
    expect(paneWidth(360, volumes, 360, 1100 - 52)).toBe(470);
  });
  it('width clamps to keep the stage', () => {
    expect(paneWidth(360, volumes, 360, 1100 - 52 - 360)).toBe(328);
  });
  it('keeps the preference for tabs without a minimum', () => {
    expect(paneWidth(380, tab('selection', { fixed: true }), 360, 1200)).toBe(380);
  });
  it('never goes negative', () => {
    expect(paneWidth(380, volumes, 360, 200)).toBe(0);
  });
});
