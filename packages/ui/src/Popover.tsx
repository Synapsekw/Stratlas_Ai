import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from 'react';
import { useFocusTrap } from './focus';
import { useT } from './i18n';
import { Icon } from './icons/Icon';
import { PortalRoot } from './portal';

export interface PopoverProps {
  open: boolean;
  onClose: () => void;
  /** The button that opens it: a press on it is not "outside", and focus returns to it. */
  opener: RefObject<HTMLElement | null>;
  className?: string;
  /**
   * Render into the document body, fixed above or below the opener and kept inside the window,
   * for an opener inside a box that clips (a scrolling list). Without it the popover renders in
   * place and `className` positions it.
   */
  anchor?: 'above' | 'below' | undefined;
  /** A title row (at the title size) with a close button. */
  title?: ReactNode;
  footer?: ReactNode;
  /** The close button's name; default "Close". */
  closeLabel?: string;
  children: ReactNode;
}

/** Gap between the opener and the popover, and the margin kept to the window edge. */
const GAP = 4;
const EDGE = 8;

/** Fixed position for a popover `w` wide next to the opener's rect. */
function anchoredStyle(anchor: 'above' | 'below', r: DOMRect, w: number): CSSProperties {
  const left = Math.max(EDGE, Math.min(r.left, window.innerWidth - w - EDGE));
  return {
    position: 'fixed',
    left: `${String(left)}px`,
    right: 'auto',
    top: anchor === 'below' ? `${String(r.bottom + GAP)}px` : 'auto',
    bottom: anchor === 'above' ? `${String(window.innerHeight - r.top + GAP)}px` : 'auto',
  };
}

/**
 * A popover box: a press outside it (and outside its opener) or Escape closes it, Tab stays
 * inside, and focus goes back to the opener. Place it with `className`, or with `anchor`.
 */
export function Popover({
  open,
  onClose,
  opener,
  className,
  anchor,
  title,
  footer,
  closeLabel,
  children,
}: PopoverProps) {
  const t = useT();
  const pop = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  const [style, setStyle] = useState<CSSProperties | undefined>(undefined);
  useLayoutEffect(() => {
    close.current = onClose;
  });
  useFocusTrap(pop, open, {
    onEscape: () => {
      close.current();
    },
    returnTo: () => opener.current,
  });
  useEffect(() => {
    if (!open) return;
    const onDown = (e: Event) => {
      const t = e.target as Node;
      if (!pop.current?.contains(t) && !opener.current?.contains(t)) close.current();
    };
    window.addEventListener('pointerdown', onDown);
    return () => {
      window.removeEventListener('pointerdown', onDown);
    };
  }, [open, opener]);
  // follow the opener when the window resizes or a box around it scrolls
  useLayoutEffect(() => {
    if (!open || !anchor) return;
    const place = () => {
      const r = opener.current?.getBoundingClientRect();
      if (!r) return;
      setStyle(anchoredStyle(anchor, r, pop.current?.getBoundingClientRect().width ?? 0));
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open, anchor, opener]);
  if (!open) return null;
  const cls = className ? `surface-pop ${className}` : 'surface-pop';
  const inner = (
    <>
      {title !== undefined && (
        <div className="pop-head">
          <h2 className="pop-title">{title}</h2>
          <button
            type="button"
            className="pop-close"
            aria-label={closeLabel ?? t('dialog.close')}
            onClick={() => {
              close.current();
            }}
          >
            <Icon name="x" size={14} />
          </button>
        </div>
      )}
      {children}
      {footer !== undefined && <div className="pop-foot">{footer}</div>}
    </>
  );
  if (anchor)
    return (
      <PortalRoot opener={opener.current}>
        <div ref={pop} className={cls} style={style ?? { position: 'fixed', visibility: 'hidden' }}>
          {inner}
        </div>
      </PortalRoot>
    );
  return (
    <div ref={pop} className={cls}>
      {inner}
    </div>
  );
}
