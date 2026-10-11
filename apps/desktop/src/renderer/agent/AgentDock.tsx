import { t, useT } from '@aio/ui';
import { useWorkspace } from '@aio/workspace';
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

/**
 * The agent in a folding column on the right edge of Issues, Media, Detections and Reports: the
 * same conversation as in the Scene's right panel. Folded until the person asks for it (the title
 * bar button, or the right panel's shortcut), it takes no room and no focus.
 */
export function AgentDock() {
  useT();
  const screen = useDockScreen();
  const collapsed = useShell((s) => s.agentDockCollapsed);
  if (!screen) return null;
  return (
    <aside
      className="agent-dock"
      id={AGENT_DOCK_ID}
      aria-label={t('agent.dock.label')}
      aria-hidden={collapsed}
      inert={collapsed}
    >
      <div className="agent">
        <AgentHost window={dockWindow(screen)} />
      </div>
    </aside>
  );
}
