import { describe, expect, it } from 'vitest';
import {
  isTabId,
  onToolStart,
  onToolStop,
  NO_PANEL_DATA,
  openPanel,
  orderTabs,
  PANEL_TABS,
  readPanelPlace,
  sectionDef,
  sectionFor,
  sectionsOf,
  SECTIONS,
  TAB_IDS,
  tabOfSection,
  toolInFront,
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
  tab('volumes', { fixed: true }),
  tab('changes', { fixed: true }),
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
    expect(next.tabs[0]).toMatchObject({ id: 'volumes', live: true, fixed: true });
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
    // the store never passes openedByTool for measure: the fixed tab stays, in front
    const stopped = onToolStop({ ...state, tabs: started.tabs }, 'measure', {
      openedByTool: false,
    });
    expect(stopped.front).toBe('measure');
    expect(ids(stopped.tabs)).toContain('measure');
    expect(ids(stopped.tabs).indexOf('measure')).toBe(ids(stopped.tabs).indexOf('selection') - 1);
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

describe('toolInFront', () => {
  const state = (front: TabId, over: Partial<Tab> = {}, issueEditing = false) => ({
    tabs: [
      ...[tab('measure', { fixed: true }), ...fixedTabs()].filter((t) => t.id !== front),
      tab(front, over),
    ],
    front,
    issueEditing,
  });
  it('is true for the Coverage, Thermal and Jobs tabs', () => {
    expect(toolInFront(state('rf'))).toBe(true);
    expect(toolInFront(state('thermal'))).toBe(true);
    expect(toolInFront(state('jobs'))).toBe(true);
  });
  it('is false for Selection and for Project at rest', () => {
    expect(toolInFront(state('selection', { fixed: true }))).toBe(false);
    expect(toolInFront(state('measure', { fixed: true }))).toBe(false);
  });
  it('is true while an issue is edited', () => {
    expect(toolInFront(state('selection', { fixed: true }, true))).toBe(true);
  });
  it('is true when the front tab is live', () => {
    expect(toolInFront(state('measure', { fixed: true, live: true }))).toBe(true);
  });
});

describe('the four panel tabs (D2)', () => {
  it('every one of the 20 old ids maps to a tab and section', () => {
    expect(TAB_IDS).toHaveLength(20);
    for (const id of TAB_IDS) {
      const { tab, section } = sectionFor(id);
      expect(PANEL_TABS).toContain(tab);
      expect(tabOfSection(section)).toBe(tab);
      expect(sectionDef(section)).toBeDefined();
    }
  });

  it('follows the D2 table for the moved homes', () => {
    expect(sectionFor('measure')).toEqual({ tab: 'tools', section: 'tools.measure' });
    expect(sectionFor('volumes')).toEqual({ tab: 'project', section: 'project.volumes' });
    expect(sectionFor('issues')).toEqual({ tab: 'project', section: 'project.issues' });
    expect(sectionFor('cutaway')).toEqual({ tab: 'layers', section: 'layers.cutaway' });
    expect(sectionFor('qa')).toEqual({ tab: 'tools', section: 'tools.checks' });
    expect(sectionFor('hydro')).toEqual({ tab: 'tools', section: 'tools.terrain' });
    expect(sectionFor('rf')).toEqual({ tab: 'tools', section: 'tools.coverage' });
    expect(sectionFor('selection')).toEqual({ tab: 'selection', section: 'selection.selected' });
  });

  it('every section body is shown by exactly one section', () => {
    const bodies = SECTIONS.map((s) => s.body).filter((b) => b !== null);
    expect(new Set(bodies).size).toBe(bodies.length);
  });

  it('shows a section for its data or its open tool, never for the project type', () => {
    const project = (d = NO_PANEL_DATA, opened = new Set<TabId>()) =>
      sectionsOf('project', d, opened).map((s) => s.id);
    expect(project()).toEqual([
      'project.inThisProject',
      'project.search',
      'project.issues',
      'project.jobs',
    ]);
    // the site digest first, with two survey dates or more
    expect(project({ ...NO_PANEL_DATA, volumes: true, dated: true, road: true })).toEqual([
      'project.digest',
      'project.inThisProject',
      'project.search',
      'project.volumes',
      'project.changes',
      'project.issues',
      'project.road',
      'project.jobs',
    ]);
    // a tool opened without its data (Coverage from its chip) still shows its section
    expect(sectionsOf('tools', NO_PANEL_DATA, new Set<TabId>(['rf'])).map((s) => s.id)).toContain(
      'tools.coverage',
    );
    expect(sectionsOf('tools', NO_PANEL_DATA).map((s) => s.id)).not.toContain('tools.coverage');
  });

  it('the flight lines row shows only with flight lines', () => {
    const layers = (d = NO_PANEL_DATA) => sectionsOf('layers', d).map((s) => s.id);
    expect(layers()).not.toContain('layers.flightlines');
    // after the display options, whatever the project type
    expect(layers({ ...NO_PANEL_DATA, flightlines: true })).toEqual([
      'layers.display',
      'layers.flightlines',
    ]);
    expect(sectionDef('layers.flightlines')?.label).toBe('wb.section.flightlines');
  });

  it('marks Coverage, Thermal, Volumes and Changes as wide (Expand panel), nothing else', () => {
    expect(SECTIONS.filter((s) => s.wide).map((s) => s.id)).toEqual([
      'tools.coverage',
      'tools.thermal',
      'project.volumes',
      'project.changes',
    ]);
  });
});

describe('readPanelPlace', () => {
  it('opens on Selection with the default sections when nothing is remembered', () => {
    const place = readPanelPlace(null, null);
    expect(place.tab).toBe('selection');
    expect(place.open['tools.measure']).toBe(true);
  });

  it('migrates the old front tab once and drops pins', () => {
    const old = JSON.stringify({ pinned: ['rf', 'display'], front: 'volumes' });
    const place = readPanelPlace(null, old);
    expect(place.tab).toBe('project');
    expect(place.open['project.volumes']).toBe(true);
    expect(JSON.stringify(place)).not.toContain('rf');
    // once the new key is there, the old one is not read again
    const now = JSON.stringify({ tab: 'layers', open: { 'layers.display': true } });
    expect(readPanelPlace(now, old)).toEqual({ tab: 'layers', open: { 'layers.display': true } });
  });

  it('pins alone land on Selection; junk is ignored', () => {
    expect(readPanelPlace(null, JSON.stringify({ pinned: ['rf'] })).tab).toBe('selection');
    expect(readPanelPlace('not json', '[1]').tab).toBe('selection');
    const odd = JSON.stringify({
      tab: 'nowhere',
      open: { 'tools.nothing': true, 'tools.measure': 1 },
    });
    expect(readPanelPlace(odd, null)).toEqual({ tab: 'selection', open: {} });
  });
});
