import { t, useT } from '@aio/ui';
import { useEffect, useLayoutEffect, useRef, type HTMLAttributes } from 'react';
import { shell, useShell } from '../shell';
import { isLayersOverlay, isSidebarFolded } from '../store';
import { useMeasure } from '../survey/measureStore';
import { PANEL_ID } from './PanelHandle';
import { Datasets } from './Sidebar';
import { SidebarProcessing } from './SidebarProcessing';

/** Where focus goes when the Layers column folds with focus inside it. */
function handFocusOut(): void {
  const to =
    document.querySelector<HTMLElement>('[data-testid="layers-toggle"]') ??
    document.querySelector<HTMLElement>('[data-testid="panel-handle-left"]');
  to?.focus();
}

/** The column's first stop for the keyboard: its tree's current row, the tree, else any control. */
function firstStop(el: HTMLElement): HTMLElement | null {
  return (
    el.querySelector<HTMLElement>('[role="tree"] [tabindex="0"]') ??
    el.querySelector<HTMLElement>('[role="tree"]') ??
    el.querySelector<HTMLElement>('button:not([disabled]), [href], [tabindex="0"]')
  );
}

/**
 * Whether an Escape inside the column closes its overlay: one Escape closes only the innermost
 * thing, so not one a field, a menu, a popover or an inline question (Remove placement) inside the
 * column takes, nor one already used.
 */
export function escapeClosesOverlay(e: {
  key: string;
  defaultPrevented: boolean;
  target: EventTarget | null;
}): boolean {
  if (e.key !== 'Escape' || e.defaultPrevented) return false;
  const at = e.target instanceof Element ? e.target : null;
  if (!at) return true;
  return !at.closest(
    'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="menu"], ' +
      '[role="listbox"], [role="alertdialog"], [role="dialog"]:not(.layers-col), .popover, ' +
      '.trow-confirm',
  );
}

/** The press that closed the overlay goes no further: its mouse events and click are dropped. */
function swallowRestOfPress(): void {
  const kinds = ['pointerup', 'mousedown', 'mouseup', 'click', 'dblclick', 'contextmenu'] as const;
  function stop(): void {
    for (const k of kinds) document.removeEventListener(k, drop, true);
    clearTimeout(timer);
  }
  function drop(e: Event): void {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === 'click') stop();
  }
  for (const k of kinds) document.addEventListener(k, drop, true);
  // a press that never ends in a click (dragged off) frees the events again
  const timer = setTimeout(stop, 1000);
}

export interface LayersColumnProps {
  /** The `shell.sidebar` split's separator (App.tsx): the drag handle on the inner edge. */
  resize?: HTMLAttributes<HTMLDivElement>;
}

/**
 * The Layers column beside the rail, on the Scene only (UI revision W11, D1): the Processing
 * section with "Create maps from photos" in plain sight (founder, 31 Oct 2026), then the dataset
 * tree at full height with its date folders, eyes and import tools. It folds away whole (Ctrl+B,
 * Ctrl+L, the title bar's Layers toggle, the tab on its edge) and is dragged wider or narrower on
 * its inner edge. The window's band places it (shell/layoutBands.ts): open from 1440 px, folded
 * by default from 1280 px, and below that an overlay over the stage that Escape or a click on the
 * stage closes.
 */
export function LayersColumn({ resize }: LayersColumnProps = {}) {
  useT();
  const screen = useShell((s) => s.screen);
  const collapsed = useShell(isSidebarFolded);
  // a reveal of a measurement (the telecom panel's Measurements) opens a folded column; finishing
  // a shape reveals it without opening
  const revealSeq = useMeasure((s) => s.reveal?.seq);
  const revealOpens = useMeasure((s) => s.reveal?.openSidebar === true);
  useEffect(() => {
    if (revealSeq === undefined || !revealOpens) return;
    const sh = shell.getState();
    if (isSidebarFolded(sh)) void sh.toggleSidebar();
  }, [revealSeq, revealOpens]);
  // the overlay below 1280 px: a press on the stage closes it and goes no further (a popover's
  // rule, so it never drops a point or picks anything); the screen change closes it in the store
  const overlay = useShell(isLayersOverlay);
  const overlayOpen = overlay && !collapsed;
  useEffect(() => {
    if (!overlayOpen) return;
    const onPress = (e: PointerEvent) => {
      const at = e.target instanceof Element ? e.target : null;
      if (!at?.closest('.app > .main') || at.closest('.ph[data-side="left"]')) return;
      e.preventDefault();
      e.stopPropagation();
      swallowRestOfPress();
      shell.getState().closeLayersOverlay();
    };
    document.addEventListener('pointerdown', onPress, true);
    return () => {
      document.removeEventListener('pointerdown', onPress, true);
    };
  }, [overlayOpen]);
  // Opening the overlay, focus goes into the column and comes back to what opened it on close.
  // Folding a docked column, focus inside it moves to the title bar's Layers toggle (else the tab
  // on its edge) before the column goes inert, so it never drops to the page.
  const ref = useRef<HTMLElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (overlayOpen) {
      const from = document.activeElement;
      opener.current =
        from instanceof HTMLElement && from !== document.body && !el.contains(from) ? from : null;
      el.toggleAttribute('inert', false);
      firstStop(el)?.focus();
      return;
    }
    const back = opener.current;
    opener.current = null;
    const inside = el.contains(document.activeElement) || document.activeElement === document.body;
    if (collapsed && inside) {
      if (back?.isConnected) back.focus();
      else if (el.contains(document.activeElement)) handFocusOut();
    }
    el.toggleAttribute('inert', collapsed);
  }, [collapsed, overlayOpen, screen]);
  if (screen !== 'scene') return null;

  return (
    <aside
      className="sidebar layers-col"
      id={PANEL_ID.left}
      aria-label={t('nav.layers')}
      // the overlay below 1280 px is a non-modal dialog over the stage
      role={overlay ? 'dialog' : undefined}
      aria-modal={overlay ? false : undefined}
      data-testid="layers-column"
      ref={ref}
      onKeyDown={(e) => {
        if (!overlayOpen || !escapeClosesOverlay(e)) return;
        e.preventDefault();
        shell.getState().closeLayersOverlay();
      }}
    >
      {/* Create maps from photos in plain sight, under its own heading (founder, 31 Oct) */}
      <SidebarProcessing />
      <div className="sb-scroll">
        <Datasets />
      </div>
      {resize && (
        <div
          {...resize}
          className="split-handle sb-resize"
          aria-label={t('panel.resizeLeft')}
          aria-controls={PANEL_ID.left}
        >
          <span className="kbd split-readout" aria-hidden="true" />
        </div>
      )}
    </aside>
  );
}
