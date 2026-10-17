/**
 * The room the window's own buttons take now that the app has no title bar (main/index.ts keeps
 * `titleBarStyle: 'hidden'`). On Windows the caption buttons drawn by `titleBarOverlay` (40 px
 * high) cover about 138 px at the window's right; on macOS the traffic lights
 * (`trafficLightPosition`) cover about 72 px at its left. The OS draws them on the same physical
 * side in either direction. App.tsx writes the room as `--caption-left` and `--caption-right` on
 * `.app`, and styles.css hands each to the component at that edge (`--caption-inline-start` and
 * `--caption-inline-end`, swapped right to left). Linux window controls are out of scope.
 */
export type CaptionPlatform = NodeJS.Platform | 'web';

export interface CaptionInset {
  /** px at the window's physical left. */
  left: number;
  /** px at the window's physical right. */
  right: number;
}

/** The room as fixed numbers: what the buttons take at the default zoom and caption size. */
export function captionInset(platform: CaptionPlatform): CaptionInset {
  if (platform === 'win32') return { left: 0, right: 138 };
  if (platform === 'darwin') return { left: 72, right: 0 };
  return { left: 0, right: 0 };
}

/**
 * The room as CSS: where the window draws its controls overlay, its `env(titlebar-area-*)` values
 * track the real buttons (page zoom, another caption width; gate/gate.css does the same), and the
 * fixed numbers stand in where it does not. Elsewhere no room is kept.
 */
export function captionVars(
  platform: CaptionPlatform,
): Record<'--caption-left' | '--caption-right', string> {
  if (platform !== 'win32' && platform !== 'darwin')
    return { '--caption-left': '0px', '--caption-right': '0px' };
  const { left, right } = captionInset(platform);
  const x = `env(titlebar-area-x, ${String(left)}px)`;
  const width = `env(titlebar-area-width, calc(100vw - ${String(left + right)}px))`;
  return { '--caption-left': x, '--caption-right': `calc(100vw - ${x} - ${width})` };
}

/**
 * The width of the icon rail the left sidebar folds to: 52 px (tokens.css `--sb-w-c`), and 76 px
 * on macOS, where the rail's top holds the traffic lights (x 16 to about 70) with a margin.
 */
export function railWidth(platform: CaptionPlatform): number {
  return platform === 'darwin' ? 76 : 52;
}

/**
 * The platform from the renderer's `navigator.platform` ("Win32", "MacIntel", "Linux x86_64");
 * without the desktop bridge (a browser, unit tests) there are no window buttons: `web`.
 */
export function platformOf(navPlatform: string, desktop: boolean): CaptionPlatform {
  if (!desktop) return 'web';
  const p = navPlatform.toLowerCase();
  if (p.startsWith('win')) return 'win32';
  if (p.startsWith('mac')) return 'darwin';
  if (p.includes('linux')) return 'linux';
  return 'web';
}

/** The platform this renderer runs on. */
export function rendererPlatform(): CaptionPlatform {
  if (typeof window === 'undefined') return 'web';
  return platformOf(navigator.platform, 'aio' in window);
}
