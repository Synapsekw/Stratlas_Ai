import type { ReactElement, ReactNode } from 'react';
import type { IconName } from './icons/Icon';

export interface EmptyStateProps {
  icon?: IconName;
  title: string;
  body?: ReactNode;
  action?: ReactNode;
}

/** Stub: built in the tabs and chips task. */
export const EmptyState: (props: EmptyStateProps) => ReactElement = () => {
  throw new Error('not built');
};
