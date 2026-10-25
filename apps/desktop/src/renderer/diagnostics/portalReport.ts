import type { Screen, SettingsPage, StageMode } from '../store';

/** Where the person is, as the report form on quadrion.ai wants it: `scene:map`, `settings:privacy`, `projects`. */
export function screenId(s: {
  screen: Screen;
  stageMode: StageMode;
  settingsPage: SettingsPage | null;
}): string {
  if (s.screen === 'scene') return `scene:${s.stageMode}`;
  if (s.screen === 'settings') return s.settingsPage ? `settings:${s.settingsPage}` : 'settings';
  return s.screen;
}

// A colon is legal in a query string and keeps the screen id readable.
const part = (v: string) => encodeURIComponent(v).replace(/%3A/gi, ':');

/** The report form on the portal. The build and the screen are the only things that leave the app. */
export function portalReportUrl(version: string, screen: string): string {
  return `https://quadrion.ai/portal/report/?build=${part(version || 'unknown')}&screen=${part(screen)}`;
}
