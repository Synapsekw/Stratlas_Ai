import { t, useResizableSplit, useT } from '@aio/ui';
import { useWorkspace } from '@aio/workspace';
import { useCallback, useState } from 'react';
import { useShell } from '../shell';
import { AgentHost } from './AgentHost';
import { dockWindow, isDockScreen, type DockScreen } from './dockScreens';

/** The element the title bar button (AgentToggle) folds and unfolds. */
export const AGENT_DOCK_ID = 'agent-dock';

/** The screen the agent column is on now: one of its four, with a project open; else null. */
export function useDockScreen(): DockScreen | null {
  const screen = useShell((s) => s.screen);
  const hasProject = useWorkspace((s) => s.project !== null);
  return hasProject && isDockScreen(screen) ? screen : null;
}

/** The column is on this screen and unfolded: the screen beside it gives it the room. */
export function useAgentDockOpen(): boolean {
  const collapsed = useShell((s) => s.agentDockCollapsed);
  return useDockScreen() !== null && !collapsed;
}

/** The column's width before the person drags it: as before, 360 px or a third of the window. */
const dockDefault = () => Math.min(360, Math.round(window.innerWidth * 0.33));

/** What the split hook writes on its container, taken off `.main` when the column goes. */
const SPLIT_PROPS = ['--split-size', '--split-min', '--split-max'] as const;
const SPLIT_ATTRS = ['data-orientation', 'data-sized', 'data-collapsed', 'data-dragging'] as const;

/**
 * The column's width on the `agent.dock` split. Its container is the main area the screen and the
 * column share (App.tsx `.main`): the hook writes `--split-size` there, and styles.css turns it
 * into `--agent-dock-w`, the column's width and the screen's end inset.
 */
function useDockSplit(open: boolean) {
  // the default is taken when the column first opens, from the window as it is then
  const [firstOpen, setFirstOpen] = useState<number | null>(null);
  if (open && firstOpen === null) setFirstOpen(dockDefault());
  const split = useResizableSplit({
    id: 'agent.dock',
    orientation: 'horizontal',
    sized: 'end',
    unit: 'px',
    defaultSize: firstOpen ?? 360,
    min: 280,
    max: '50%',
    otherMin: 280,
  });
  const { containerRef } = split;
  // The column's parent is the container. `.main` is a <main>, not a <div>; the hook uses only
  // what every element has (its box, style, attributes).
  const attach = useCallback(
    (column: HTMLElement | null) => {
      const main = column?.parentElement;
      if (!main) return;
      containerRef.current = main as HTMLDivElement;
      return () => {
        containerRef.current = null;
        for (const p of SPLIT_PROPS) main.style.removeProperty(p);
        for (const a of SPLIT_ATTRS) main.removeAttribute(a);
      };
    },
    [containerRef],
  );
  return { attach, separatorProps: split.separatorProps };
}

/**
 * The agent in a folding column on the right edge of Issues, Media, Detections and Reports: the
 * same conversation as in the Scene's right panel. Folded until the person asks for it (the title
 * bar button, or the right panel's shortcut), it takes no room and no focus. Open, its inner edge
 * is a handle that drags its width, remembered.
 */
export function AgentDock() {
  useT();
  const screen = useDockScreen();
  const collapsed = useShell((s) => s.agentDockCollapsed);
  const { attach, separatorProps } = useDockSplit(screen !== null && !collapsed);
  if (!screen) return null;
  return (
    <aside
      ref={attach}
      className="agent-dock"
      id={AGENT_DOCK_ID}
      aria-label={t('agent.dock.label')}
      aria-hidden={collapsed}
      inert={collapsed}
    >
      {!collapsed && (
        <div
          {...separatorProps}
          className="split-handle dock-resize"
          aria-label={t('split.agentDock')}
          aria-controls={AGENT_DOCK_ID}
        >
          <span className="kbd split-readout" aria-hidden="true" />
        </div>
      )}
      <div className="agent">
        <AgentHost window={dockWindow(screen)} />
      </div>
    </aside>
  );
}
