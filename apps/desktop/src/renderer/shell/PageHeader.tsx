import { t, useT, type MessageKey } from '@aio/ui';
import type { ReactNode } from 'react';
import { HeaderControls } from './RightHeader';

export interface PageHeaderProps {
  /** The screen's name (a `heading` prop, not `title`: no native tooltip is meant). */
  heading: MessageKey;
  /** The screen's own actions, before the Agent and Share controls. */
  actions?: ReactNode;
}

/**
 * The 40 px header row of a screen other than the Scene: its title on the left, its actions on
 * the right. The empty part drags the window, and the end keeps clear of the window's caption
 * buttons (`--caption-end`, styles.css). The screen below it starts under the row.
 */
export function PageHeader({ heading, actions }: PageHeaderProps) {
  useT();
  return (
    <header className="pg-head" data-testid="page-header">
      <span className="pg-title" dir="auto">
        {t(heading)}
      </span>
      <span className="pg-fill" />
      <div className="pg-acts">
        {actions}
        <HeaderControls />
      </div>
    </header>
  );
}
