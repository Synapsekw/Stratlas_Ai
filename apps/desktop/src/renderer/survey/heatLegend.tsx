/**
 * The cut and fill heat map's legend on the stage: the store-free drawing in heatLegendView.tsx
 * plus the site's length unit as the default. The report page imports the view directly.
 */
import { effectiveUnits } from '@aio/survey';
import { useT } from '@aio/ui';
import type { ReactElement } from 'react';
import { HeatLegendView, LEGEND_RANGE_M, type HeatLegendViewProps } from './heatLegendView';
import { useMeasure } from './measureStore';

export { LEGEND_RANGE_M };

export interface HeatLegendProps extends Omit<HeatLegendViewProps, 'unit'> {
  /** The length unit heights are written in; default the site's. */
  unit?: HeatLegendViewProps['unit'];
}

export function HeatLegend({ unit, ...rest }: HeatLegendProps): ReactElement {
  const siteUnit = useMeasure((s) => effectiveUnits(s.settings.units).distance);
  return <HeatLegendView {...rest} unit={unit ?? siteUnit} />;
}

/** The stage's bottom-right hint while Cut & fill shows. */
export function CutFillHint({ className }: { className?: string }): ReactElement {
  const t = useT();
  return (
    <div className={['cf-hint', className].filter(Boolean).join(' ')}>{t('cutfill.clickPile')}</div>
  );
}
