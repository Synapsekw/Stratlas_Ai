import type { Settings, ThemeSetting } from '@aio/schema';

/** `system` follows the OS (prefers-color-scheme, which Electron ties to nativeTheme). */
export function resolveTheme(setting: ThemeSetting, prefersDark: boolean): 'dark' | 'light' {
  if (setting === 'system') return prefersDark ? 'dark' : 'light';
  return setting;
}

interface HtmlLike {
  dataset: Record<string, string | undefined>;
  dir: string;
}

/**
 * Put the appearance on <html>: `data-theme` is always the resolved theme (CSS tokens and the map
 * read it), `data-theme-setting` the choice, `dir` the layout direction.
 */
export function applyAppearance(
  html: HtmlLike,
  s: Pick<Settings, 'theme' | 'direction'>,
  prefersDark: boolean,
): void {
  html.dataset.theme = resolveTheme(s.theme, prefersDark);
  html.dataset.themeSetting = s.theme;
  html.dir = s.direction ?? 'ltr';
}
