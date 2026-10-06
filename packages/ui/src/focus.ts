/**
 * Focus management for dialogs and popovers: focus moves inside when they open, Tab and
 * Shift+Tab cycle inside, Esc closes, and focus goes back to the control that opened them when
 * they close (unless the person already moved it somewhere else on purpose).
 */
import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react';

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
  '[contenteditable="true"]',
].join(',');

/** Focusable, visible elements inside `root`, in tab order (DOM order; no positive tabindex). */
export function focusables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    // checkVisibility: Chromium; jsdom (unit tests) lacks it and counts everything as shown
    (el) =>
      !el.closest('[inert], [hidden]') && ('checkVisibility' in el ? el.checkVisibility() : true),
  );
}

/**
 * Menus and lists: Up and Down move focus between the focusable items of `root`, Home and End go
 * to the ends. Returns true when the key was used (call preventDefault).
 */
export function arrowFocus(root: HTMLElement, key: string): boolean {
  const items = focusables(root);
  if (!items.length) return false;
  const at = items.indexOf(root.ownerDocument.activeElement as HTMLElement);
  let next: HTMLElement | undefined;
  if (key === 'ArrowDown') next = items[(at + 1) % items.length];
  else if (key === 'ArrowUp') next = items[(at - 1 + items.length) % items.length];
  else if (key === 'Home') next = items[0];
  else if (key === 'End') next = items[items.length - 1];
  if (!next) return false;
  next.focus();
  return true;
}

/**
 * The element that had focus before the current one: a dialog that focuses its first field on
 * mount (autoFocus) has already taken focus when its trap starts, so the opener is this one.
 */
let previousFocus: HTMLElement | null = null;
let currentFocus: HTMLElement | null = null;
if (typeof document !== 'undefined')
  document.addEventListener(
    'focusin',
    (e) => {
      const el = e.target instanceof HTMLElement ? e.target : null;
      if (el === currentFocus) return;
      previousFocus = currentFocus;
      currentFocus = el;
    },
    true,
  );

/** Open traps and where each hands focus back, for `keepFocusAlive` when a trap root vanishes. */
const openers = new WeakMap<HTMLElement, () => HTMLElement | null>();

/** Focus that went nowhere: the page body, or an element no longer in the document. */
export function focusLost(doc: Document = document): boolean {
  const a = doc.activeElement;
  return a === null || a === doc.body || a === doc.documentElement || !a.isConnected;
}

/**
 * Keep keyboard focus somewhere meaningful: when the focused control disappears (a row deleted, a
 * panel swapped, a screen changed), focus moves to the nearest part of the page that is still
 * there (its first focusable control), else to `fallback()` (the screen's heading). Focus the
 * person moved to the page on purpose (a click on the 3D canvas) is left alone. Returns stop.
 */
