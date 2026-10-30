/**
 * The command palette's index of the workspace's tools, island groups, workbench tabs and Settings
 * pages (UI revision W5). Pure: the caller resolves every name in the language in use and hands
 * in what each entry does, so the index is the same in a test as in the app. The tool list maps
 * one to one onto the tool registry's `ToolDef` (W8) once that lands.
 */
import { shortcutHint, t, type IconName, type PaletteCommand, type ShortcutId } from '@aio/ui';
import type { TabId } from '../workspace/workbench/tabsModel';

export interface PaletteTool {
  id: string;
  /** The tool's group, already in the language in use (`Measure`). */
  group: string;
  label: string;
  icon: IconName;
  shortcutId?: ShortcutId;
  keywords?: readonly string[];
  /** Listed either way; an unavailable tool shows why and does nothing on Enter. */
  available: true | { reason: string };
  start: () => void;
}

/** An island group with a workbench: "Measure tools" opens it. */
export interface PaletteGroup {
  id: string;
  label: string;
  icon: IconName;
  /** The workbench tab the group opens, so the tab is not listed twice. */
  tab: TabId | null;
  open: () => void;
}

export interface PaletteTab {
  id: TabId;
  label: string;
  open: () => void;
}

export interface PalettePage {
  id: string;
  label: string;
  open: () => void;
}

export interface PaletteIndexInput {
  tools: readonly PaletteTool[];
  /** The person's favourite then recent tool ids, first first: they win a near tie. */
  preferred?: readonly string[];
  groups: readonly PaletteGroup[];
  tabs: readonly PaletteTab[];
  settingsPages: readonly PalettePage[];
  /** How a shortcut reads (`M`); `shortcutHint` unless a test says otherwise. */
  shortcutLabel?: (id: ShortcutId) => string;
}

/**
 * Settings pages another command already reaches by name: "Processing tools (Settings)" has
 * kept its words and its first place for "pipeline pack" since before the pages were indexed.
 */
const PAGES_WITH_OWN_COMMAND: ReadonlySet<string> = new Set(['tools']);

/** The first preferred tool gets the whole boost, each next one a little less (rank.ts caps it at 1). */
const boostOf = (preferred: readonly string[], id: string): number => {
  const i = preferred.indexOf(id);
  return i < 0 ? 0 : Math.max(0, 1 - i * 0.1);
};

export function paletteIndex(input: PaletteIndexInput): PaletteCommand[] {
  const keyOf = input.shortcutLabel ?? ((id: ShortcutId) => shortcutHint(id));
  const preferred = input.preferred ?? [];
  const list: PaletteCommand[] = [];

  for (const tool of input.tools) {
    const shortcut = tool.shortcutId ? keyOf(tool.shortcutId) : '';
    const boost = boostOf(preferred, tool.id);
    const off = tool.available === true ? null : tool.available.reason;
    list.push({
      id: `tool:${tool.id}`,
      title: t('palette.tool', { group: tool.group, name: tool.label }),
      group: t('palette.group.tools'),
      icon: tool.icon,
      keywords: [...(tool.keywords ?? [])],
      ...(shortcut ? { shortcut } : {}),
      ...(boost > 0 ? { boost } : {}),
      ...(off !== null ? { hint: off, disabled: true } : {}),
      run: () => {
        if (off === null) tool.start();
      },
    });
  }

  const groupTabs = new Set<TabId>();
  for (const g of input.groups) {
    if (g.tab) groupTabs.add(g.tab);
    list.push({
      id: `group:${g.id}`,
      title: t('palette.toolGroup', { name: g.label }),
      group: t('palette.group.tools'),
      icon: g.icon,
      run: g.open,
    });
  }

  for (const tab of input.tabs) {
    if (groupTabs.has(tab.id)) continue;
    list.push({
      id: `tab:${tab.id}`,
      title: t('palette.tab', { name: tab.label }),
      group: t('palette.group.navigate'),
      icon: 'sidebar',
      run: tab.open,
    });
  }

  for (const page of input.settingsPages) {
    if (PAGES_WITH_OWN_COMMAND.has(page.id)) continue;
    list.push({
      id: `settings:${page.id}`,
      title: t('palette.settingsPage', { name: page.label }),
      group: t('palette.group.settings'),
      icon: 'settings',
      run: page.open,
    });
  }
  return list;
}
