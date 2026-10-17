import { Button, t, useT } from '@aio/ui';
import { workspace } from '@aio/workspace';
import { AGENT_DOCK_ID } from '../agent/AgentDock';
import { AgentToggle } from '../agent/AgentToggle';
import { isDockScreen } from '../agent/dockScreens';
import { shell, useShell } from '../shell';
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
 * Puts the cursor in an agent pane: its message box when the agent can be asked, else the first
 * control in the pane (the agent off, or blocked). By role, never by name, so it holds in every
 * language. True when the focus took (a pane still folded away takes none).
 */
function focusAgentIn(pane: Element | null | undefined): boolean {
  if (!pane) return false;
  const target =
    pane.querySelector<HTMLElement>('textarea:not(:disabled)') ??
    pane.querySelector<HTMLElement>('button:not(:disabled), [href], input:not(:disabled)');
  target?.focus();
  return !!target && document.activeElement === target;
}

const sceneAgent = () => document.getElementById(PANEL_ID.right)?.querySelector('.agent');
const dockAgent = () => document.getElementById(AGENT_DOCK_ID)?.querySelector('.agent');

/** Takes the person to the Scene's agent, the lower pane of the right panel (`scene.ctxAgent`). */
export function focusSceneAgent(): void {
  focusAgentIn(sceneAgent());
}

/** How many frames a panel that is unfolding gets to show before the focus stops trying. */
const UNFOLD_FRAMES = 40;

/**
 * The ways in to the agent (D25: Ctrl+J, the View row's Ask the agent): open it where this screen
 * has one and put the cursor in it. On the Scene it is the right panel's lower pane, the panel
 * unfolded first; on Issues, Media, Detections and Reports it is the agent column, unfolded
 * first. Screens without an agent (Projects, the Globe, Settings, Help) are left as they are.
 */
export function openAgent(): void {
  const s = shell.getState();
  let pane: () => Element | null | undefined;
  if (s.screen === 'scene') {
    if (s.rightCollapsed) s.toggleRight();
    pane = sceneAgent;
  } else if (isDockScreen(s.screen) && workspace.getState().project) {
    if (s.agentDockCollapsed) s.setAgentDock(false);
    pane = dockAgent;
  } else return;
  // an unfolding panel takes the focus once it shows
  let frames = 0;
  const go = () => {
    if (focusAgentIn(pane()) || ++frames > UNFOLD_FRAMES) return;
    requestAnimationFrame(go);
  };
  go();
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

/**
 * The dark strip behind the window's own buttons where they sit over the stage (D28): the right
 * panel folded away, so the stage runs to the window's edge, and, right to left, the main area's
 * start when the left sidebar is only a rail (I-R23: the buttons then reach about 86 px past it).
 * Its place and size are physical, as the buttons are (I-R14); styles.css gives it its width
 * (`--caption-right`, nothing where the window draws no buttons) and when it shows.
 */
export function CaptionBacking() {
  return (
    <div
      className="caption-backing"
      data-testid="caption-backing"
      data-surface="dark"
      aria-hidden="true"
    />
  );
}
