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
   * for an opener inside a box that clips (a scrolling list) or a floating panel. It flips to the
   * other side when that has more room for it, scrolls within the room it has, and opened from a
   * floating panel over the popover layer it sits on the top layer, above that panel. Without it the popover renders in place and
   * `className` positions it.
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

/** The popover layer (`--z-pop` in tokens.css) when the sheet is not loaded. */
const Z_POP = 40;

/**
 * Whether the opener sits in a floating panel at or above the popover layer (a dock or a tool
 * panel over the stage): a popover on its own layer would open under what opened it.
 */
function overPopLayer(opener: Element | null): boolean {
  if (!opener) return false;
  const token = Number.parseInt(
    getComputedStyle(document.documentElement).getPropertyValue('--z-pop'),
    10,
  );
  const zPop = Number.isFinite(token) ? token : Z_POP;
  for (let el = opener.parentElement; el && el !== document.body; el = el.parentElement) {
    const z = Number.parseInt(getComputedStyle(el).zIndex, 10);
    if (Number.isFinite(z) && z >= zPop) return true;
  }
  return false;
}

/**
 * Fixed position for a popover `w` wide and `h` tall (its content's height) next to the opener's
 * rect: on the asked side, or the other when the asked one is too short for it and the other has
 * more room; never taller than the room on its side, scrolling inside it.
 */
function anchoredStyle(anchor: 'above' | 'below', r: DOMRect, w: number, h: number): CSSProperties {
  const left = Math.max(EDGE, Math.min(r.left, window.innerWidth - w - EDGE));
  const room = {
    below: Math.max(0, window.innerHeight - r.bottom - GAP - EDGE),
    above: Math.max(0, r.top - GAP - EDGE),
  };
  const other = anchor === 'below' ? 'above' : 'below';
  const side = h > room[anchor] && room[other] > room[anchor] ? other : anchor;
  return {
    position: 'fixed',
    left: `${String(left)}px`,
    right: 'auto',
    top: side === 'below' ? `${String(r.bottom + GAP)}px` : 'auto',
    bottom: side === 'above' ? `${String(window.innerHeight - r.top + GAP)}px` : 'auto',
    maxHeight: `${String(room[side])}px`,
    overflowY: 'auto',
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
  // on the top layer when opened from a floating panel over the popover layer
  const [lift, setLift] = useState(false);
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
  // placed again after every render (its content can grow: a group unfolds), and when the window
  // resizes or a box around the opener scrolls; set only when it moved, so no render loop
  const placed = useRef('');
  const placeNow = useRef<() => void>(() => undefined);
  useLayoutEffect(() => {
    placeNow.current = () => {
      const r = opener.current?.getBoundingClientRect();
      const box = pop.current;
      if (!r || !box || !anchor) return;
      const own = box.getBoundingClientRect();
      // the content's own height: a box held to its room is shorter than what it holds
      const next = anchoredStyle(anchor, r, own.width, Math.max(own.height, box.scrollHeight));
      const top = overPopLayer(opener.current);
      const key = `${JSON.stringify(next)}|${String(top)}`;
      if (key === placed.current) return;
      placed.current = key;
      setStyle(next);
      setLift(top);
    };
    if (open) placeNow.current();
  });
  useLayoutEffect(() => {
    if (!open || !anchor) {
      placed.current = '';
      return;
    }
    const place = () => {
      placeNow.current();
    };
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
      <PortalRoot opener={opener.current} layer={lift ? 'top' : undefined}>
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
