// Pure model of the right panel (UI revision D2): four fixed tabs, each a list of sections, and
// under them the workbench's old tab ids (stage island D11, D13-D15), which still say which body
// a tool brings forward. No React, no DOM: the panel renders what this decides.
import type { MessageKey } from '@aio/ui';

/** Every workbench tab, in no particular order (the row's order is decided below). */
export const TAB_IDS = [
  'measure',
  'display',
  'clouds',
  'volumes',
  'video',
  'road',
  'annotate',
  'jobs',
  'selection',
  'issues',
  'changes',
  'qa',
  'overlays',
  'hydro',
  'cleanup',
  // Engineering model review: source comparison, components and saved corrections.
  'review',
  // Road, Volumes and environment benches
  'environment',
  'cutaway',
  // RF coverage bench (rf-coverage T9): Tools > Coverage, with "Expand panel"
  'rf',
  // Thermal bench (thermal analysis M1): Tools > Thermal, with "Expand panel"
  'thermal',
] as const;

export type TabId = (typeof TAB_IDS)[number];

/** A known tab id: a remembered pin of a tab that is gone (the old Measurements list) is not. */
export function isTabId(x: unknown): x is TabId {
  return typeof x === 'string' && (TAB_IDS as readonly string[]).includes(x);
}

/**
 * One of the old tab ids as the store keeps it: live while its tool runs, `pinned` while it stays
 * shown when another tool panel opens (Coverage opened from its chip), `fixed` for the bodies that
 * are always there. None of it is a tab on screen any more: the four panel tabs are.
 */
export interface Tab {
  id: TabId;
  live: boolean;
  pinned: boolean;
  fixed: boolean;
}

export interface TabsState {
  tabs: Tab[];
  front: TabId;
  issueEditing: boolean;
  /** A tool tab waiting behind an issue edit (dot plus "Show it"); optional. */
  attention?: TabId | null;
}

export interface TabsChange {
  tabs: Tab[];
  front: TabId;
  /** A tab that wants a dot and a "Show it" action instead of taking the front. */
  attention: TabId | null;
}

/**
 * The live tabs of activities that are not a person's tool (rulings I-R39, I-R43, I-R62): a
 * playing clip and running jobs are live in the island and the sidebar, but open no drawer and
 * leave the agent as it is.
 */
export const ACTIVITIES: ReadonlySet<TabId> = new Set<TabId>(['jobs', 'video']);

/**
 * A tool the person started is live: a live tab other than playback and jobs. Read from the tabs,
 * never counted, so a follower mounted again cannot leave it out of step (I-R63).
 */
export function personToolLive(tabs: readonly Tab[]): boolean {
  return tabs.some((t) => t.live && !ACTIVITIES.has(t.id));
}

/**
 * A tool is in front of the person: the front tab is live, or is Coverage, Thermal or Jobs, or an
 * issue is being edited. Something that follows a pick in the 3D view leaves the front alone then.
 */
export function toolInFront(state: Pick<TabsState, 'tabs' | 'front' | 'issueEditing'>): boolean {
  if (state.issueEditing) return true;
  if (state.front === 'rf' || state.front === 'thermal' || state.front === 'jobs') return true;
  return state.tabs.some((t) => t.id === state.front && t.live);
}

/**
 * Fixed tabs sit at the end of the row in this order (D11); Project (id `measure`, the Measure
 * bench under an "In this project" list) is the first of them.
 */
const FIXED_ORDER: readonly TabId[] = ['measure', 'selection', 'issues', 'volumes', 'changes'];

const fixedRank = (id: TabId): number => {
  const i = FIXED_ORDER.indexOf(id);
  return i < 0 ? FIXED_ORDER.length : i;
};

/** Live tabs follow the island priority: a live tool, then playback, then jobs. */
const liveRank = (id: TabId): number => (id === 'jobs' ? 2 : id === 'video' ? 1 : 0);

const isUnpinnedPanel = (t: Tab): boolean => !t.fixed && !t.live && !t.pinned;

