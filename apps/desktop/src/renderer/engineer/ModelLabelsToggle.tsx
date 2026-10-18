import { Button, useT } from '@aio/ui';

export interface ModelLabelsToggleProps {
  on: boolean;
  onChange: (on: boolean) => void;
}

/** Store-independent control, reusable in the engineering workbench toolbar. */
export function ModelLabelsToggle({ on, onChange }: ModelLabelsToggleProps) {
  const t = useT();
  return (
    <Button
      data-testid="eng-model-labels"
      pressed={on}
      aria-label={t(on ? 'eng.review.labels.hide' : 'eng.review.labels.show')}
      onClick={() => {
        onChange(!on);
      }}
    >
      {t(on ? 'eng.review.labels.on' : 'eng.review.labels.off')}
    </Button>
  );
}
