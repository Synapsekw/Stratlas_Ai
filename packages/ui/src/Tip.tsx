import type { ReactElement, ReactNode } from 'react';
import type { ShortcutId } from './shortcuts';

export const TIP_DELAY_MS = 400;
export const TIP_SKIP_MS = 0; // while moving from one tip to the next within 600 ms

export interface TipProps {
  content: ReactNode;
  shortcut?: ShortcutId;
  placement?: 'top' | 'bottom' | 'start' | 'end'; // default 'bottom'
  repeatsName?: boolean; // the content repeats the accessible name: aria-hidden
  children: ReactElement; // one focusable element; Tip adds aria-describedby unless repeatsName
}

/** Stub: built in the tooltip task. */
export const Tip: (props: TipProps) => ReactElement = () => {
  throw new Error('not built');
};
