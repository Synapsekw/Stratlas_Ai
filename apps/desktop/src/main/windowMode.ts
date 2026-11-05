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
 * The main window's size: 1440 x 900, or QUADRION_WINDOW_SIZE (`1100x700`) to try a small screen.
 * Never under the minimum, 1100 x 700. Windows then cuts the window to the screen it is on: no
 * taller than the screen's work area. That is how the CI runners' 1024 x 768 screens, where no
 * size is asked for, end with a window 1100 wide and about 720 high (CONTRIBUTING.md, "End to end
 * the way CI runs it"). `asked` says the size was set: main then grows the window back to it
 * (`outerSizeFor`), so a spec that asks for 1366 x 768 gets it on that screen too.
 */
export function windowSize(env: Record<string, string | undefined>): {
  width: number;
  height: number;
  asked: boolean;
} {
  const m = /^(\d+)x(\d+)$/.exec(env.QUADRION_WINDOW_SIZE?.trim() ?? '');
  if (!m) return { width: 1440, height: 900, asked: false };
  return {
    width: Math.max(1100, Number(m[1])),
    height: Math.max(700, Number(m[2])),
    asked: true,
  };
}

/**
 * The window size that gives the page (`content`) the size asked for, from the window's size now
 * (`outer`), or null when the page has it already. Windows cuts a new window to its screen, but
 * a window resized after it is made keeps the size; one wider than its screen then gains its
 * borders inside the page (16 x 8 px at scale 1), which this takes off again.
 */
export function outerSizeFor(
  asked: { width: number; height: number },
  content: readonly [number, number],
  outer: readonly [number, number],
): [number, number] | null {
  const dw = asked.width - content[0];
  const dh = asked.height - content[1];
  if (dw === 0 && dh === 0) return null;
  return [outer[0] + dw, outer[1] + dh];
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
