import { ariaKeys, Icon, t, useT } from '@aio/ui';
import { shell, useShell } from '../shell';
import { AGENT_DOCK_ID, useDockScreen } from './AgentDock';

/**
 * The Agent chip of the title bar: folds and unfolds the agent column (AgentDock) on the screens
 * that have one. The Scene has no chip: its agent is in the right panel, with its own handle.
 */
export function AgentToggle() {
  useT();
  const shown = useDockScreen() !== null;
  const collapsed = useShell((s) => s.agentDockCollapsed);
  if (!shown) return null;
  return (
    <button
      type="button"
      className="chip-status agent-toggle"
      data-testid="agent-toggle"
      title={t('agent.dock.tip')}
      aria-expanded={!collapsed}
      aria-controls={AGENT_DOCK_ID}
      aria-keyshortcuts={ariaKeys('global.rightPanel')}
      onClick={shell.getState().toggleAgentDock}
    >
      <Icon name="agent" size={14} />
      {t('agent.dock.name')}
    </button>
  );
}
