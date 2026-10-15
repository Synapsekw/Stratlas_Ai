import { useEffect, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { PANEL_CSS } from './panel-css';

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * The send-preview dialog frame (AI-6): what leaves this workstation, shown before it goes. The
 * agent panel's first-send preview and the engineering model's evidence preview both use it, so
 * every cloud send asks in the same place and the same words. Modal: Tab stays inside, Escape
 * anywhere cancels, and focus goes back where it was when the dialog closes. `standalone` renders
 * it outside the agent panel, with the panel's styles.
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
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef(onCancel);
  useEffect(() => {
    cancelRef.current = onCancel;
  });

  useEffect(() => {
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // a control inside may have taken the focus already (autofocus); else the dialog itself
    if (!dialogRef.current?.contains(document.activeElement)) dialogRef.current?.focus();
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        cancelRef.current();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      if (before?.isConnected) before.focus();
    };
  }, []);

  const trapTab = (e: KeyboardEvent) => {
    if (e.key !== 'Tab' || !dialogRef.current) return;
    const items = [...dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
    const first = items[0];
    const last = items.at(-1);
    if (!first || !last) {
      e.preventDefault();
      return;
    }
    const active = document.activeElement;
    if (e.shiftKey && (active === first || active === dialogRef.current)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  };

  const dialog = (
    <div className="ag-modal-back">
      <div
        ref={dialogRef}
        className={['ag-modal', className].filter(Boolean).join(' ')}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={trapTab}
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
