/**
 * The right panel's one width per window band (UI revision D1): a default and a drag range for
 * each band, remembered per band in the split prefs (`scene.right.<band>`), and never changed by
 * opening a tab or a section. Only "Expand panel" (a wide tool, Coverage or Thermal) asks for
 * more, and only while it is pressed. W12 folds this into the shell's bands (`layoutBands.ts`).
 */
import { splitPrefs } from '@aio/ui';
import { useEffect, useState } from 'react';
import { useStore } from 'zustand';

export type PanelBand = 'wide' | 'mid' | 'narrow';

export interface RightBand {
  /** The width the panel opens at before the person drags it. */
  px: number;
  min: number;
  max: number;
}

/** The D1 table: below 1280 px the panel stays docked at 300 px and pushes the stage. */
export const RIGHT_BANDS: Readonly<Record<PanelBand, RightBand>> = {
  wide: { px: 360, min: 320, max: 520 },
  mid: { px: 320, min: 300, max: 480 },
  narrow: { px: 300, min: 280, max: 400 },
};

/** The band of a window width: 1440 px and up wide, 1280 to 1440 mid, below 1280 narrow. */
export function panelBandOf(width: number): PanelBand {
  if (width >= 1440) return 'wide';
  if (width >= 1280) return 'mid';
  return 'narrow';
}

/** The split prefs id that remembers the dragged width in this band. */
export const rightSplitId = (band: PanelBand): string => `scene.right.${band}`;

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
  const s = rightSplit(band, expanded);
  const px = saved !== undefined && saved > 0 ? saved : s.defaultSize;
  return Math.round(Math.min(s.max, Math.max(s.min, px)));
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
