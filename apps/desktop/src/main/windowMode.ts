/**
 * Where app windows appear. Automated tests and agent scripts run with an isolated profile
 * (STRATLAS_USER_DATA); their windows open off-screen, without taking focus and without a
 * taskbar button, so they never flash on the person's desktop. Rendering, WebGL and screenshots
 * keep working. STRATLAS_WINDOW=visible shows them (to watch a test); STRATLAS_WINDOW=offscreen
 * forces off-screen for any profile.
 */
export type WindowMode = 'normal' | 'offscreen';

export function windowMode(env: Record<string, string | undefined>): WindowMode {
  if (env.STRATLAS_WINDOW === 'visible') return 'normal';
  if (env.STRATLAS_WINDOW === 'offscreen') return 'offscreen';
  return env.STRATLAS_USER_DATA ? 'offscreen' : 'normal';
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
