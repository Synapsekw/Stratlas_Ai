import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  type HTMLAttributes,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from 'react';
import { useStore } from 'zustand';
import { t } from '../i18n';
import { clampSplit, keyStep, maxPx, snapsToCollapse, type SplitLimits } from './model';
import { splitPrefs } from './prefs';

export interface SplitOptions extends SplitLimits {
  id: string; // prefs key, e.g. 'media.viewer'
  orientation: 'horizontal' | 'vertical'; // horizontal: side by side, col-resize
  sized: 'start' | 'end'; // which pane carries the size
  unit: 'px' | 'fraction';
  defaultSize: number; // px, or 0..1 for fraction
  collapsedSize?: number; // 12 (strip) or 52 (rail); absent: not collapsible
  collapsed?: boolean; // controlled collapse (shortcuts keep working)
  onCollapsedChange?: (collapsed: boolean) => void;
}

export interface ResizableSplitState {
  containerRef: RefObject<HTMLDivElement | null>;
  separatorProps: HTMLAttributes<HTMLDivElement> & { role: 'separator' };
  collapsed: boolean;
  // properties, not methods, so callers can destructure them
  reset: () => void;
  toggle: () => void;
}

/** What the split shows right now, painted straight onto the DOM. */
interface View {
  css: string; // value of --split-size
  px: number; // sized pane, px
  container: number; // container along the split, px
  collapsed: boolean;
}

interface Drag {
  startPos: number;
  startPx: number;
  container: number;
  rect: DOMRect;
  rtl: boolean;
  size: number; // the pref size (unit) when the drag began
  px: number;
  across: number; // pointer along the handle, px from its inline or block start
  collapsed: boolean;
  moved: boolean;
  frame: number;
  stop(): void;
}

const isRtl = (el: Element) => el.closest('[dir]')?.getAttribute('dir') === 'rtl';
const round2 = (n: number) => Math.round(n * 100) / 100;
const round4 = (n: number) => Math.round(n * 10000) / 10000;

/**
 * One resizable split: the sized pane's size lives in the CSS variable `--split-size` on the
 * container. Pointer moves write it inside `requestAnimationFrame` without a React render; the
 * size is saved to `splitPrefs` on pointer up, double-click, keys and toggle.
 */