export function orderTabs(tabs: readonly Tab[]): Tab[] {
  const live = tabs.filter((t) => t.live).sort((a, b) => liveRank(a.id) - liveRank(b.id));
  const panels = tabs.filter((t) => !t.live && !t.fixed);
  const fixed = tabs
    .filter((t) => !t.live && t.fixed)
    .sort((a, b) => fixedRank(a.id) - fixedRank(b.id));
  return [...live, ...panels, ...fixed];
}

/** Opens a workbench (the caller sets the front; pinning a fixed tab is ignored) or tool panel. An unpinned panel replaces the previous unpinned one (D15). */
export function openPanel(tabs: readonly Tab[], id: TabId, { pinned }: { pinned: boolean }): Tab[] {
  const existing = tabs.find((t) => t.id === id);
  if (existing) {
    // Reopening never duplicates; asking to pin pins, but never unpins.
    return orderTabs(
      tabs.map((t) => (t.id === id && !t.fixed ? { ...t, pinned: t.pinned || pinned } : t)),
    );
  }
  const kept = tabs.filter((t) => !isUnpinnedPanel(t));
  return orderTabs([...kept, { id, live: false, pinned, fixed: false }]);
}

/** A tool starts: unpinned panels close, its tab goes live and takes the front unless an issue is edited (D14). */
export function onToolStart(state: TabsState, id: TabId): TabsChange {
  const kept = state.tabs.filter((t) => t.id === id || !isUnpinnedPanel(t));
  const tabs = kept.some((t) => t.id === id)
    ? kept.map((t) => (t.id === id ? { ...t, live: true } : t))
    : [...kept, { id, live: true, pinned: false, fixed: false }];
  const front = tabs.some((t) => t.id === state.front) ? state.front : 'selection';
  return state.issueEditing
    ? { tabs: orderTabs(tabs), front, attention: id }
    : { tabs: orderTabs(tabs), front: id, attention: null };
}

/**
 * A tool stops (D13). When the tool opened its tab, the tab closes and the front returns to
 * Selection (only if the stopped tab was in front); otherwise the bench stays, no longer live.
 */
export function onToolStop(
  state: TabsState,
  id: TabId,
  { openedByTool }: { openedByTool: boolean },
): TabsChange {
  const attention = state.attention === id ? null : (state.attention ?? null);
  const stopped = state.tabs.map((t) => (t.id === id ? { ...t, live: false } : t));
  if (!openedByTool) return { tabs: orderTabs(stopped), front: state.front, attention };
  const tabs = stopped.filter((t) => t.id !== id || t.fixed);
  return {
    tabs: orderTabs(tabs),
    front: state.front === id ? 'selection' : state.front,
    // another tool's pending dot stays
    attention,
  };
}

// ---------------------------------------------------------------- the four tabs (D2)

/** The right panel's tabs, in this order, always present: never pinned, closed or overflowed. */
export const PANEL_TABS = ['selection', 'tools', 'layers', 'project'] as const;
export type PanelTab = (typeof PANEL_TABS)[number];

export function isPanelTab(x: unknown): x is PanelTab {
  return typeof x === 'string' && (PANEL_TABS as readonly string[]).includes(x);
}

export const PANEL_TAB_LABEL: Readonly<Record<PanelTab, MessageKey>> = {
  selection: 'wb.panel.selection',
  tools: 'wb.panel.tools',
  layers: 'wb.panel.layers',
  project: 'wb.panel.project',
};

/** A section of a tab: `<tab>.<name>`. */
export type SectionId =
  | 'selection.selected'
  | 'tools.measure'
  | 'tools.annotate'
  | 'tools.pointcloud'
  | 'tools.terrain'
  | 'tools.checks'
  | 'tools.video'
  | 'tools.engineering'
  | 'tools.coverage'
  | 'tools.thermal'
  | 'tools.environment'
  | 'layers.display'
  | 'layers.clouds'
  | 'layers.overlays'
  | 'layers.cutaway'
  | 'project.inThisProject'
  | 'project.volumes'
  | 'project.changes'
  | 'project.issues'
  | 'project.road'
  | 'project.jobs';

