/**
 * The room the window's own buttons take now that the app has no title bar (main/index.ts keeps
 * `titleBarStyle: 'hidden'`). On Windows the caption buttons drawn by `titleBarOverlay` (40 px
 * high) cover about 138 px at the top end; on macOS the traffic lights (`trafficLightPosition`)
 * cover about 72 px at the start of the left sidebar's top row. App.tsx writes these as
 * `--caption-end` and `--caption-start` on `.app`. Linux window controls are out of scope.
 */
export type CaptionPlatform = NodeJS.Platform | 'web';

export interface CaptionInset {
  inlineEnd: number;
  inlineStart: number;
}

export function captionInset(platform: CaptionPlatform): CaptionInset {
  if (platform === 'win32') return { inlineEnd: 138, inlineStart: 0 };
  if (platform === 'darwin') return { inlineEnd: 0, inlineStart: 72 };
  return { inlineEnd: 0, inlineStart: 0 };
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
