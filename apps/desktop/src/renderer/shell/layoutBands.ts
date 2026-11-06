/**
 * The window's bands (UI revision W12, design D1): what the shell's regions do at 1440 px and up
 * (wide), 1280 to 1440 px (mid) and below 1280 px (narrow).
 *
 * - The Layers column (shell/LayersColumn.tsx) is open in the wide band, folded by default in the
 *   mid band, and below 1280 px an overlay over the stage that opens on a press and closes on
 *   Escape or a click on the stage. The person's own choice wins: folding it (Ctrl+B, Ctrl+L, the
 *   title bar's toggle, `sidebarCollapsed`) holds at every width, and a column reopened in the mid
 *   band stays open there (`sidebarReopened`, panelPrefs.ts). End-to-end runs pin the column open
 *   and docked (`window.aio.flags.autoFold` is false) unless a spec asks for the bands.
 * - The right panel has one width per band, dragged and remembered per band (workbench
 *   panelWidth.ts); below 1280 px it stays docked at 300 px and pushes the stage (founder, 30 Oct).
 * - The bottom strip's height per band (`--strip-h` on `.app`).
 *
 * The 52 px rail and its Processing group stay on every screen at every width.
 */

export type Band = 'wide' | 'mid' | 'narrow';

/** Window widths from here up are the wide band. */
export const WIDE_FROM = 1440;
/** Window widths from here up to the wide band are the mid band; below it, narrow. */
export const MID_FROM = 1280;

export interface BandDefaults {
  /** The Layers column opens with the window in this band. */
  layersOpen: boolean;
  /** The Layers column opens over the stage instead of beside it. */
  layersOverlay: boolean;
  /** The right panel's width before the person drags it, and its drag range. */
  rightPx: number;
  rightMin: number;
  rightMax: number;
  /** The bottom strip's height. */
  stripPx: number;
}

/** The D1 table. */
const BANDS: Readonly<Record<Band, BandDefaults>> = {
  wide: {
    layersOpen: true,
    layersOverlay: false,
    rightPx: 360,
    rightMin: 320,
    rightMax: 520,
    stripPx: 160,
  },
  mid: {
    layersOpen: false,
    layersOverlay: false,
    rightPx: 320,
    rightMin: 300,
    rightMax: 480,
    stripPx: 140,
  },
  // below 1280 the panel stays docked at 300 px (founder, 30 Oct): no narrower by a drag
  narrow: {
    layersOpen: false,
    layersOverlay: true,
    rightPx: 300,
    rightMin: 300,
    rightMax: 400,
    stripPx: 120,
  },
};

/** The band of a window width in CSS px. */
export function bandOf(width: number): Band {
  if (width >= WIDE_FROM) return 'wide';
  if (width >= MID_FROM) return 'mid';
  return 'narrow';
}

export function bandDefaults(band: Band): BandDefaults {
  return BANDS[band];
}

/**
 * The right panel's width at rest in a band: the width dragged in that band, held to its range,
 * else the band's default. Each band keeps its own, so a drag survives the window crossing into
 * another band and back. Expanded (a wide tool's "Expand panel"), it opens at the band's widest.
 */
export function restingPx(band: Band, saved: number | undefined, expanded = false): number {
  const b = BANDS[band];
  const min = expanded ? b.rightMax : b.rightMin;
  const px = saved !== undefined && saved > 0 ? saved : b.rightPx;
  return Math.round(Math.min(b.rightMax, Math.max(min, px)));
}

// `string & {}`: any screen name, with the data screens still offered by the editor
export type BandScreen = 'scene' | 'issues' | 'inspect' | 'reports' | (string & {});

/** The screens whose data gets the Layers column's room in a narrower window. */
const DATA_SCREENS: ReadonlySet<string> = new Set(['scene', 'issues', 'inspect', 'reports']);

export interface LayersState {
  /** The column shows (docked beside the stage, or over it). */
  shown: boolean;
  /** The column lies over the stage instead of taking a grid column. */
  overlay: boolean;
}

/** Where the Layers column stands for this window, screen and the person's choices. */
export function layersState(i: {
  setting: boolean; // settings.sidebarCollapsed (the person's choice)
  windowWidth: number;
  screen: BandScreen;
  autoFold: boolean; // window.aio.flags.autoFold
  reopened: boolean; // panelPrefs.sidebarReopened (opened by hand in the mid band)
  overlayOpen: boolean; // the narrow band's overlay, opened by hand this session
}): LayersState {
  if (!i.autoFold || !DATA_SCREENS.has(i.screen)) return { shown: !i.setting, overlay: false };
  const d = BANDS[bandOf(i.windowWidth)];
  if (d.layersOverlay) return { shown: i.overlayOpen, overlay: true };
  if (i.setting) return { shown: false, overlay: false };
  return { shown: d.layersOpen || i.reopened, overlay: false };
}
