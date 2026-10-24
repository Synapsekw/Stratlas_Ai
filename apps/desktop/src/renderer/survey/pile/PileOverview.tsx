/**
 * The pile panel's Overview (spec section 3): the figure's status and how it was worked out, its
 * fill, cut and net, and a More disclosure with the heat map controls and the calculators (swell,
 * tonnes, weighed tonnage). Nothing else from the volume card shows by default.
 */
import { formatQuantity } from '@aio/geo';
import { useT } from '@aio/ui';
import type { ReactElement } from 'react';
import { Calculators } from '../Calculators';
import { HeatControls } from '../Comparison';
import { useCompare } from '../compareStore';
import type { PileData } from './PilePanel';

export function PileOverview({ data }: { data: PileData }): ReactElement {
  const t = useT();
  const { m, settings, units, locale, stored, line } = data;
  const computed = useCompare((s) => s.computed[m.id]);
  const v = (x: number) => formatQuantity(x, 'volume', units, settings.precision, locale);
  const d = (x: number) => formatQuantity(x, 'distance', units, settings.precision, locale);
  // a figure carried from an earlier version has no method of its own
  const method =
    stored && stored.carried === undefined
      ? [
          stored.fromLabel,
          ...(stored.usedDeadband ? [`${t('vol.ignoreSmaller')} ${d(stored.deadbandM)}`] : []),
          stored.cellM > 0 ? t('vol.gridCell', { cell: d(stored.cellM) }) : t('vol.highPrecision'),
        ].join(' · ')
      : null;
  const split = stored && stored.status !== 'refused' ? stored : null;
  return (
    <div className="pp-overview" data-testid="pile-overview">
      <p
        className="vd-status"
        data-tone={line.tone}
        data-testid="pile-overview-status"
        role="status"
      >
        <span className="vd-dot" aria-hidden="true" />
        {line.text}
      </p>
      {method && <p className="pp-method">{method}</p>}
      {split && (
        <dl className="pp-split" data-testid="pile-split">
          <div data-key="fill">
            <dt className="pp-cap">{t('vol.detail.fill')}</dt>
            <dd>{v(split.fillM3)}</dd>
          </div>
          <div data-key="cut">
            <dt className="pp-cap">{t('vol.detail.cut')}</dt>
            <dd>{v(split.cutM3)}</dd>
          </div>
          <div data-key="net">
            <dt className="pp-cap">{t('vol.detail.net')}</dt>
            <dd>{v(split.netM3)}</dd>
          </div>
        </dl>
      )}
      <details className="pp-more" data-testid="pile-more">
        <summary>{t('pile.more')}</summary>
        <div className="pp-more-body">
          {m.items.length > 0 && <HeatControls m={m} computed={computed ?? null} />}
          <Calculators m={m} />
        </div>
      </details>
    </div>
  );
}
