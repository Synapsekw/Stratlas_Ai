/** One numbered step of the Coverage panel: a header (number or tick, title, meta) over a body. */
import { Icon } from '@aio/ui';
import { useId, type ReactElement, type ReactNode } from 'react';

export interface StepProps {
  n: number;
  done: boolean;
  title: string;
  meta?: ReactNode;
  testId: string;
  children?: ReactNode;
}

export function Step({ n, done, title, meta, testId, children }: StepProps): ReactElement {
  const titleId = useId();
  return (
    <section className="rf-step" data-testid={testId} data-done={done} aria-labelledby={titleId}>
      <div className="rf-step-hd">
        <span className="rf-step-num" data-done={done} aria-hidden="true">
          {done ? <Icon name="check" size={12} /> : n}
        </span>
        <h3 className="rf-step-title" id={titleId}>
          {title}
        </h3>
        {meta !== undefined && <span className="rf-step-meta">{meta}</span>}
      </div>
      <div className="rf-step-bd">{children}</div>
    </section>
  );
}
