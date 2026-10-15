import type { ReactNode } from 'react';
import { PANEL_CSS } from './panel-css';

/**
 * The send-preview dialog frame (AI-6): what leaves this workstation, shown before it goes. The
 * agent panel's first-send preview and the engineering model's evidence preview both use it, so
 * every cloud send asks in the same place and the same words. `standalone` renders it outside the
 * agent panel, with the panel's styles.
 */
export function SendDialog({
  titleId,
  title,
  children,
  actions,
  onCancel,
  standalone = false,
  className,
}: {
  titleId: string;
  title: ReactNode;
  children: ReactNode;
  actions: ReactNode;
  onCancel: () => void;
  standalone?: boolean;
  className?: string;
}) {
  const dialog = (
    <div
      className="ag-modal-back"
      onKeyDown={(e) => {
        if (e.key === 'Escape') onCancel();
      }}
    >
      <div
        className={['ag-modal', className].filter(Boolean).join(' ')}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <h4 id={titleId}>{title}</h4>
        {children}
        <div className="ag-modal-acts">{actions}</div>
      </div>
    </div>
  );
  if (!standalone) return dialog;
  return (
    <div className="aio-agent ag-standalone">
      <style href="aio-agent-panel" precedence="default">
        {PANEL_CSS}
      </style>
      {dialog}
    </div>
  );
}
