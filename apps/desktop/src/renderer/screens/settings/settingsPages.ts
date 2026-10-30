/**
 * The pages of the Settings screen, grouped by topic (UI revision, design section 9), and where an
 * older deep link lands. Pure data: `screens/Settings.tsx` renders it, the store resolves a focus
 * target through it, and the command palette can index it.
 *
 * Page ids are stable: every id from before the reorganisation still names a page ("ai" is AI
 * providers, "tools" Processing tools, "maps" Offline maps, "privacy" Privacy and cloud). Sections
 * that moved are reached through a focus id instead (`detector-library`, `analytics-pack`,
 * `detection-models`, `geoid`, `project-privacy`, `project-maps`), which names both the page and
 * the section to bring into view.
 */
import type { IconName, MessageKey } from '@aio/ui';
import type { SettingsFocus, SettingsPage } from '../../store';

export type SettingsGroup = 'intelligence' | 'data' | 'app' | 'project';

export interface SettingsPageDef {
  id: SettingsPage;
  group: SettingsGroup;
  labelKey: MessageKey;
  icon: IconName;
}

/** In nav order. Each page has its own icon. */
export const SETTINGS_PAGES: readonly SettingsPageDef[] = [
  { id: 'ai', group: 'intelligence', labelKey: 'settings.page.ai', icon: 'agent' },
  {
    id: 'local-model',
    group: 'intelligence',
    labelKey: 'settings.page.localModel',
    icon: 'offline',
  },
  { id: 'models', group: 'intelligence', labelKey: 'settings.page.models', icon: 'target' },
  { id: 'usage', group: 'intelligence', labelKey: 'settings.page.usage', icon: 'history' },
  { id: 'privacy', group: 'intelligence', labelKey: 'settings.page.privacy', icon: 'shield' },
  { id: 'identity', group: 'data', labelKey: 'identity.page', icon: 'link' },
  { id: 'data', group: 'data', labelKey: 'settings.page.data', icon: 'folder' },
  { id: 'tools', group: 'data', labelKey: 'settings.page.tools', icon: 'download' },
  { id: 'maps', group: 'data', labelKey: 'settings.page.maps', icon: 'map' },
  { id: 'map-sources', group: 'data', labelKey: 'settings.page.mapSources', icon: 'globe' },
  { id: 'datums', group: 'data', labelKey: 'settings.page.datums', icon: 'ruler' },
  { id: 'severity', group: 'data', labelKey: 'settings.page.severity', icon: 'warn' },
  { id: 'classes', group: 'data', labelKey: 'settings.page.classes', icon: 'tag' },
  { id: 'branding', group: 'data', labelKey: 'settings.page.branding', icon: 'flag' },
  { id: 'graphics', group: 'app', labelKey: 'settings.page.graphics', icon: 'scene' },
  { id: 'appearance', group: 'app', labelKey: 'settings.page.appearance', icon: 'sun' },
  { id: 'keyboard', group: 'app', labelKey: 'settings.page.keyboard', icon: 'key' },
  { id: 'about', group: 'app', labelKey: 'settings.page.about', icon: 'refresh' },
  { id: 'project', group: 'project', labelKey: 'settings.page.project', icon: 'settings' },
];

export const SETTINGS_GROUP_LABEL: Record<SettingsGroup, MessageKey> = {
  intelligence: 'settings.group.intelligence',
  data: 'settings.group.data',
  app: 'settings.group.app',
  project: 'settings.group.project',
};

/** The pages the nav lists: "This project" only while a project is open. */
export function visibleSettingsPages(projectOpen: boolean): readonly SettingsPageDef[] {
  return SETTINGS_PAGES.filter((p) => projectOpen || p.group !== 'project');
}

/** The Settings page each focus target is on. */
export const FOCUS_PAGE: Record<SettingsFocus, SettingsPage> = {
  'anthropic-workspace': 'ai',
  'raster-packs': 'maps',
  'processing-engine': 'tools',
  'detection-models': 'models',
  'detector-library': 'models',
  'analytics-pack': 'models',
  geoid: 'datums',
  'project-privacy': 'project',
  'project-maps': 'maps',
};

/**
 * Focus ids whose section Settings itself brings into view (it wraps them in
 * `data-settings-focus`). The other focus ids are handled by their own section.
 */
export const SCROLL_FOCUS: ReadonlySet<SettingsFocus> = new Set<SettingsFocus>([
  'detection-models',
  'detector-library',
  'analytics-pack',
  'geoid',
  'project-privacy',
  'project-maps',
]);

const PAGE_IDS: ReadonlySet<string> = new Set(SETTINGS_PAGES.map((p) => p.id));

const isFocus = (s: string): s is SettingsFocus => Object.hasOwn(FOCUS_PAGE, s);

/**
 * Where a page id or a focus id lands: a page id names its page; a focus id names the page that
 * now holds its section, plus the focus. Anything else lands on AI providers, where Settings
 * opens.
 */
export function resolveSettingsTarget(pageOrFocus: string): {
  page: SettingsPage;
  focus?: SettingsFocus;
} {
  if (isFocus(pageOrFocus)) return { page: FOCUS_PAGE[pageOrFocus], focus: pageOrFocus };
  if (PAGE_IDS.has(pageOrFocus)) return { page: pageOrFocus as SettingsPage };
  return { page: 'ai' };
}
