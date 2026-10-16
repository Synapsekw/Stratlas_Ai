import type { ReactElement, ReactNode } from 'react';
import { Icon, type IconName } from './icons/Icon';

export interface EmptyStateProps {
  icon?: IconName;
  title: string;
  body?: ReactNode;
  action?: ReactNode;
}

/** The one empty state: an icon, a heading, a sentence and at most one action. */
export function EmptyState({ icon, title, body, action }: EmptyStateProps): ReactElement {
  return (
    <div className="empty">
      {icon ? <Icon name={icon} size={20} /> : null}
      <h3 className="empty-title">{title}</h3>
      {body ? <div className="empty-body">{body}</div> : null}
      {action ? <div className="empty-act">{action}</div> : null}
    </div>
  );
}
