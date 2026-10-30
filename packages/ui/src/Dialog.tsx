import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
  type RefObject,
} from 'react';
import { IconButton } from './controls';
import { focusables, useFocusTrap } from './focus';
import { useT } from './i18n';
import { PortalRoot } from './portal';

export type DialogSize = 'sm' | 'md' | 'lg';

export interface DialogProps {
  open: boolean;
  /** Escape, a press on the scrim (unless `dismissable` is false) and the close button. */
  onClose: () => void;
  /** The visible title; it names the dialog (aria-labelledby). */
  title: ReactNode;
  /** A line under the title that describes the dialog (aria-describedby). */
  description?: ReactNode;
  /** The id of an element inside `children` that describes the dialog, instead of `description`. */
  describedBy?: string;
  /** Width: sm 400, md 560 (default), lg 760 px; never wider than the window. */
  size?: DialogSize;
  /** 'alertdialog' for a confirm that interrupts (a delete); default 'dialog'. */
  role?: 'dialog' | 'alertdialog';
  /** The control focused first; default the first in the body, then the footer, then Close. */
  initialFocus?: RefObject<HTMLElement | null>;
  /** Where focus goes when it closes; default the control that had focus when it opened. */
  returnFocus?: () => HTMLElement | null | undefined;
  /** A press on the scrim closes it; default true. Escape and the close button always do. */
  dismissable?: boolean;
  /** Hide the close button in the title row (a dialog whose footer has Cancel). */
  hideClose?: boolean;
  /** The close button's name; default "Close". */
  closeLabel?: string;
  /** Buttons along the bottom, end-aligned. */
  footer?: ReactNode;
  /** Extra class on the dialog box (feature layout inside the body). */
  className?: string;
  testId?: string;
  children?: ReactNode;
}

/* ---------- the stack of open dialogs ---------- */

interface Open {
  box: HTMLElement;
  scrim: HTMLElement;
  close: () => void;
}

/** Open dialogs, oldest first; the last one is on top and the only one that takes input. */
const stack: Open[] = [];

/** Dialogs under the top one are inert and their scrims clear, so the page dims once. */
function restack(): void {
  stack.forEach((d, i) => {
    const under = i < stack.length - 1;
    for (const [el, name] of [
      [d.box, 'inert'],
      [d.scrim, 'data-under'],
    ] as const) {
      if (under) el.setAttribute(name, '');
      else el.removeAttribute(name);
    }
  });
}

/**
 * Escape closes the top dialog only, and only when the key comes from inside it or from nowhere
 * (focus lost to the page): a menu inside it stops the key first, and another modal opened above
 * it (an older hand-built one) handles its own. Listens on the document, so it runs before the
 * app's window shortcuts.
 */
function onDocKey(e: KeyboardEvent): void {
  if (e.key !== 'Escape' || e.defaultPrevented) return;
  const top = stack[stack.length - 1];
  if (!top) return;
  const doc = top.box.ownerDocument;
  const from = e.target instanceof Node ? e.target : null;
  const nowhere = from === null || from === doc.body || from === doc.documentElement;
  if (!nowhere && !top.box.contains(from)) return;
  e.preventDefault();
  e.stopPropagation();
  top.close();
}

function push(d: Open): () => void {
  if (stack.length === 0) d.box.ownerDocument.addEventListener('keydown', onDocKey);
  stack.push(d);
  restack();
  return () => {
    const i = stack.indexOf(d);
    if (i >= 0) stack.splice(i, 1);
    d.box.removeAttribute('inert');
    if (stack.length === 0) d.box.ownerDocument.removeEventListener('keydown', onDocKey);
    restack();
  };
}

/** How many dialogs are open (tests, and a guard for global shortcuts). */
export function openDialogCount(): number {
  return stack.length;
}

/**
 * The one modal dialog: a portal under the body with one scrim, `role="dialog"` (or
 * `alertdialog`) with `aria-modal`, named by its title. Focus moves inside and Tab stays there;
 * Escape and a press on the scrim close it; focus goes back to the control that opened it.
 * Dialogs stack: one opened from another sits above it, the one below goes inert, and Escape
 * closes only the top one.
 */
export function Dialog({
  open,
  onClose,
  title,
  description,
  describedBy,
  size = 'md',
  role = 'dialog',
  initialFocus,
  returnFocus,
  dismissable = true,
  hideClose = false,
  closeLabel,
  footer,
  className,
  testId,
  children,
}: DialogProps): ReactElement | null {
  const t = useT();
  const box = useRef<HTMLDivElement>(null);
  const scrim = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  useLayoutEffect(() => {
    close.current = onClose;
  });
  // the opener, for the portal's theme (a dialog opened from a dark map wears the map's surface)
  const [opener, setOpener] = useState<Element | null>(() =>
    open && typeof document !== 'undefined' ? document.activeElement : null,
  );
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    setOpener(open ? document.activeElement : null);
  }
  useFocusTrap(box, open, {
    // the asked control, else the first in the body, then the footer; the close button last
    initial: () => {
      const b = box.current;
      const part = (sel: string) => {
        const el = b?.querySelector<HTMLElement>(sel);
        return el ? focusables(el)[0] : undefined;
      };
      return initialFocus?.current ?? part('.q-dialog-body') ?? part('.q-dialog-foot');
    },
    returnTo: () => returnFocus?.(),
  });
  useEffect(() => {
    const b = box.current;
    const s = scrim.current;
    if (!open || !b || !s) return;
    return push({
      box: b,
      scrim: s,
      close: () => {
        close.current();
      },
    });
  }, [open]);
  // a press closes only when it both starts and ends on the scrim (a drag out of a field does not)
  const downOnScrim = useRef(false);
  const titleId = useId();
  const descId = useId();
  if (!open) return null;
  const describer = description !== undefined ? descId : describedBy;
  return (
    <PortalRoot opener={opener}>
      <div
        ref={scrim}
        className="q-scrim"
        data-testid={testId ? `${testId}-scrim` : undefined}
        onPointerDown={(e) => {
          downOnScrim.current = e.target === e.currentTarget;
        }}
        onClick={(e) => {
          const onScrim = downOnScrim.current && e.target === e.currentTarget;
          downOnScrim.current = false;
          if (onScrim && dismissable) close.current();
        }}
      >
        <div
          ref={box}
          role={role}
          aria-modal="true"
          aria-labelledby={titleId}
          aria-describedby={describer}
          className={className ? `q-dialog ${className}` : 'q-dialog'}
          data-size={size}
          data-testid={testId}
          tabIndex={-1}
        >
          <div className="q-dialog-head">
            <h2 id={titleId} className="q-dialog-title">
              {title}
            </h2>
            {!hideClose && (
              <IconButton
                icon="x"
                label={closeLabel ?? t('dialog.close')}
                className="q-dialog-close"
                onClick={() => {
                  close.current();
                }}
              />
            )}
          </div>
          {description !== undefined && (
            <p id={descId} className="q-dialog-desc">
              {description}
            </p>
          )}
          <div className="q-dialog-body">{children}</div>
          {footer !== undefined && <div className="q-dialog-foot">{footer}</div>}
        </div>
      </div>
    </PortalRoot>
  );
}
