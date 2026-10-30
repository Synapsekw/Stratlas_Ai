import { en } from '@aio/ui/i18n/en';
import { describe, expect, it } from 'vitest';
import {
  FOCUS_PAGE,
  resolveSettingsTarget,
  SCROLL_FOCUS,
  SETTINGS_GROUP_LABEL,
  SETTINGS_PAGES,
  visibleSettingsPages,
} from './settingsPages';

describe('Settings pages', () => {
  it('every page has a distinct icon', () => {
    const icons = SETTINGS_PAGES.map((p) => p.icon);
    expect(new Set(icons).size).toBe(icons.length);
  });

  it('every page id is listed once, with an English label', () => {
    const ids = SETTINGS_PAGES.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    const catalogue: Record<string, string> = en;
    for (const p of SETTINGS_PAGES) expect(catalogue[p.labelKey]).toBeTruthy();
    for (const k of Object.values(SETTINGS_GROUP_LABEL)) expect(catalogue[k]).toBeTruthy();
  });

  it('pages of one group sit together in the nav', () => {
    const groups = SETTINGS_PAGES.map((p) => p.group).filter(
      (g, i, all) => i === 0 || all[i - 1] !== g,
    );
    expect(groups).toEqual(['intelligence', 'data', 'app', 'project']);
  });

  it('old tools with focus analytics-pack resolves to Models and detection', () => {
    expect(resolveSettingsTarget('analytics-pack')).toEqual({
      page: 'models',
      focus: 'analytics-pack',
    });
    expect(resolveSettingsTarget('detector-library').page).toBe('models');
    expect(resolveSettingsTarget('detection-models').page).toBe('models');
  });

  it('old maps with focus geoid resolves to Datums', () => {
    expect(resolveSettingsTarget('geoid')).toEqual({ page: 'datums', focus: 'geoid' });
  });

  it('project privacy resolves to Project settings, project maps stay on Offline maps', () => {
    expect(resolveSettingsTarget('project-privacy').page).toBe('project');
    expect(resolveSettingsTarget('project-maps').page).toBe('maps');
  });

  it('old page ids keep naming their page, and unknown ids land on AI providers', () => {
    for (const id of ['ai', 'tools', 'maps', 'privacy', 'usage', 'map-sources', 'about'])
      expect(resolveSettingsTarget(id)).toEqual({ page: id });
    expect(resolveSettingsTarget('nonsense')).toEqual({ page: 'ai' });
  });

  it('every focus lands on a listed page', () => {
    const ids = new Set(SETTINGS_PAGES.map((p) => p.id));
    for (const page of Object.values(FOCUS_PAGE)) expect(ids.has(page)).toBe(true);
    for (const f of SCROLL_FOCUS) expect(FOCUS_PAGE[f]).toBeDefined();
  });

  it('project group only with a project open', () => {
    expect(visibleSettingsPages(false).some((p) => p.group === 'project')).toBe(false);
    expect(visibleSettingsPages(true).map((p) => p.id)).toContain('project');
    expect(visibleSettingsPages(false)).toHaveLength(SETTINGS_PAGES.length - 1);
  });
});
