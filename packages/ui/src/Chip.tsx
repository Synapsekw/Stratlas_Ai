import type { ReactElement, ReactNode } from 'react';

export type ChipKind = 'tag' | 'status' | 'sev';

export interface ChipProps {
  kind: ChipKind;
  children: ReactNode;
  tone?: 'acc' | 'off' | 'warn' | 'danger'; // tag and status only
  color?: string; // sev only: the model colour (as SevChip)
}

/** Stub: built in the tabs and chips task. */
export const Chip: (props: ChipProps) => ReactElement = () => {
  throw new Error('not built');
};
