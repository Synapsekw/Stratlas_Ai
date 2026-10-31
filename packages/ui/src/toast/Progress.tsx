import type { CSSProperties, ReactElement } from 'react';

export interface ProgressProps {
  /** 0 to 100, or null while the amount of work is unknown (a moving bar). */
  pct: number | null;
  /** The accessible name; without one the bar is hidden from screen readers (the text says it). */
  label?: string;
  testId?: string;
}

/**
 * A thin progress bar: an export in a toast, an install in Settings. With a `label` it is a
 * `progressbar` with its value; without one it is decoration beside text that says the same.
 */
export function Progress({ pct, label, testId }: ProgressProps): ReactElement {
  const a11y =
    label === undefined
      ? { 'aria-hidden': true as const }
      : {
          role: 'progressbar',
          'aria-label': label,
          'aria-valuemin': 0,
          'aria-valuemax': 100,
          ...(pct === null ? {} : { 'aria-valuenow': pct }),
        };
  return (
    <div
      className="q-progress"
      data-busy={pct === null ? '' : undefined}
      data-testid={testId}
      {...a11y}
    >
      <i style={{ '--p': (pct ?? 100) / 100 } as CSSProperties} />
    </div>
  );
}
