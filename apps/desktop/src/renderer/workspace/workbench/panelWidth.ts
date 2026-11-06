/**
 * The right panel's one width per window band (UI revision D1): a default and a drag range for
 * each band, remembered per band in the split prefs (`scene.right.<band>`), and never changed by
 * opening a tab or a section. Only "Expand panel" (a wide tool, Coverage or Thermal) asks for
 * more, and only while it is pressed. The table itself is the shell's bands (shell/layoutBands.ts).
 */
import { splitPrefs, type SplitPrefsState } from '@aio/ui';
import { useEffect, useState } from 'react';
import { useStore } from 'zustand';
import type { StoreApi } from 'zustand/vanilla';
import { bandDefaults, bandOf, restingPx, type Band } from '../../shell/layoutBands';

export type PanelBand = Band;

export interface RightBand {
  /** The width the panel opens at before the person drags it. */
  px: number;
  min: number;
  max: number;
}

const rightBand = (band: PanelBand): RightBand => {
  const d = bandDefaults(band);
  return { px: d.rightPx, min: d.rightMin, max: d.rightMax };
};

/** The D1 table: below 1280 px the panel stays docked at 300 px and pushes the stage. */
export const RIGHT_BANDS: Readonly<Record<PanelBand, RightBand>> = {
  wide: rightBand('wide'),
  mid: rightBand('mid'),
  narrow: rightBand('narrow'),
};

/** The band of a window width: 1440 px and up wide, 1280 to 1440 mid, below 1280 narrow. */
export const panelBandOf: (width: number) => PanelBand = bandOf;

/** The split prefs id that remembers the dragged width in this band. */
export const rightSplitId = (band: PanelBand): string => `scene.right.${band}`;

/** The one width the panel had before the bands (`scene.right`, any window size). */
export const OLD_RIGHT_SPLIT_ID = 'scene.right';

/**
 * Carry a width dragged before the bands over once: into the wide band only (a window of 1440 px
 * and more, where it was most likely dragged), held to that band's range; the narrower bands keep
 * their fixed defaults. Nothing happens when the wide band has a width of its own already.
 */
export function migrateOldRightWidth(prefs: StoreApi<SplitPrefsState> = splitPrefs): void {
  const { byId } = prefs.getState();
  const old = byId[OLD_RIGHT_SPLIT_ID]?.size;
  const wide = rightSplitId('wide');
  if (old === undefined || !(old > 0) || byId[wide] !== undefined) return;
  const b = RIGHT_BANDS.wide;
  prefs.getState().save(wide, { size: Math.round(Math.min(b.max, Math.max(b.min, old))) });
}

export interface RightSplit {
  id: string;
  defaultSize: number;
  min: number;
  max: number;
}

/**
 * The split's options in a band (pure). Expanded, the minimum rises to the band's maximum, so the
 * panel opens that wide while it is pressed and goes back to the person's width after; nothing
 * else (a tab, a section, a tool) moves it.
 */
export function rightSplit(band: PanelBand, expanded: boolean): RightSplit {
  const b = RIGHT_BANDS[band];
  return { id: rightSplitId(band), defaultSize: b.px, min: expanded ? b.max : b.min, max: b.max };
}

/** The panel's width at rest in a band: the remembered drag inside the range, else the default. */
export function restingRightPx(
  band: PanelBand,
  saved: number | undefined,
  expanded: boolean,
): number {
  return restingPx(band, saved, expanded);
}

const windowWidth = (): number => (typeof window === 'undefined' ? 1440 : window.innerWidth);

/** The window's band, following resizes. */
export function usePanelBand(): PanelBand {
  const [band, setBand] = useState<PanelBand>(() => panelBandOf(windowWidth()));
  useEffect(() => {
    const onResize = () => {
      setBand(panelBandOf(windowWidth()));
    };
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
    };
  }, []);
  return band;
}

/** The panel's width at rest in the current band (the drawer matches it). */
export function useRestingRightPx(expanded: boolean): number {
  const band = usePanelBand();
  const saved = useStore(splitPrefs, (s) => s.byId[rightSplitId(band)]?.size);
  return restingRightPx(band, saved, expanded);
}
