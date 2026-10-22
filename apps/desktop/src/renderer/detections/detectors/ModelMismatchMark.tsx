import { Icon, t, Tip } from '@aio/ui';
import type { ReactElement } from 'react';
import './modelMismatch.css';

/**
 * The warn mark of a detector tuned on another model than the installed one: focusable, with the
 * reason in its tip and as its accessible name. Settings' Detector library and the run dialog.
 */
export function ModelMismatchMark({ testId }: { testId: string }): ReactElement {
  return (
    <Tip content={t('detect.preset.modelMismatch')} repeatsName>
      <span
        className="det-vlm-mismatch"
        role="img"
        tabIndex={0}
        aria-label={t('detect.preset.modelMismatch')}
        data-testid={testId}
      >
        <Icon name="warn" size={14} />
      </span>
    </Tip>
  );
}
