/**
 * "Shade vs": which shown surface the current survey's cut and fill is shaded against. A segmented
 * control over the shown surfaces, then "None". Nothing renders when only the current is shown.
 */
import { useT } from '@aio/ui';
import type { ReactElement } from 'react';
import './charts.css';

export function ShadeVs(p: {
  targets: readonly { key: string; label: string }[];
  value: string | null;
  onChange(key: string | null): void;
}): ReactElement | null {
  const t = useT();
  if (p.targets.length === 0) return null;
  const label = t('chart.shadeVs');
  const options = [...p.targets, { key: null, label: t('chart.none') }];
  return (
    <div className="pc-shade">
      <span className="pc-shade-label" aria-hidden="true">
        {label}
      </span>
      <div className="seg" role="group" aria-label={label}>
        {options.map((o) => (
          <button
            key={o.key ?? ''}
            type="button"
            aria-pressed={o.key === p.value}
            onClick={() => {
              p.onChange(o.key);
            }}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}
