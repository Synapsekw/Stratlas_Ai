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

/** What the operating system asks for (media queries), beside the colour scheme. */
export interface OsPreferences {
  /** `prefers-contrast: more` or Windows forced colours. */
  moreContrast?: boolean;
  /** `prefers-reduced-motion: reduce`. */
  reducedMotion?: boolean;
}

/** More contrast when Settings ask for it or the OS does. */
export function wantsMoreContrast(setting: Settings['contrast'], os: OsPreferences): boolean {
  return setting === 'more' || os.moreContrast === true;
}

/** Reduced motion when Settings ask for it or the OS does. */
export function wantsReducedMotion(setting: Settings['motion'], os: OsPreferences): boolean {
  return setting === 'reduce' || os.reducedMotion === true;
}

/**
 * Put the appearance on <html>: `data-theme` is always the resolved theme (CSS tokens and the map
 * read it), `data-theme-setting` the choice, `dir` the layout direction, `data-contrast='more'`
 * and `data-motion='reduce'` only while they apply (tokens.css, mission.css and the 3D and map
 * camera read them).
 */
export function applyAppearance(
  html: HtmlLike,
  s: Pick<Settings, 'theme' | 'direction' | 'contrast' | 'motion'>,
  prefersDark: boolean,
  os: OsPreferences = {},
): void {
  html.dataset.theme = resolveTheme(s.theme, prefersDark);
  html.dataset.themeSetting = s.theme;
  html.dir = s.direction ?? 'ltr';
  if (wantsMoreContrast(s.contrast, os)) html.dataset.contrast = 'more';
  else delete html.dataset.contrast;
  if (wantsReducedMotion(s.motion, os)) html.dataset.motion = 'reduce';
  else delete html.dataset.motion;
}

/** Media queries behind `OsPreferences`, for `matchMedia`. */
export const OS_QUERIES = {
  dark: '(prefers-color-scheme: dark)',
  moreContrast: '(prefers-contrast: more), (forced-colors: active)',
  reducedMotion: '(prefers-reduced-motion: reduce)',
} as const;