export function useResizableSplit(o: SplitOptions): ResizableSplitState {
  const uid = useId();
  const handleId = `${uid}split-handle`;
  const paneId = `${uid}split-pane`;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const pref = useStore(splitPrefs, (s) => s.byId[o.id]);

  const horizontal = o.orientation === 'horizontal';
  const collapsedSize = o.collapsedSize;
  const collapsible = collapsedSize !== undefined;
  const size = pref?.size ?? o.defaultSize;
  const collapsed = collapsible && (o.collapsed ?? pref?.collapsed ?? false);

  const measure = (el: HTMLElement) => {
    const rect = el.getBoundingClientRect();
    return { rect, container: horizontal ? rect.width : rect.height };
  };
  const toPx = (s: number, container: number) => (o.unit === 'fraction' ? s * container : s);
  const toUnit = (px: number, container: number) => {
    if (o.unit === 'px') return Math.round(px);
    return container > 0 ? round4(px / container) : o.defaultSize;
  };
  const cssOf = (px: number, container: number) =>
    o.unit === 'fraction' && container > 0
      ? `${String(round2((px / container) * 100))}%`
      : `${String(Math.round(px))}px`;
  /** The sized pane's px at rest, from the saved size. */
  const restingPx = (container: number) => {
    if (collapsed) return collapsedSize;
    const px = toPx(size, container);
    return container > 0 ? clampSplit(px, container, o) : px;
  };

  /** The split at rest, from the saved size; CSS clamps it as the window changes. */
  const restingView = (el: HTMLElement): View => {
    const { container } = measure(el);
    let css: string;
    if (collapsed) css = `${String(collapsedSize)}px`;
    else if (o.unit === 'fraction') css = `${String(round2(size * 100))}%`;
    else css = `${String(size)}px`;
    return { css, px: restingPx(container), container, collapsed };
  };

  const paint = (el: HTMLElement, v: View) => {
    el.style.setProperty('--split-size', v.css);
    el.toggleAttribute('data-collapsed', v.collapsed);
    const handle = el.ownerDocument.getElementById(handleId);
    if (!handle) return;
    const now = Math.round(v.px);
    const max = v.container > 0 ? clampSplit(Infinity, v.container, o) : maxPx(o.max, 0) || o.min;
    const text = t('split.readout', { px: now });
    handle.setAttribute('aria-valuenow', String(now));
    handle.setAttribute('aria-valuemin', String(Math.min(now, o.min)));
    handle.setAttribute('aria-valuemax', String(Math.round(max)));
    handle.setAttribute('aria-valuetext', text);
    const readout = handle.querySelector('.split-readout');
    if (readout) readout.textContent = text;
  };

  // At rest: the saved size, the limits and the layout, written once per commit.
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el || dragRef.current) return;
    el.dataset.orientation = o.orientation;
    el.dataset.sized = o.sized;
    el.style.setProperty('--split-min', `${String(o.min)}px`);
    const max = typeof o.max === 'number' ? `${String(o.max)}px` : o.max;
    el.style.setProperty('--split-max', `min(${max}, 100% - ${String(o.otherMin)}px)`);
    paint(el, restingView(el));
  });

  // A drag in progress when the split unmounts stops listening.
  useEffect(() => () => dragRef.current?.stop(), []);

  const save = (s: number, nextCollapsed: boolean) => {
    splitPrefs.getState().save(o.id, { size: s, collapsed: nextCollapsed });
    if (nextCollapsed !== collapsed) o.onCollapsedChange?.(nextCollapsed);
  };

  const reset = () => {
    save(o.defaultSize, false);
  };
  const toggle = () => {
    if (collapsible) save(size, !collapsed);
  };

  const paintDrag = (el: HTMLElement, d: Drag) => {
    el.setAttribute('data-dragging', '');
    el.ownerDocument
      .getElementById(handleId)
      ?.style.setProperty('--split-pointer', `${String(Math.round(d.across))}px`);
    const css =
      d.collapsed && collapsedSize !== undefined
        ? `${String(collapsedSize)}px`
        : cssOf(d.px, d.container);
    paint(el, { css, px: d.px, container: d.container, collapsed: d.collapsed });
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    const el = containerRef.current;
    if (e.button !== 0 || !el || dragRef.current) return;
    e.preventDefault(); // no text selection; focus by hand below
    const handle = e.currentTarget;
    handle.focus();
    const { rect, container } = measure(el);
    const rtl = isRtl(el);
    const startPx = restingPx(container);
    const pointerId = e.pointerId;
    try {
      handle.setPointerCapture(pointerId);
    } catch {
      // no active pointer of that id (synthetic events): window listeners still follow it
    }
    const win = el.ownerDocument.defaultView ?? window;

    const move = (ev: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      let delta = (horizontal ? ev.clientX : ev.clientY) - d.startPos;
      if (horizontal && d.rtl) delta = -delta;
      if (o.sized === 'end') delta = -delta;
      if (delta !== 0) d.moved = true;
      const raw = d.startPx + delta;
      d.collapsed = collapsible && snapsToCollapse(raw, o);
      d.px =
        d.collapsed && collapsedSize !== undefined
          ? collapsedSize
          : clampSplit(raw, d.container, o);
      if (horizontal) d.across = ev.clientY - d.rect.top;
      else d.across = d.rtl ? d.rect.right - ev.clientX : ev.clientX - d.rect.left;
      if (!d.frame) {
        d.frame = requestAnimationFrame(() => {
          d.frame = 0;
          paintDrag(el, d);
        });
      }
    };
    const end = (commit: boolean) => {
      const d = dragRef.current;
      if (!d) return;
      d.stop();
      if (commit && d.moved) {
        paintDrag(el, d);
        el.removeAttribute('data-dragging');
        // a drag into collapse keeps the size it started from, for the way back
        if (d.collapsed) save(d.size, true);
        else save(toUnit(d.px, d.container), false);
        return;
      }
      el.removeAttribute('data-dragging');
      paint(el, restingView(el));
    };
    const up = () => {
      end(true);
    };
    const cancel = () => {
      end(false);
    };

    dragRef.current = {
      startPos: horizontal ? e.clientX : e.clientY,
      startPx,
      container,
      rect,
      rtl,
      size,
      px: startPx,
      across: 0,
      collapsed,
      moved: false,
      frame: 0,
      stop: () => {
        const d = dragRef.current;
        if (d?.frame) cancelAnimationFrame(d.frame);
        dragRef.current = null;
        win.removeEventListener('pointermove', move);
        win.removeEventListener('pointerup', up);
        win.removeEventListener('pointercancel', cancel);
        try {
          if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId);
        } catch {
          // already released
        }
      },
    };
    win.addEventListener('pointermove', move);
    win.addEventListener('pointerup', up);
    win.addEventListener('pointercancel', cancel);
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const el = containerRef.current;
    if (!el) return;
    const cross = horizontal
      ? e.key === 'ArrowUp' || e.key === 'ArrowDown'
      : e.key === 'ArrowLeft' || e.key === 'ArrowRight';
    if (cross) return;
    const step = keyStep(e.key, e.shiftKey, isRtl(el), o.sized);
    if (step === null || (step === 'toggle' && !collapsible)) return;
    e.preventDefault();
    if (step === 'toggle') {
      toggle();
      return;
    }
    const { container } = measure(el);
    let px: number;
    if (step === 'min') px = o.min;
    else if (step === 'max') px = clampSplit(Infinity, container, o);
    else px = clampSplit(restingPx(container) + step, container, o);
    save(toUnit(px, container), false);
  };

  return {
    containerRef,
    separatorProps: {
      id: handleId,
      role: 'separator',
      className: 'split-handle',
      tabIndex: 0,
      'aria-orientation': horizontal ? 'vertical' : 'horizontal',
      'aria-controls': paneId,
      onPointerDown,
      onKeyDown,
      onDoubleClick: reset,
    },
    collapsed,
    reset,
    toggle,
  };
}
