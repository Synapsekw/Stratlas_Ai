import type { HTMLAttributes, ReactElement, ReactNode } from 'react';
import type { IconName } from './icons/Icon';

export type RowKind = 'nav' | 'tree' | 'menu' | 'palette'; // 32, 26, 30, 34 px

export interface RowProps extends Omit<HTMLAttributes<HTMLElement>, 'children'> {
  kind: RowKind;
  label: ReactNode;
  icon?: IconName;
  count?: number | string;
  selected?: boolean; // aria-current or aria-selected is the caller's; this sets data-selected
  actions?: ReactNode; // the trailing 24 x 24 menu button
  as?: 'div' | 'button' | 'a' | 'li';
}

/** Stub: built in the tabs and chips task. */
export const Row: (props: RowProps) => ReactElement = () => {
  throw new Error('not built');
};
