/**
 * The workbench drawer (stage island D20): with the right sidebar hidden (Ctrl+Alt+B), the same
 * front bench slides in over the stage's end edge when something goes live or the island is
 * clicked, and slides out on Esc or when the live item ends. It holds the bench only: no agent.
 * It moves with a transform, so the 3D view and the map are not resized. A click on the island
 * traps focus in it and Esc gives focus back to the island; a live start (a survey tool being
 * drawn, a clip playing, a job) leaves the focus on the stage, where the person is working.
 */
import { IconButton, useFocusTrap, useT } from '@aio/ui';
import { useWorkspace } from '@aio/workspace';
import { useEffect, useRef, useState } from 'react';
import { useIsRoad } from '../../road/useRoadMap';
import { useShell } from '../../shell';
import { useIslandLive } from '../island/useIslandLive';
import './drawer.css';
import { FrontBody, useWorkbenchView } from './RightSidebar';

/** How long a closed drawer stays mounted for its slide out, if no transition ends first. */
const SLIDE_MS = 320;

type Opened = 'live' | 'click';

/** The live things that open the drawer; the connection is not work to look at. */
function liveKeys(items: ReturnType<typeof useIslandLive>): Set<string> {
  const keys = new Set<string>();
  for (const i of items) {
    if (i.kind === 'connection') continue;
    keys.add(i.kind === 'job' ? `job:${i.id}` : i.kind);
  }
  return keys;
}

export function Drawer() {
  const t = useT();
  const collapsed = useShell((s) => s.rightCollapsed);
  const hasProject = useWorkspace((s) => s.project !== null);
  const road = useIsRoad();
  const { front } = useWorkbenchView();
  const items = useIslandLive();
  const [opened, setOpened] = useState<Opened | null>(null);
  const [mounted, setMounted] = useState(false);
  const panel = useRef<HTMLElement | null>(null);

  const available = collapsed && hasProject;
  const open = available && opened !== null;
  // render while open, and for the slide out after it
  if (open && !mounted) setMounted(true);

  // a live start opens it, a live item ending closes the drawer it opened; the sidebar coming
  // back, or the project closing, ends it (state settled while rendering, as React advises)
  const keyList = [...liveKeys(items)].sort().join('|');
  const [seen, setSeen] = useState(keyList);
  if (seen !== keyList) {
    setSeen(keyList);
    const before = new Set(seen.split('|').filter(Boolean));
    const now = keyList.split('|').filter(Boolean);
    if (available && now.some((k) => !before.has(k))) setOpened('live');
    else if (now.length === 0 && opened === 'live') setOpened(null);
  }
  if (!available && opened !== null) setOpened(null);

  // a click on the island itself (not one of its buttons) at rest opens it
  useEffect(() => {
    if (!available) return;
    const onClick = (e: MouseEvent) => {
      const target = e.target instanceof Element ? e.target : null;
      const wrap = target?.closest<HTMLElement>('.island-wrap');
      if (!target || !wrap || !target.closest('.island') || target.closest('button')) return;
      const state = wrap.dataset.state;
      if (state === 'tools' || state === 'date') return;
      setOpened((o) => o ?? 'click');
    };
    document.addEventListener('click', onClick, true);
    return () => {
      document.removeEventListener('click', onClick, true);
    };
  }, [available]);

  const close = () => {
    setOpened(null);
  };

  // Esc anywhere closes a drawer a live start opened; a click-opened one traps focus (below)
  useEffect(() => {
    if (!open || opened !== 'live') return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [open, opened]);
  useFocusTrap(panel, open && opened === 'click', {
    onEscape: close,
    initial: () => panel.current?.querySelector<HTMLElement>('button, [href], input, textarea'),
    returnTo: () => document.querySelector<HTMLElement>('.island-wrap'),
  });

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
        <IconButton icon="x" label={t('dialog.close')} onClick={close} />
      </header>
      <div className="ctx-wrap wb-body tall wb-drawer-body" data-front={front.id}>
        <FrontBody front={front.id} road={road} />
      </div>
    </aside>
  );
}
