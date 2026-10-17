import { AgentPanel } from '@aio/ai';
import type { AiTask, WindowKind } from '@aio/schema';
import { useEffect, type ReactNode } from 'react';
import { cloudAiBlocked } from '../player';
import { shell, useShell } from '../shell';
import { CloudChip } from '../shell/ConnectionStatus';
import { AgentFixCard } from '../workspace/AgentFixCard';
import { appAgentSession, setAgentTask, setAgentWindow } from './session';

/**
 * The agent panel on the app's one session (session.ts), wherever it is shown: the Scene's right
 * panel and the agent column of the other project screens. It binds the session to the window of
 * the screen it is on; a package that forbids cloud AI gets a sentence instead of the panel.
 */
export function AgentHost({
  window: win,
  task,
  className,
  actions,
}: {
  window: WindowKind;
  task?: AiTask | undefined;
  className?: string;
  /** Buttons at the end of the agent's header (the Scene's pane: Minimise and Maximise). */
  actions?: ReactNode;
}) {
  const pkg = useShell((s) => s.pkg);
  // the agent checks its route again when the AI settings change
  const aiKey = useShell((s) =>
    JSON.stringify([
      s.settings.cloudAi,
      s.settings.offlineOnly === true,
      s.settings.routes,
      s.settings.localModel,
    ]),
  );
  // the tools run against the screen that shows the panel now, on the route this screen asks for
  useEffect(() => {
    setAgentWindow(win);
    setAgentTask(task);
  }, [win, task]);

  if (cloudAiBlocked(pkg)) {
    return (
      <>
        <div className="agent-blocked-h">
          <CloudChip store={shell} testId="agent-cloud-chip" />
        </div>
        <p className="faint small" style={{ padding: 12 }} data-testid="agent-blocked">
          This package does not allow cloud AI. Nothing from it is sent to any provider.
        </p>
      </>
    );
  }
  return (
    <AgentPanel
      session={appAgentSession()}
      window={win}
      task={task}
      settingsKey={aiKey}
      className={className ? `agent-host ${className}` : 'agent-host'}
      renderFix={(controls) => <AgentFixCard {...controls} />}
      // cloud AI as it is now, in the header (the title bar showed it before it went)
      status={<CloudChip store={shell} testId="agent-cloud-chip" />}
      actions={actions}
    />
  );
}
