import { formatCount, formatDate, useT } from '@aio/ui';
import type { ReactElement } from 'react';
import type { DetectorPassRow } from './passRows';
import { ThresholdSlider } from './ThresholdSlider';

export interface DetectorPassesProps {
  passes: readonly DetectorPassRow[];
  onThreshold: (pass: string, value: number) => void;
}

/** The strip under the Detections header: per detector run, one bar and what it shows and hides. */
export function DetectorPasses({ passes, onThreshold }: DetectorPassesProps): ReactElement {
  const t = useT();
  return (
    <section className="det-vlm-passes" aria-label={t('detect.preset.passes')}>
      {passes.map((p) => {
        const name = p.detectorName || p.pass;
        return (
          <div key={p.pass} className="det-vlm-pass" data-testid="det-vlm-pass">
            <span className="det-vlm-name">{name}</span>
            {p.runAt && <span className="det-vlm-when faint">{formatDate(p.runAt)}</span>}
            <label className="det-vlm-bar">
              <span>{t('detect.preset.pass.bar')}</span>
              <ThresholdSlider
                value={p.threshold}
                label={t('detect.preset.pass.barLabel', { name })}
                onChange={(v) => {
                  onThreshold(p.pass, v);
                }}
              />
              <b className="mono">{p.threshold.toFixed(2)}</b>
            </label>
            <span className="mono faint" data-testid="det-vlm-counts">
              {t('detect.preset.pass.counts', {
                shown: formatCount(p.shown),
                hidden: formatCount(p.hidden),
              })}
            </span>
          </div>
        );
      })}
    </section>
  );
}
