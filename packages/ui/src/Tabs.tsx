import type { ReactElement } from 'react';
import type { IconName } from './icons/Icon';

export interface TabItem<K extends string> {
  id: K;
  label: string;
  count?: number;
  icon?: IconName;
  live?: boolean; // accent dot with a text label (aria-label t('tabs.live'))
  pinned?: boolean;
  onPinChange?: (pinned: boolean) => void; // shows a pin toggle
  onClose?: () => void; // shows a close button; click or middle-click only, no shortcut
}

export interface TabsProps<K extends string> {
  items: readonly TabItem<K>[];
  value: K;
  onChange: (id: K) => void;
  label: string; // the tablist's name
  idPrefix: string; // tab ids `${idPrefix}-tab-${id}`, panels `${idPrefix}-panel-${id}`
  overflow?: 'wrap' | 'menu'; // default 'wrap'; 'menu' keeps one row, non-fitting tabs go to a Menu
  overflowOrder?: (id: K) => number; // higher leaves first; the selected tab never leaves
}

/** Stub: built in the tabs task. */
export const Tabs: <K extends string>(props: TabsProps<K>) => ReactElement = () => {
  throw new Error('not built');
};
