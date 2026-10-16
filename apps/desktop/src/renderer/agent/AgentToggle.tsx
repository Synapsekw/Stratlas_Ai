import { Button, t, useT } from '@aio/ui';
import { shell, useShell } from '../shell';
import { AGENT_DOCK_ID, useDockScreen } from './AgentDock';

/**
 * The Agent button of a page header: folds and unfolds the agent column (AgentDock) on the screens
 * that have one. The Scene shows none yet: its agent is in the right panel, with its own handle.
 * Below 1280 px of window width it is the icon alone (styles.css); the name is still the button's.
 */
export function AgentToggle() {
  useT();
  const shown = useDockScreen() !== null;
  const collapsed = useShell((s) => s.agentDockCollapsed);
  if (!shown) return null;
  return (
    <Button
      variant="quiet"
      icon="agent"
      className="agent-toggle"
      data-testid="agent-toggle"
      tip={t('agent.dock.tip')}
      shortcut="global.rightPanel"
      aria-expanded={!collapsed}
      aria-controls={AGENT_DOCK_ID}
      onClick={shell.getState().toggleAgentDock}
    >
      <span className="lbl">{t('agent.dock.name')}</span>
    </Button>
  );
}
