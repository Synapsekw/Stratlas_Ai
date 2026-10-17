/**
 * The workbench drawer (stage island D20): with the right sidebar hidden (Ctrl+Alt+B), the same
 * front bench slides in over the stage's end edge when a tool the person started goes live (I-R39:
 * not clip playback or jobs, which the island's live status shows) or the island is clicked, and
 * slides out on Esc or when the tool ends. It holds the bench only: no agent. It moves with a
 * transform, so the 3D view and the map are not resized, and it tells the stage how much it covers
 * (`--drawer-inline`) so the island centres on the rest (I-R42). A click on the island traps focus
 * in it and Esc gives focus back to the island; a tool start leaves the focus on the stage, where
 * the person is working. While it shows, the collapsed sidebar renders no bench (I-R38).
 */
import { IconButton, useFocusTrap, useT } from '@aio/ui';
import { useWorkspace } from '@aio/workspace';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useIsRoad } from '../../road/useRoadMap';
import { useShell } from '../../shell';
import './drawer.css';
import { drawerStore, useDrawer } from './drawerStore';
import { FrontBody } from './RightSidebar';
import { useWorkbenchView } from './view';
import { useWorkbench } from './workbenchStore';

/** How long a closed drawer stays mounted for its slide out, if no transition ends first. */
const SLIDE_MS = 320;

const islandWrap = () => document.querySelector<HTMLElement>('.island-wrap');

export function Drawer() {
  const t = useT();
  const collapsed = useShell((s) => s.rightCollapsed);
  const hasProject = useWorkspace((s) => s.project !== null);
  const road = useIsRoad();
  const { front } = useWorkbenchView();
  const toolSeq = useWorkbench((s) => s.toolSeq);
  const liveTools = useWorkbench((s) => s.liveTools);
  const opened = useDrawer((s) => s.opened);
  const [mounted, setMounted] = useState(false);
  const panel = useRef<HTMLElement | null>(null);

  const available = collapsed && hasProject;
  const open = available && opened !== null;
  // render while open, and for the slide out after it
  if (open && !mounted) setMounted(true);

  /** Close it; focus that was inside goes back to the island, not to the page. */
  const hide = () => {
    if (panel.current?.contains(document.activeElement)) islandWrap()?.focus();
    drawerStore.getState().close();
  };

  // a tool the person starts opens it (toolStarted only, I-R39)
  const seenSeq = useRef(toolSeq);
  useEffect(() => {
    if (seenSeq.current === toolSeq) return;
    seenSeq.current = toolSeq;
    if (available) drawerStore.getState().open('live');
  }, [toolSeq, available]);

  // the tool ending closes the drawer it opened
  useEffect(() => {
    if (liveTools === 0 && drawerStore.getState().opened === 'live') hide();
  }, [liveTools]);

  // the sidebar coming back, or the project closing, ends it
  useEffect(() => {
    if (!available) drawerStore.getState().close();
  }, [available]);

  // a click on the island itself (not one of its buttons) at rest opens it
  useEffect(() => {
    if (!available) return;
    const onClick = (e: MouseEvent) => {
      const target = e.target instanceof Element ? e.target : null;
      const wrap = target?.closest<HTMLElement>('.island-wrap');
      if (!target || !wrap || !target.closest('.island') || target.closest('button')) return;
      const state = wrap.dataset.state;
      if (state === 'tools' || state === 'date') return;
      drawerStore.getState().open('click');
    };
    document.addEventListener('click', onClick, true);
    return () => {
      document.removeEventListener('click', onClick, true);
    };
  }, [available]);

  // Esc closes a drawer a tool opened, unless something nearer already took it (a menu, a
  // popover, the tool's own Esc); a click-opened one traps focus (below)
  useEffect(() => {
    if (!open || opened !== 'live') return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) hide();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [open, opened]);
  useFocusTrap(panel, open && opened === 'click', {
    onEscape: hide,
    initial: () => panel.current?.querySelector<HTMLElement>('button, [href], input, textarea'),
    returnTo: islandWrap,
  });

  // the sidebar leaves its bench to the drawer for as long as the drawer is on screen
  useEffect(() => {
    drawerStore.getState().setPresent(mounted);
    return () => {
      drawerStore.getState().setPresent(false);
    };
  }, [mounted]);

  // the stage learns how much the drawer covers, so the island centres on the rest
  useLayoutEffect(() => {
    const el = panel.current;
    const stage = el?.parentElement?.querySelector<HTMLElement>(':scope > .stage');
    if (!el || !stage) return;
    if (!open) {
      stage.style.removeProperty('--drawer-inline');
      return;
    }
    // the drawer's box moves while it slides, so measure its width against the screen's end edge
    const cover = () => {
      const s = stage.getBoundingClientRect();
      const col = el.parentElement?.getBoundingClientRect() ?? s;
      const w = el.offsetWidth;
      // it sits at the screen's end edge, the physical left right to left
      const rtl = getComputedStyle(el).direction === 'rtl';
      const [from, to] = rtl ? [col.left, col.left + w] : [col.right - w, col.right];
      const overlap = Math.max(0, Math.min(s.right, to) - Math.max(s.left, from));
      stage.style.setProperty('--drawer-inline', `${String(Math.round(overlap))}px`);
    };
    cover();
    const watch = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(cover);
    watch?.observe(stage);
    return () => {
      watch?.disconnect();
      stage.style.removeProperty('--drawer-inline');
    };
  }, [open, mounted]);

  // unmount after the slide out
  useEffect(() => {
    if (open || !mounted) return;
    const timer = setTimeout(() => {
      setMounted(false);
    }, SLIDE_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [open, mounted]);

  if (!mounted) return null;
  const label = t(`wb.tab.${front.id}`);
  return (
    <aside
      ref={panel}
      className="wb-drawer"
      data-testid="wb-drawer"
      data-surface="dark"
      data-open={open ? '' : undefined}
      data-front={front.id}
      aria-label={t('wb.drawer', { tab: label })}
      inert={!open}
    >
      <header className="wb-drawer-head">
        <h2 className="wb-drawer-title">{label}</h2>
        <IconButton icon="x" label={t('dialog.close')} onClick={hide} />
      </header>
      <div className="ctx-wrap wb-body tall wb-drawer-body" data-front={front.id}>
        <FrontBody front={front.id} road={road} />
      </div>
    </aside>
  );
}
