/**
 * One hover and pin shared by every profile chart and the line it was drawn along (spec section 4):
 * the chart, the 3D view and the Map read and write the same point, so hovering any of them moves
 * the marker in all three. Lines register while their chart is on screen.
 */
import type { ChartSeries } from '@aio/survey';
import { useStore } from 'zustand';
import { createStore, type StoreApi } from 'zustand/vanilla';

export interface HoverLine {
  /** 'measure:<id>' | 'pile:<id>' | 'section' | 'kit-section' */
  key: string;
  /** Site E, N. */
  polyline: readonly (readonly [number, number])[];
  /** The chart's shown series, oldest first. */
  series: readonly ChartSeries[];
}

export interface HoverPoint {
  key: string;
  chainageM: number;
  source: 'chart' | '3d' | 'map';
}

export interface LinkedHoverState {
  lines: ReadonlyMap<string, HoverLine>;
  hover: HoverPoint | null;
  pin: HoverPoint | null;
  fly: { key: string; chainageM: number; nonce: number } | null;
  /** Returns the unregister; a stale one leaves a line registered again under the same key. */
  register(line: HoverLine): () => void;
  setHover(p: HoverPoint | null): void;
  /** null clears. */
  setPin(p: HoverPoint | null): void;
  flyTo(key: string, chainageM: number): void;
}

export function createLinkedHoverStore(): StoreApi<LinkedHoverState> {
  let nonce = 0;
  return createStore<LinkedHoverState>()((set, get) => ({
    lines: new Map(),
    hover: null,
    pin: null,
    fly: null,
    register: (line) => {
      set((s) => ({ lines: new Map(s.lines).set(line.key, line) }));
      return () => {
        if (get().lines.get(line.key) !== line) return;
        set((s) => {
          const lines = new Map(s.lines);
          lines.delete(line.key);
          return {
            lines,
            hover: s.hover?.key === line.key ? null : s.hover,
            pin: s.pin?.key === line.key ? null : s.pin,
            fly: s.fly?.key === line.key ? null : s.fly,
          };
        });
      };
    },
    setHover: (p) => {
      set({ hover: p });
    },
    setPin: (p) => {
      set({ pin: p });
    },
    flyTo: (key, chainageM) => {
      nonce += 1;
      set({ fly: { key, chainageM, nonce } });
    },
  }));
}

export const linkedHover: StoreApi<LinkedHoverState> = createLinkedHoverStore();

export function useLinkedHover<T>(select: (s: LinkedHoverState) => T): T {
  return useStore(linkedHover, select);
}
