import { createElement, type HTMLAttributes, type ReactElement, type ReactNode } from 'react';
import { Icon, type IconName } from './icons/Icon';

export type RowKind = 'nav' | 'tree' | 'menu' | 'palette'; // 32, 26, 30, 34 px

export interface RowProps extends Omit<HTMLAttributes<HTMLElement>, 'children'> {
  kind: RowKind;
  label: ReactNode;
  icon?: IconName;
  count?: number | string;
  selected?: boolean; // aria-current or aria-selected is the caller's; this sets data-selected
  actions?: ReactNode; // the trailing 24 x 24 "⋯" button
  as?: 'div' | 'button' | 'a' | 'li';
}

/** The one row base for the sidebar, trees, menus and the command palette. */
export function Row({
  kind,
  label,
  icon,
  count,
  selected,
  actions,
  as = 'div',
  className,
  ...rest
}: RowProps): ReactElement {
  return createElement(
    as,
    {
      ...rest,
      className: className ? `row ${className}` : 'row',
      'data-kind': kind,
      'data-selected': selected ? '' : undefined,
    },
    icon ? <Icon name={icon} size={16} /> : null,
    <span className="row-label">{label}</span>,
    count !== undefined ? <span className="row-count mono">{count}</span> : null,
    actions ? <span className="row-acts">{actions}</span> : null,
  );
}
