import { describe, expect, it } from 'vitest';
import {
  isTabId,
  onToolStart,
  onToolStop,
  openPanel,
  overflowOrderFor,
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

it('recognises model review as a normal closable workbench tab', () => {
  expect(isTabId('review')).toBe(true);
  expect(
    openPanel(fixedTabs(), 'review', { pinned: false }).find((t) => t.id === 'review'),
  ).toMatchObject({
    fixed: false,
    pinned: false,
  });
});

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

  it('does not leave front on a panel it just closed while an issue is edited', () => {
    const tabs = openPanel(fixedTabs(), 'display', { pinned: false });
    const next = onToolStart({ tabs, front: 'display', issueEditing: true }, 'measure');
    expect(next.front).toBe('selection');
    expect(next.attention).toBe('measure');
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

  it('clears a pending attention dot for the stopped tool only', () => {
    const tabs = onToolStart(
      { tabs: fixedTabs(), front: 'issues', issueEditing: true },
      'measure',
    ).tabs;
    const base = { tabs, front: 'issues' as TabId, issueEditing: true };
    expect(
      onToolStop({ ...base, attention: 'measure' }, 'measure', { openedByTool: true }).attention,
    ).toBeNull();
    expect(
      onToolStop({ ...base, attention: 'video' }, 'measure', { openedByTool: false }).attention,
    ).toBe('video');
  });

  it('closes a pinned panel the tool opened and keeps one it did not', () => {
    const tabs = [...fixedTabs(), tab('measure', { pinned: true, live: true })];
    const s = { tabs, front: 'measure' as TabId, issueEditing: false };
    expect(ids(onToolStop(s, 'measure', { openedByTool: true }).tabs)).not.toContain('measure');
    expect(ids(onToolStop(s, 'measure', { openedByTool: false }).tabs)).toContain('measure');
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

describe('overflowOrderFor', () => {
  // Tabs contract: higher value leaves first.
  const tabs = [
    ...fixedTabs(),
    tab('display'),
    tab('clouds', { pinned: true }),
    tab('measure', { live: true }),
    tab('video', { live: true }),
  ];
  const leaving = () => {
    const order = overflowOrderFor({ tabs });
    return tabs.map((t) => t.id).sort((a, b) => order(b) - order(a));
  };

  it('fixed leave first, then panels, then selection, live last', () => {
    expect(leaving()).toEqual([
      'changes',
      'volumes',
      'issues',
      'clouds',
      'display',
      'selection',
      'video',
      'measure',
    ]);
  });

  it('gives unknown ids 0', () => {
    expect(overflowOrderFor({ tabs })('hydro')).toBe(0);
  });

  it('never drops Project before a panel (it overflows with Selection)', () => {
    const withProject = [tab('measure', { fixed: true }), ...fixedTabs(), tab('display')];
    const order = overflowOrderFor({ tabs: withProject });
    const leaving = withProject.map((t) => t.id).sort((a, b) => order(b) - order(a));
    expect(leaving).toEqual(['changes', 'volumes', 'issues', 'display', 'selection', 'measure']);
  });
});

describe('the Project tab (id measure)', () => {
  it('keeps the Project tab first among the fixed tabs', () => {
    const tabs = [
      ...fixedTabs(),
      tab('measure', { fixed: true }),
      tab('display'),
      tab('jobs', { live: true }),
    ];
    expect(ids(orderTabs(tabs))).toEqual([
      'jobs',
      'display',
      'measure',
      'selection',
      'issues',
      'volumes',
      'changes',
    ]);
  });

  it('a live Project tab leads the row, and stays when its tool stops', () => {
    const state = {
      tabs: [tab('measure', { fixed: true }), ...fixedTabs()],
      front: 'measure' as TabId,
      issueEditing: false,
    };
    const started = onToolStart(state, 'measure');
    expect(ids(started.tabs)[0]).toBe('measure');
    const stopped = onToolStop({ ...state, tabs: started.tabs }, 'measure', { openedByTool: true });
    expect(ids(stopped.tabs)).toContain('measure');
    expect(ids(stopped.tabs).indexOf('measure')).toBe(ids(stopped.tabs).indexOf('selection') - 1);
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

describe('onToolStop attention', () => {
  it('keeps another tool pending dot when a tab the tool opened closes', () => {
    const tabs: Tab[] = [
      { id: 'measure', live: true, pinned: false, fixed: false },
      { id: 'issues', live: false, pinned: false, fixed: true },
    ];
    const out = onToolStop(
      { tabs, front: 'issues', issueEditing: true, attention: 'display' },
      'measure',
      { openedByTool: true },
    );
    expect(out.attention).toBe('display');
    const own = onToolStop(
      { tabs, front: 'issues', issueEditing: true, attention: 'measure' },
      'measure',
      { openedByTool: true },
    );
    expect(own.attention).toBeNull();
  });
});
