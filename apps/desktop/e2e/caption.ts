/**
 * The window's own buttons in the e2e specs. The app has no title bar: on Windows the caption
 * buttons (`titleBarOverlay`) are drawn over its top rows, and on macOS the traffic lights. The
 * page cannot see them (`elementFromPoint` reaches the page under them), so specs measure where
 * they are from the window controls overlay, and what the app keeps clear for them.
 */
import type { Page } from '@playwright/test';

export interface CaptionArea {
  /** The part of the top rows the window's buttons leave free, in CSS px from the left. */
  free: { left: number; right: number };
  /** How far down the buttons reach. */
  height: number;
  /** The room the app keeps at the window's physical left and right (shell/caption.ts). */
  kept: { left: number; right: number };
}

/** Where the window's own buttons are, and the room the app keeps for them. */
export function captionArea(win: Page): Promise<CaptionArea> {
  return win.evaluate(() => {
    const app = document.querySelector('.app') ?? document.body;
    // the kept room is a calc() of the overlay's env() values: measure it on a probe
    const probe = (prop: string) => {
      const el = document.createElement('div');
      el.style.cssText = `position:fixed;top:0;left:0;height:0;width:var(${prop}, 0px)`;
      app.append(el);
      const w = el.getBoundingClientRect().width;
      el.remove();
      return w;
    };
    const overlay = (
      navigator as Navigator & {
        windowControlsOverlay?: {
          visible: boolean;
          getTitlebarAreaRect: () => DOMRect;
        };
      }
    ).windowControlsOverlay;
    const kept = { left: probe('--caption-left'), right: probe('--caption-right') };
    if (overlay?.visible) {
      const r = overlay.getTitlebarAreaRect();
      return { free: { left: r.x, right: r.x + r.width }, height: r.height, kept };
    }
    // no overlay (macOS, or no buttons drawn over the page): what the app keeps is all there is
    return {
      free: { left: kept.left, right: window.innerWidth - kept.right },
      height: 40,
      kept,
    };
  });
}
