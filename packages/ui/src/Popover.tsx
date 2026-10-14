import { useEffect, useLayoutEffect, useRef, type ReactNode, type RefObject } from 'react';
import { useFocusTrap } from './focus';

export interface PopoverProps {
  open: boolean;
  onClose: () => void;
  /** The button that opens it: a press on it is not "outside", and focus returns to it. */
  opener: RefObject<HTMLElement | null>;
  className?: string;
  children: ReactNode;
}

/**
 * A popover box: a press outside it (and outside its opener) or Escape closes it, Tab stays
 * inside, and focus goes back to the opener. Place it with `className`.
 */
export function Popover({ open, onClose, opener, className, children }: PopoverProps) {
  const pop = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
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
  if (!open) return null;
  return (
    <div ref={pop} className={className}>
      {children}
    </div>
  );
}
