import type { ReactElement, ReactNode } from 'react';
import { SevChip } from './controls';

export type ChipKind = 'tag' | 'status' | 'sev';

export interface ChipProps {
  kind: ChipKind;
  children: ReactNode;
  tone?: 'acc' | 'off' | 'warn' | 'danger'; // tag and status only
  color?: string; // sev only: the model colour (as SevChip)
}

/** The one chip: a plain tag, a status with a dot, or a severity tinted with the model colour. */
export function Chip({ kind, children, tone, color }: ChipProps): ReactElement {
  if (kind === 'sev') return <SevChip color={color}>{children}</SevChip>;
  if (kind === 'status') {
    return (
      <span className="chip-status" data-tone={tone}>
        <i className="dot" />
        {children}
      </span>
    );
  }
  return <span className={tone ? `tag ${tone}` : 'tag'}>{children}</span>;
}
