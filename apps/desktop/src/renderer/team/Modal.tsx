import { Icon, t, useFocusTrap, type IconName } from '@aio/ui';
import { useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

/**
 * A team dialog, portalled to the body: the chip that opens it sits in the title bar, whose drag
 * region would otherwise swallow the clicks.
 */
export function Modal(props: {
  id: string;
  icon: IconName;
  title: string;
  sub?: string;
  busy?: boolean;
  onClose(): void;
  footer: ReactNode;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useFocusTrap(ref, true);
  const close = () => {
    if (!props.busy) props.onClose();
  };
  return createPortal(
    <div
      className="dlg-scrim"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div
        ref={ref}
        className="dlg team-dlg"
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${props.id}-title`}
        data-testid={props.id}
        onKeyDown={(e) => {
          if (e.key === 'Escape') close();
        }}
      >
        <div className="dlg-h">
          <Icon name={props.icon} size={16} />
          <h2 id={`${props.id}-title`}>{props.title}</h2>
          {props.sub && (
            <span className="sub" dir="auto">
              {props.sub}
            </span>
          )}
          <button
            type="button"
            className="btn ghost icon sm"
            aria-label={t('team.close')}
            disabled={props.busy}
            onClick={close}
          >
            <Icon name="x" size={14} />
          </button>
        </div>
        <div className="dlg-b">{props.children}</div>
        <div className="dlg-f">{props.footer}</div>
      </div>
    </div>,
    document.body,
  );
}
