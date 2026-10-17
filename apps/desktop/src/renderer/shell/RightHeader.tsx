import { Button, t, useT } from '@aio/ui';
import { AgentToggle } from '../agent/AgentToggle';
import { useShell } from '../shell';
import { SyncStatus } from '../team/SyncStatus';
import { PANEL_ID } from './PanelHandle';

/** The Agent and Share controls, at the end of a page header. */
export function HeaderControls() {
  return (
    <>
      <AgentToggle />
      <SyncStatus />
    </>
  );
}

/**
 * Takes the person to the Scene's agent, the lower pane of the right panel (`scene.ctxAgent`):
 * its message box when the agent can be asked, else the first control in the pane.
 */
export function focusSceneAgent(): void {
  const pane = document.getElementById(PANEL_ID.right)?.querySelector<HTMLElement>('.agent');
  if (!pane) return;
  const target =
    pane.querySelector<HTMLElement>('textarea:not(:disabled)') ??
    pane.querySelector<HTMLElement>('button:not(:disabled), [href], input:not(:disabled)');
  target?.focus();
}

/** The Scene's Agent button: the agent is in the right panel, so it takes the person there. */
function SceneAgentButton() {
  useT();
  const scene = useShell((s) => s.screen === 'scene');
  const folded = useShell((s) => s.rightCollapsed);
  if (!scene || folded) return null;
  return (
    <Button
      variant="quiet"
      icon="agent"
      data-testid="agent-open"
      tip={t('island.askAgent')}
      onClick={focusSceneAgent}
    >
      {t('agent.dock.name')}
    </Button>
  );
}

/**
 * The right sidebar's 40 px header row: Agent and Share. It is a window drag region (styles.css),
 * and its end keeps clear of the window's caption buttons (`--caption-end`). Folded away, it goes
 * with the panel and only the window's own buttons stay.
 */
export function RightHeader() {
  return (
    <div className="right-head" data-testid="right-head">
      <SceneAgentButton />
      <SyncStatus />
    </div>
  );
}
