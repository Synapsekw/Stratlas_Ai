import { Chip, Tip, useT } from '@aio/ui';
import type { ReactElement } from 'react';
import './detectors.css';

export interface ScoreBadgeProps {
  /** The model's score for the box, 0 to 1 (absent when it gave none). */
  score: number | undefined;
  /** The bar this draft's pass is set to; null when none applies. */
  threshold: number | null;
  /** The model gave no clear yes or no for the box. */
  unscored: boolean;
}

/** A detector draft's score: accent when it clears the bar, muted under it, warn with no score. */
export function ScoreBadge({ score, threshold, unscored }: ScoreBadgeProps): ReactElement {
  const t = useT();
  if (unscored || score === undefined) {
    return (
      <span className="det-vlm-score" data-testid="det-vlm-score">
        <Tip content={t('detect.preset.score.noneTip')}>
          <span className="det-vlm-focus" tabIndex={0}>
            <Chip kind="tag" tone="warn">
              {t('detect.preset.score.none')}
            </Chip>
          </span>
        </Tip>
      </span>
    );
  }
  const text = score.toFixed(2);
  const under = threshold !== null && score < threshold;
  return (
    <span className="det-vlm-score mono" data-testid="det-vlm-score">
      <Chip kind="tag" tone={under ? 'off' : 'acc'}>
        {under ? t('detect.preset.score.under', { score: text }) : text}
      </Chip>
    </span>
  );
}
