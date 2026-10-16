import {
  cloneElement,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
  type Ref,
} from 'react';
import { PortalRoot } from './portal';
import { shortcutHint, type ShortcutId } from './shortcuts';

export const TIP_DELAY_MS = 400;
export const TIP_SKIP_MS = 0; // while moving from one tip to the next within 600 ms
const TIP_SKIP_WINDOW_MS = 600;
const EDGE = 8;
const GAP = 6;

export interface TipProps {
  content: ReactNode;
  shortcut?: ShortcutId;
  placement?: 'top' | 'bottom' | 'start' | 'end'; // default 'bottom'
  repeatsName?: boolean; // the content repeats the accessible name: aria-hidden
  children: ReactElement; // one focusable element; Tip adds aria-describedby unless repeatsName
}

/** When any tip last hid, so moving to the next one skips the delay. */
let lastHiddenAt = Number.NEGATIVE_INFINITY;

type Handler = (event: never) => void;
type ChildProps = Record<string, unknown>;
type Placement = NonNullable<TipProps['placement']>;

function setRef(ref: Ref<Element> | undefined, value: Element | null): void {
  if (typeof ref === 'function') ref(value);
  else if (ref) (ref as { current: Element | null }).current = value;
}

function place(
  anchor: DOMRect,
  tip: { width: number; height: number },
  placement: Placement,
  rtl: boolean,
): { left: number; top: number } {
  const flip = rtl ? { start: 'right', end: 'left' } : { start: 'left', end: 'right' };
  const side = placement === 'start' ? flip.start : placement === 'end' ? flip.end : placement;
  let left = anchor.left + anchor.width / 2 - tip.width / 2;
  let top = anchor.bottom + GAP;
  if (side === 'top') top = anchor.top - GAP - tip.height;
  if (side === 'left' || side === 'right') {
    top = anchor.top + anchor.height / 2 - tip.height / 2;
    left = side === 'left' ? anchor.left - GAP - tip.width : anchor.right + GAP;
  }
  return {
    left: Math.max(EDGE, Math.min(left, window.innerWidth - EDGE - tip.width)),
    top: Math.max(EDGE, Math.min(top, window.innerHeight - EDGE - tip.height)),
  };
}

export function Tip({
  content,
  shortcut,
  placement = 'bottom',
  repeatsName = false,
  children,
}: TipProps): ReactElement {
  const id = useId();
  const [opener, setOpener] = useState<Element | null>(null);
  const [wanted, setWanted] = useState(false);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const child = children as ReactElement<ChildProps>;
  const childProps = child.props;

  const hide = useCallback(() => {
    setWanted(false);
    setOpen((was) => {
      if (was) lastHiddenAt = Date.now();
      return false;
    });
  }, []);
  const show = useCallback(() => {
    setWanted(true);
    if (Date.now() - lastHiddenAt < TIP_SKIP_WINDOW_MS) setOpen(true);
  }, []);

  useEffect(() => {
    if (!wanted) return;
    const timer = setTimeout(() => {
      setOpen(true);
    }, TIP_DELAY_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [wanted]);

  useLayoutEffect(() => {
    const pop = popRef.current;
    if (!open || !opener || !pop) return;
    const rtl = getComputedStyle(opener).direction === 'rtl';
    setPos(place(opener.getBoundingClientRect(), pop.getBoundingClientRect(), placement, rtl));
  }, [open, opener, placement, content, shortcut]);

  const chain = (name: string, own: () => void) => (event: never) => {
    own();
    (childProps[name] as Handler | undefined)?.(event);
  };

  const props: ChildProps = {
    ref: (node: Element | null) => {
      setOpener(node);
      setRef((child as unknown as { ref?: Ref<Element> }).ref, node);
    },
    onPointerEnter: chain('onPointerEnter', show),
    onPointerLeave: chain('onPointerLeave', hide),
    onFocus: chain('onFocus', show),
    onBlur: chain('onBlur', hide),
    onPointerDown: chain('onPointerDown', hide),
    onKeyDown: (event: { key: string }) => {
      if (event.key === 'Escape') hide();
      (childProps.onKeyDown as Handler | undefined)?.(event as never);
    },
  };
  if (!repeatsName) {
    const existing = childProps['aria-describedby'] as string | undefined;
    props['aria-describedby'] = existing ? `${existing} ${id}` : id;
  }

  return (
    <>
      {cloneElement(child, props)}
      {open ? (
        <PortalRoot opener={opener}>
          <div
            ref={popRef}
            id={id}
            role="tooltip"
            className="tip-pop"
            aria-hidden={repeatsName ? 'true' : undefined}
            style={{
              left: pos?.left ?? 0,
              top: pos?.top ?? 0,
              visibility: pos ? 'visible' : 'hidden',
            }}
          >
            {content}
            {shortcut ? <span className="kbd">{shortcutHint(shortcut)}</span> : null}
          </div>
        </PortalRoot>
      ) : null}
    </>
  );
}
