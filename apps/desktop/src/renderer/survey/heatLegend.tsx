/**
 * The cut and fill heat map's legend on the stage (volumetrics redesign, spec section 6, board 4):
 * bottom left, "Height change 10 Jan minus 31 Dec", the ramp, and "−2.0 m cut", "±0.10 m ignored",
 * "+2.0 m fill"; and the bottom-right hint "Click a pile to see its change". The ramp takes the
 * site's heat map colours when given (`heatRamp`, so it matches the map), else the cut and fill
 * tokens. Heights are in metres, as the threshold is.
 */
import { formatNumber, type NumberLocale } from '@aio/geo';
import type { HeatmapStyle } from '@aio/schema';
import { heatRamp } from '@aio/survey';
import { formatDate, useT } from '@aio/ui';
import { useId, useMemo, type CSSProperties, type ReactElement } from 'react';
import './volumes/cutFill.css';

/** The ramp's half span when none is given, metres (the boards' ±2.0 m). */
export const LEGEND_RANGE_M = 2;

export interface HeatLegendProps {
  /** The compare pair's dates (ISO), From and To. */
  from: string;
  to: string;
  /** "Ignore under", metres; 0 draws no ignored band. */
  thresholdM: number;
  /** The ramp's half span, metres (default 2). */
  rangeM?: number;
  /** The site's heat map style, so the ramp matches the map. */
  style?: Pick<HeatmapStyle, 'stops' | 'stepped' | 'inverted'>;
  locale?: NumberLocale;
  className?: string;
}

/** A CSS gradient from the site's stops over −range to +range, clear inside the threshold. */
function stopsGradient(
  style: Pick<HeatmapStyle, 'stops' | 'stepped' | 'inverted'>,
  rangeM: number,
  thresholdM: number,
): string {
  const at = (v: number) => `${Math.min(100, Math.max(0, ((v + rangeM) / (2 * rangeM)) * 100))}%`;
  const parts = heatRamp(style).legend.map((s) => `${s.color} ${at(s.value)}`);
  if (thresholdM > 0) {
    parts.push(`var(--bg-3) ${at(-thresholdM)}`, `var(--bg-3) ${at(thresholdM)}`);
  }
  const sorted = parts
    .map((p) => ({ p, v: Number.parseFloat(p.slice(p.lastIndexOf(' ') + 1)) }))
    .sort((a, b) => a.v - b.v)
    .map((x) => x.p);
  return `linear-gradient(90deg, ${sorted.join(', ')})`;
}

export function HeatLegend({
  from,
  to,
  thresholdM,
  rangeM = LEGEND_RANGE_M,
  style,
  locale = 'metric',
  className,
}: HeatLegendProps): ReactElement {
  const t = useT();
  const id = useId();
  const title = t('cutfill.legendTitle', {
    to: formatDate(to, { year: false }),
    from: formatDate(from, { year: false }),
  });
  const range = formatNumber(rangeM, 1, locale);
  const ramp = useMemo<CSSProperties | undefined>(
    () =>
      style && style.stops.length >= 2
        ? { backgroundImage: stopsGradient(style, rangeM, thresholdM) }
        : undefined,
    [style, rangeM, thresholdM],
  );
  return (
    <div
      className={['cf-legend', className].filter(Boolean).join(' ')}
      role="group"
      aria-label={title}
      aria-describedby={id}
      data-testid="cutfill-legend"
    >
      <span className="cf-legend-title">{title}</span>
      <span className="cf-legend-ramp" style={ramp} aria-hidden="true" />
      <span className="cf-legend-ticks" id={id}>
        <span>{t('cutfill.legendCut', { value: `−${range} m` })}</span>
        <span>
          {thresholdM > 0
            ? t('cutfill.ignored', { value: `${formatNumber(thresholdM, 2, locale)} m` })
            : ''}
        </span>
        <span>{t('cutfill.legendFill', { value: `${range} m` })}</span>
      </span>
    </div>
  );
}

/** The stage's bottom-right hint while Cut & fill shows. */
export function CutFillHint({ className }: { className?: string }): ReactElement {
  const t = useT();
  return (
    <div className={['cf-hint', className].filter(Boolean).join(' ')}>{t('cutfill.clickPile')}</div>
  );
}
