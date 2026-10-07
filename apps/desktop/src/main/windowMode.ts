/**
 * Where app windows appear. Automated tests and agent scripts run with an isolated profile
 * (QUADRION_USER_DATA); their windows open off-screen, without taking focus and without a
 * taskbar button, so they never flash on the person's desktop. Rendering, WebGL and screenshots
 * keep working. QUADRION_WINDOW=visible shows them (to watch a test); QUADRION_WINDOW=offscreen
 * forces off-screen for any profile.
 */
export type WindowMode = 'normal' | 'offscreen';

export function windowMode(env: Record<string, string | undefined>): WindowMode {
  if (env.QUADRION_WINDOW === 'visible') return 'normal';
  if (env.QUADRION_WINDOW === 'offscreen') return 'offscreen';
  return env.QUADRION_USER_DATA ? 'offscreen' : 'normal';
}

/**
 * The main window's size: 1440 x 900, or QUADRION_WINDOW_SIZE (`1100x700`) to try a small screen
 * (the CI runners' screens give the main window its minimum, 1100 x 700). Never under the minimum.
 */
export function windowSize(env: Record<string, string | undefined>): {
  width: number;
  height: number;
} {
  const m = /^(\d+)x(\d+)$/.exec(env.QUADRION_WINDOW_SIZE?.trim() ?? '');
  if (!m) return { width: 1440, height: 900 };
  return { width: Math.max(1100, Number(m[1])), height: Math.max(700, Number(m[2])) };
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Top-left corner for a window of `width` that lies fully left of every display. */
export function offscreenOrigin(
  displays: readonly Rect[],
  width: number,
): { x: number; y: number } {
  const left = displays.length ? Math.min(...displays.map((d) => d.x)) : 0;
  const top = displays.length ? Math.min(...displays.map((d) => d.y)) : 0;
  return { x: left - width - 400, y: top };
}

/**
 * Chromium switches that keep an off-screen window painting at full rate (Windows marks windows
 * outside every display as occluded and would otherwise stop rendering them).
 */
export const OFFSCREEN_SWITCHES: readonly [string, string?][] = [
  ['disable-features', 'CalculateNativeWinOcclusion'],
  ['disable-backgrounding-occluded-windows'],
  ['disable-renderer-backgrounding'],
];
