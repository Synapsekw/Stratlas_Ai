import type { HTMLAttributes, ReactElement, ReactNode, RefObject } from 'react';
import { createStore, type StoreApi } from 'zustand/vanilla';

export const SPLIT_STEP = 16;
export const SPLIT_STEP_BIG = 64;
export const SNAP_MARGIN = 48;

export interface SplitLimits {
  min: number; // sized pane, px
  max: number | `${number}%`; // sized pane
  otherMin: number; // the other pane, px
}

export interface SplitPref {
  size: number;
  collapsed?: boolean;
}

export interface SplitOptions extends SplitLimits {
  id: string; // prefs key, e.g. 'media.viewer'
  orientation: 'horizontal' | 'vertical'; // horizontal: side by side, col-resize
  sized: 'start' | 'end'; // which pane carries the size
  unit: 'px' | 'fraction';
  defaultSize: number; // px, or 0..1 for fraction
  collapsedSize?: number; // 12 (strip) or 52 (rail); absent: not collapsible
  collapsed?: boolean; // controlled collapse (shortcuts keep working)
  onCollapsedChange?: (collapsed: boolean) => void;
}

export interface ResizableSplitProps extends SplitOptions {
  label: string; // the separator's accessible name, e.g. "Resize the library"
  start: ReactNode;
  end: ReactNode;
  className?: string;
}

export interface SplitPrefsState {
  byId: Record<string, SplitPref>;
  save(id: string, pref: SplitPref): void;
}

/** Stub: built in the resizable split task. */
export const clampSplit: (size: number, container: number, l: SplitLimits) => number = () => {
  throw new Error('not built');
};

/** Stub: built in the resizable split task. */
export const splitPrefs: StoreApi<SplitPrefsState> = createStore<SplitPrefsState>(() => ({
  byId: {},
  save() {
    throw new Error('not built');
  },
}));

export interface ResizableSplitState {
  containerRef: RefObject<HTMLDivElement | null>;
  separatorProps: HTMLAttributes<HTMLDivElement> & { role: 'separator' };
  collapsed: boolean;
  reset(): void;
  toggle(): void;
}

/** Stub: built in the resizable split task. */
export const useResizableSplit: (o: SplitOptions) => ResizableSplitState = () => {
  throw new Error('not built');
};

/** Stub: built in the resizable split task. */
export const ResizableSplit: (p: ResizableSplitProps) => ReactElement = () => {
  throw new Error('not built');
};
