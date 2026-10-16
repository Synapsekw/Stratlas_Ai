import type { ReactElement, RefObject } from 'react';
import type { IconName } from './icons/Icon';
import type { ShortcutId } from './shortcuts';

export type MenuEntry =
  | {
      id: string;
      label: string;
      icon?: IconName;
      shortcut?: ShortcutId;
      checked?: boolean;
      danger?: boolean;
      disabledReason?: string;
      onSelect: () => void;
    }
  | 'separator';

export interface MenuProps {
  open: boolean;
  onClose: () => void;
  opener: RefObject<HTMLElement | null>;
  label: string;
  items: readonly MenuEntry[];
  anchor?: 'above' | 'below'; // default 'below'
  testId?: string;
}

/** Stub: built in the floating surface task. */
export const Menu: (props: MenuProps) => ReactElement | null = () => {
  throw new Error('not built');
};
