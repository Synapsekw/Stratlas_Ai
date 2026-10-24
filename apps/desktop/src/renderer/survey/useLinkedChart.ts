/**
 * A profile chart joined to the linked hover (spec section 4): registers the chart's line under
 * its key while it is on screen and gives the chart its controlled crosshair, pin and fly. One
 * hook for the line cards, the section dock and window, and the kit's section line panel.
 *
 * A changed line is registered before the old one is let go, so a pin on the line survives the
 * chart's series being re-read (a chip toggled, a date prepared).
 */
import type { ChartSeries } from '@aio/survey';
import { useEffect, useRef } from 'react';
import type { ProfileChartProps } from '../charts/ProfileChart';
import { linkedHover, useLinkedHover, type HoverLine } from './linkedHover';

export type LinkedChartProps = Required<
  Pick<ProfileChartProps, 'hoverAt' | 'pinnedAt' | 'onHover' | 'onPinAt' | 'onFly'>
>;

type Polyline = readonly (readonly [number, number])[];

/** Same key, same plan line and the same series objects (the loads hand back stable ones). */
function sameLine(a: HoverLine, b: HoverLine): boolean {
  if (a.key !== b.key) return false;
  if (a.polyline.length !== b.polyline.length || a.series.length !== b.series.length) return false;
  for (let i = 0; i < a.polyline.length; i++) {
    const p = a.polyline[i];
    const q = b.polyline[i];
    if (p?.[0] !== q?.[0] || p?.[1] !== q?.[1]) return false;
  }
  return a.series.every((s, i) => s === b.series[i]);
}

/** Keeps `key`'s line registered while there is a line (two points) and something to show. */
export function useRegisterLine(
  key: string,
  polyline: Polyline | null,
  series: readonly ChartSeries[],
): void {
  const reg = useRef<{ line: HoverLine; off: () => void } | null>(null);
  useEffect(() => {
    const want: HoverLine | null =
      polyline && polyline.length >= 2 && series.length > 0 ? { key, polyline, series } : null;
    const cur = reg.current;
    if (want && cur && sameLine(cur.line, want)) return;
    if (want) {
      // the new line first: the old one's unregister then leaves the key (and its pin) alone
      reg.current = { line: want, off: linkedHover.getState().register(want) };
    } else reg.current = null;
    cur?.off();
  });
  useEffect(
    () => () => {
      reg.current?.off();
      reg.current = null;
    },
    [],
  );
}

/** The chart's side of the link for `key`: the store's point drives it, its pointer drives the store. */
export function useLinkedChart(
  key: string,
  polyline: Polyline | null,
  series: readonly ChartSeries[],
): LinkedChartProps {
  useRegisterLine(key, polyline, series);
  const hover = useLinkedHover((s) => (s.hover?.key === key ? s.hover.chainageM : null));
  const pin = useLinkedHover((s) => (s.pin?.key === key ? s.pin.chainageM : null));
  return {
    hoverAt: hover,
    pinnedAt: pin,
    onHover: (c) => {
      const s = linkedHover.getState();
      if (c !== null) s.setHover({ key, chainageM: c, source: 'chart' });
      else if (s.hover?.key === key) s.setHover(null);
    },
    onPinAt: (c) => {
      const s = linkedHover.getState();
      if (c !== null) s.setPin({ key, chainageM: c, source: 'chart' });
      else if (s.pin?.key === key) s.setPin(null);
    },
    onFly: (c) => {
      linkedHover.getState().flyTo(key, c);
    },
  };
}
