import { useWorkspace } from '@aio/workspace';
import { t, Tip, useT } from '@aio/ui';
import { useEffect, useRef, useSyncExternalStore } from 'react';
import type { StoreApi } from 'zustand/vanilla';
import { appAgentSession } from '../agent/session';
import type { ResolvedBackend } from '../inspect/askAi/backend';
import { cloudAiBlocked } from '../player';
import { shell } from '../shell';
import { useShellStore, type Shell } from '../store';
import { AI_CHECKING, AI_LOOK, aiStatus, type AiStatus } from './aiStatus';
import { openAgent } from './RightHeader';
import './aiStatus.css';

/**
 * The one AI status (aiStatus.ts) from the live sources: the settings, the agent session, the open
 * project's or package's AI policy and the local model; `askBackend` where Ask AI on a photo knows
 * what it would use (Inspect). A change of the AI settings has the session check again, so the
 * state follows a switch also where no agent panel is mounted.
 */
export function useAiStatus(
  askBackend: ResolvedBackend | null = null,
  store: StoreApi<Shell> = shell,
): AiStatus {
  const cloudAi = useShellStore(store, (s) => s.settings.cloudAi);
  const offlineOnly = useShellStore(store, (s) => s.settings.offlineOnly === true);
  const localModel = useShellStore(store, (s) => {
    const lm = s.settings.localModel;
    if (!lm) return 'absent' as const;
    const chat = s.settings.routes.find((r) => r.task === 'chat');
    return lm.enabled && chat?.provider === 'local' ? ('running' as const) : ('stopped' as const);
  });
  const pkgBlocked = useShellStore(store, (s) => cloudAiBlocked(s.pkg));
  const manifestPolicy = useWorkspace((s) => s.project?.manifest.aiPolicy);
  const aiKey = useShellStore(store, (s) =>
    JSON.stringify([s.settings.cloudAi, s.settings.offlineOnly === true, s.settings.routes]),
  );
  const session = appAgentSession();
  const agent = useSyncExternalStore(session.subscribe, () => session.getState().availability);
  const seen = useRef(aiKey);
  useEffect(() => {
    if (seen.current === aiKey) return;
    seen.current = aiKey;
    void session.refresh();
  }, [aiKey, session]);
  return aiStatus({
    settings: { cloudAi, offlineOnly },
    agent,
    askBackend,
    projectPolicy: pkgBlocked ? 'forbid' : manifestPolicy,
    localModel,
  });
}

/** Open what fixes the state, or Ask AI itself when nothing needs fixing. */
export function openAiFix(status: AiStatus, store: StoreApi<Shell> = shell): void {
  if (status.fix) store.getState().openSettingsPage(status.fix);
  else openAgent();
}

/**
 * The AI status chip: a dot and the state in words ("AI ready", "Offline AI", "AI off: no key").
 * Green only when a request would run now; amber when something the person can fix stops it. A
 * click opens Ask AI, or the Settings page that fixes it. In the sidebar's status row during Wave
 * 1 (`ai-status-chip`), and in the agent's header (`agent-ai-chip`).
 */
export function AiStatusChip({
  store = shell,
  className = '',
  testId = 'ai-status-chip',
  placement = 'top',
  onOpen,
}: {
  store?: StoreApi<Shell>;
  className?: string;
  testId?: string;
  /** Where its tip opens: above in the sidebar's foot, below in a header. */
  placement?: 'top' | 'bottom';
  /** Before the fix opens (a menu closes). */
  onOpen?: () => void;
}) {
  useT();
  const status = useAiStatus(null, store);
  const look = status.checking ? AI_CHECKING : AI_LOOK[status.state];
  return (
    <Tip content={t(look.tip)} placement={placement}>
      <button
        type="button"
        className={`chip-status ai-chip ${className}`.trim()}
        data-state={status.checking ? 'checking' : status.state}
        data-tone={look.tone}
        data-testid={testId}
        onClick={() => {
          onOpen?.();
          openAiFix(status, store);
        }}
      >
        <span className="ai-dot" aria-hidden="true" />
        {t(look.label)}
      </button>
    </Tip>
  );
}