export function keepFocusAlive(
  doc: Document,
  fallback: () => HTMLElement | null | undefined,
): () => void {
  let chain: HTMLElement[] = [];
  const remember = (e: FocusEvent) => {
    const chainOf: HTMLElement[] = [];
    for (let el = e.target as HTMLElement | null; el && el !== doc.body; el = el.parentElement)
      chainOf.push(el);
    chain = chainOf;
  };
  const rescue = () => {
    const lost = chain[0];
    if (!lost || !focusLost(doc)) return;
    if (lost.isConnected) {
      // moved to the page on purpose (a click on the canvas): nothing to rescue later
      chain = [];
      return;
    }
    // inside a dialog or popover that closed: back to the control that opened it
    for (const el of chain) {
      const back = openers.get(el)?.();
      if (back?.isConnected) {
        back.focus();
        return;
      }
    }
    for (const el of chain.slice(1)) {
      if (!el.isConnected) continue;
      const target = focusables(el)[0];
      if (target) {
        target.focus();
        return;
      }
    }
    const f = fallback();
    if (f?.isConnected) {
      if (!f.hasAttribute('tabindex') && focusables(f).length === 0) f.tabIndex = -1;
      f.focus();
    }
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const later = () => {
    clearTimeout(timer);
    timer = setTimeout(rescue, 0);
  };
  // the focused element removed: Chromium fires focusout, a removal it may not; the observer
  // covers both
  const observer = new MutationObserver(() => {
    if (chain[0] && !chain[0].isConnected) later();
  });
  observer.observe(doc.body, { childList: true, subtree: true });
  doc.addEventListener('focusin', remember);
  doc.addEventListener('focusout', later);
  return () => {
    clearTimeout(timer);
    observer.disconnect();
    doc.removeEventListener('focusin', remember);
    doc.removeEventListener('focusout', later);
  };
}

export interface FocusTrapOptions {
  /** Esc pressed inside (or anywhere while `escapeAnywhere`); usually closes. */
  onEscape?: () => void;
  /** Listen for Esc on the window, not only inside (popovers that keep focus on the stage). */
  escapeAnywhere?: boolean;
  /** Element to focus first; default the first focusable, else the container itself. */
  initial?: () => HTMLElement | null | undefined;
  /** Keep Tab inside (dialogs, popovers). Default true. */
  cycle?: boolean;
  /** Where focus goes back on close; default whatever had focus when it opened. */
  returnTo?: () => HTMLElement | null | undefined;
}

/**
 * Trap focus in `root` while it is mounted. Returns the release function, which puts focus back
 * on the opener when focus was inside or got lost.
 */
export function trapFocus(root: HTMLElement, o: FocusTrapOptions = {}): () => void {
  const doc = root.ownerDocument;
  const active = doc.activeElement instanceof HTMLElement ? doc.activeElement : null;
  const opener = active && root.contains(active) ? previousFocus : active;
  if (!root.contains(doc.activeElement)) {
    const first = o.initial?.() ?? focusables(root)[0];
    if (first) first.focus();
    else {
      if (!root.hasAttribute('tabindex')) root.tabIndex = -1;
      root.focus();
    }
  }
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && o.onEscape) {
      if (e.defaultPrevented) return;
      e.preventDefault();
      e.stopPropagation();
      o.onEscape();
      return;
    }
    if (e.key !== 'Tab' || o.cycle === false) return;
    const list = focusables(root);
    const first = list[0];
    const last = list[list.length - 1];
    if (!first || !last) {
      e.preventDefault();
      return;
    }
    const active = doc.activeElement;
    if (e.shiftKey && (active === first || active === root || !root.contains(active))) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (active === last || !root.contains(active))) {
      e.preventDefault();
      first.focus();
    }
  };
  const target: HTMLElement | Window = o.escapeAnywhere ? (doc.defaultView ?? window) : root;
  target.addEventListener('keydown', onKey as EventListener);
  openers.set(root, () => o.returnTo?.() ?? opener);
  return () => {
    target.removeEventListener('keydown', onKey as EventListener);
    const back = o.returnTo?.() ?? opener;
    const active = doc.activeElement;
    const inside = active !== null && root.contains(active);
    if (back?.isConnected && (inside || focusLost(doc))) back.focus();
  };
}

/**
 * React: trap focus in `ref` while `active`. Put it on the dialog or popover element; the
 * options are read fresh on every key press.
 */
export function useFocusTrap(
  ref: RefObject<HTMLElement | null>,
  active: boolean,
  options: FocusTrapOptions = {},
): void {
  const opts = useRef(options);
  useLayoutEffect(() => {
    opts.current = options;
  });
  useEffect(() => {
    const root = ref.current;
    if (!active || !root) return;
    const { escapeAnywhere, cycle } = opts.current;
    const release = trapFocus(root, {
      ...(escapeAnywhere !== undefined && { escapeAnywhere }),
      ...(cycle !== undefined && { cycle }),
      ...(opts.current.onEscape && { onEscape: () => opts.current.onEscape?.() }),
      initial: () => opts.current.initial?.(),
      returnTo: () => opts.current.returnTo?.(),
    });
    // release after React removed the element, so focus is not put back too early
    return () => {
      queueMicrotask(release);
    };
  }, [active, ref]);
}