/** What the project holds, as far as the panel's sections care (never the project type). */
export interface PanelData {
  pointcloud: boolean;
  /** A point cloud or mesh: a 3D model to review, cut or plan coverage on. */
  model3d: boolean;
  /** A point cloud, mesh or raster: a surface to measure terrain on. */
  surface: boolean;
  video: boolean;
  photos: boolean;
  /** Two or more survey dates to compare. */
  dated: boolean;
  /** Piles or the stockpile kit's volumes. */
  volumes: boolean;
  road: boolean;
}

export const NO_PANEL_DATA: PanelData = {
  pointcloud: false,
  model3d: false,
  surface: false,
  video: false,
  photos: false,
  dated: false,
  volumes: false,
  road: false,
};

export interface SectionDef {
  id: SectionId;
  label: MessageKey;
  /** The old tab id whose body the section shows; null: a body of its own. */
  body: TabId | null;
  /**
   * Shown when the project holds this data, or while its tool is open (its old tab is in the
   * store); absent: always. Never decided by the project type.
   */
  needs?: (d: PanelData) => boolean;
  /** A wide tool: its header offers "Expand panel". */
  wide?: true;
}

/** Every section, in its tab's order (a preset may lead with some of them later, W13). */
export const SECTIONS: readonly SectionDef[] = [
  { id: 'selection.selected', label: 'wb.panel.selection', body: 'selection' },
  { id: 'tools.measure', label: 'wb.sec.measure', body: 'measure' },
  { id: 'tools.annotate', label: 'wb.sec.annotate', body: 'annotate' },
  {
    id: 'tools.pointcloud',
    label: 'wb.sec.pointcloud',
    body: 'cleanup',
    needs: (d) => d.pointcloud,
  },
  { id: 'tools.terrain', label: 'wb.sec.terrain', body: 'hydro', needs: (d) => d.surface },
  { id: 'tools.checks', label: 'wb.sec.checks', body: 'qa', needs: (d) => d.surface },
  { id: 'tools.video', label: 'wb.sec.video', body: 'video', needs: (d) => d.video },
  {
    id: 'tools.engineering',
    label: 'wb.sec.engineering',
    body: 'review',
    needs: (d) => d.model3d,
  },
  {
    id: 'tools.coverage',
    label: 'wb.sec.coverage',
    body: 'rf',
    needs: (d) => d.model3d,
    wide: true,
  },
  {
    id: 'tools.thermal',
    label: 'wb.sec.thermal',
    body: 'thermal',
    needs: (d) => d.photos,
    wide: true,
  },
  { id: 'tools.environment', label: 'wb.sec.environment', body: 'environment' },
  { id: 'layers.display', label: 'wb.sec.display', body: 'display' },
  { id: 'layers.clouds', label: 'wb.sec.clouds', body: 'clouds', needs: (d) => d.pointcloud },
  { id: 'layers.overlays', label: 'wb.sec.overlays', body: 'overlays', needs: (d) => d.surface },
  { id: 'layers.cutaway', label: 'wb.sec.cutaway', body: 'cutaway', needs: (d) => d.model3d },
  { id: 'project.inThisProject', label: 'wb.sec.inThisProject', body: null },
  {
    id: 'project.volumes',
    label: 'wb.sec.volumes',
    body: 'volumes',
    needs: (d) => d.volumes,
    wide: true,
  },
  {
    id: 'project.changes',
    label: 'wb.sec.changes',
    body: 'changes',
    needs: (d) => d.dated,
    wide: true,
  },
  { id: 'project.issues', label: 'wb.sec.issues', body: 'issues' },
  { id: 'project.road', label: 'wb.sec.road', body: 'road', needs: (d) => d.road },
  { id: 'project.jobs', label: 'wb.sec.jobs', body: 'jobs' },
];

/** The tab a section sits in. */
export function tabOfSection(id: SectionId): PanelTab {
  return id.slice(0, id.indexOf('.')) as PanelTab;
}

export function sectionDef(id: SectionId): SectionDef | undefined {
  return SECTIONS.find((s) => s.id === id);
}

export function isSectionId(x: unknown): x is SectionId {
  return typeof x === 'string' && SECTIONS.some((s) => s.id === x);
}

/**
 * Where each of the 20 old tab ids lives now (the D2 table). Measure splits: its "In this project"
 * list is a Project section, its catalogue and live tool card are Tools > Measure, where the old id
 * leads. Road's defect register and condition are Project > Road.
 */
const OLD_HOME: Readonly<Record<TabId, SectionId>> = {
  selection: 'selection.selected',
  measure: 'tools.measure',
  annotate: 'tools.annotate',
  volumes: 'project.volumes',
  changes: 'project.changes',
  issues: 'project.issues',
  road: 'project.road',
  jobs: 'project.jobs',
  display: 'layers.display',
  clouds: 'layers.clouds',
  overlays: 'layers.overlays',
  cutaway: 'layers.cutaway',
  video: 'tools.video',
  qa: 'tools.checks',
  hydro: 'tools.terrain',
  cleanup: 'tools.pointcloud',
  review: 'tools.engineering',
  environment: 'tools.environment',
  rf: 'tools.coverage',
  thermal: 'tools.thermal',
};

/** The tab and section an old tab id lives in now (pure, the D2 table). */
export function sectionFor(old: TabId): { tab: PanelTab; section: SectionId } {
  const section = OLD_HOME[old];
  return { tab: tabOfSection(section), section };
}

/**
 * The sections a tab shows: those whose data the project holds, and those whose tool is open (its
 * old id in `opened`), in the tab's order.
 */
export function sectionsOf(
  tab: PanelTab,
  data: PanelData,
  opened: ReadonlySet<TabId> = new Set(),
): SectionDef[] {
  return SECTIONS.filter(
    (s) =>
      tabOfSection(s.id) === tab &&
      (s.needs === undefined || s.needs(data) || (s.body !== null && opened.has(s.body))),
  );
}

/** The body a tab brings forward when it is picked and none of its own is in front. */
export const TAB_FRONT: Readonly<Record<PanelTab, TabId>> = {
  selection: 'selection',
  tools: 'measure',
  layers: 'display',
  project: 'issues',
};

/** The sections open before the person chose (W13's presets decide this per project type). */
export const DEFAULT_OPEN: readonly SectionId[] = [
  'tools.measure',
  'layers.display',
  'project.inThisProject',
  'project.issues',
];

export interface PanelPlace {
  tab: PanelTab;
  open: Partial<Record<SectionId, boolean>>;
}

const defaultPlace = (): PanelPlace => ({
  tab: 'selection',
  open: Object.fromEntries(DEFAULT_OPEN.map((id) => [id, true])),
});

function parseObject(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * What the panel opens on, from what this computer remembers: the new key (`quadrion.panel`), or
 * once, the old workbench key (`quadrion.workbench`): its pins are dropped, and a front tab it
 * names lands on that tab's new home, open. Anything unreadable gives Selection.
 */
export function readPanelPlace(panelJson: string | null, oldJson: string | null): PanelPlace {
  const now = parseObject(panelJson);
  const place = defaultPlace();
  if (now) {
    if (isPanelTab(now.tab)) place.tab = now.tab;
    const open = now.open;
    if (open && typeof open === 'object') {
      place.open = {};
      for (const [id, on] of Object.entries(open as Record<string, unknown>)) {
        if (isSectionId(id) && typeof on === 'boolean') place.open[id] = on;
      }
    }
    return place;
  }
  const old = parseObject(oldJson);
  if (old && isTabId(old.front)) {
    const home = sectionFor(old.front);
    place.tab = home.tab;
    place.open[home.section] = true;
  }
  return place;
}
