/**
 * One truthful AI status (design section 6): what Ask AI can do right now, from the shell settings
 * (`cloudAi`, `offlineOnly`), the agent session's own check (`ai:status` through the session), the
 * Ask AI photo backend (`resolveBackend`) when one is known, the open project's `aiPolicy` and the
 * local model. Green means a request would run now, never "permitted".
 *
 * The order, decided once here so the chip, the agent pane's off row and Inspect cannot disagree:
 * 1. cloud AI that would answer, with nothing stopping it, is ready;
 * 2. a request that would run on the model on this computer wins over every block (Offline AI);
 * 3. offline only, the cloud switch off and a project that keeps its data local each win over a
 *    stale cloud "ready" (the session may not have checked again yet);
 * 4. then the agent's own reason;
 * 5. anything else is no key. While the agent is still checking at start-up that last row is
 *    `checking`, so the chip does not flash amber.
 *
 * Room for one more state: the bundled "offline agent ready" (design section 13) goes between
 * `ready` and `local` in `AiState` and gets its row in `AI_LOOK`.
 */
import type { SessionState } from '@aio/ai';
import type { AiPolicy } from '@aio/schema';
import type { MessageKey } from '@aio/ui';
import type { ResolvedBackend } from '../inspect/askAi/backend';
import type { SettingsPage } from '../store';

export type AiState = 'ready' | 'local' | 'no-key' | 'offline' | 'project-off' | 'cloud-off';

/** Where the fix is: Settings, AI providers or Settings, Privacy and cloud. */
export type AiFix = Extract<SettingsPage, 'ai' | 'privacy'>;

export type AgentAvailability = SessionState['availability'];

export interface AiStatusInput {
  settings: { cloudAi: boolean; offlineOnly: boolean };
  agent: AgentAvailability;
  /** What Ask AI on a photo would use, where that is known (Inspect); null elsewhere. */
  askBackend: ResolvedBackend | null;
  projectPolicy: AiPolicy | undefined;
  /** `running`: the local model is on and the chat route goes to it. */
  localModel: 'running' | 'stopped' | 'absent';
}

export interface AiStatus {
  state: AiState;
  /** The Settings page that fixes it; null when nothing needs fixing (the chip opens Ask AI). */
  fix: AiFix | null;
  /** The agent has not answered yet and nothing else decides: show a neutral "Checking". */
  checking: boolean;
}

export type AiTone = 'ok' | 'warn' | 'neutral';

/** How each state looks: its words, its tip and the colour of its dot. */
export const AI_LOOK: Record<AiState, { label: MessageKey; tip: MessageKey; tone: AiTone }> = {
  ready: { label: 'aiStatus.ready', tip: 'aiStatus.readyTip', tone: 'ok' },
  local: { label: 'aiStatus.local', tip: 'aiStatus.localTip', tone: 'neutral' },
  'no-key': { label: 'aiStatus.noKey', tip: 'aiStatus.noKeyTip', tone: 'warn' },
  offline: { label: 'aiStatus.offline', tip: 'aiStatus.offlineTip', tone: 'neutral' },
  'project-off': { label: 'aiStatus.projectOff', tip: 'aiStatus.projectOffTip', tone: 'warn' },
  'cloud-off': { label: 'aiStatus.cloudOff', tip: 'aiStatus.cloudOffTip', tone: 'neutral' },
};

/** The look while the agent is still checking at start-up. */
export const AI_CHECKING = {
  label: 'aiStatus.checking',
  tip: 'aiStatus.checkingTip',
  tone: 'neutral',
} as const satisfies { label: MessageKey; tip: MessageKey; tone: AiTone };

const FIX: Record<AiState, AiFix | null> = {
  ready: null,
  local: null,
  'no-key': 'ai',
  offline: 'privacy',
  // Project settings belong to the settings reorganisation; Privacy and cloud holds it for now
  'project-off': 'privacy',
  'cloud-off': 'privacy',
};

const REASON: Partial<Record<string, AiState>> = {
  'offline-only': 'offline',
  'cloud-off': 'cloud-off',
  forbidden: 'project-off',
};

const out = (state: AiState, checking = false): AiStatus => ({
  state,
  fix: FIX[state],
  checking,
});

export function aiStatus(i: AiStatusInput): AiStatus {
  const { agent, askBackend } = i;
  const block: AiState | null = i.settings.offlineOnly
    ? 'offline'
    : !i.settings.cloudAi
      ? 'cloud-off'
      : i.projectPolicy === 'forbid'
        ? 'project-off'
        : null;
  const cloudReady = (agent.status === 'ready' && agent.cloud) || askBackend?.kind === 'cloud';
  if (cloudReady && !block) return out('ready');
  // the local model on, but its route refused (the server down, no vision): not Offline AI
  const local =
    (agent.status === 'ready' && !agent.cloud) ||
    askBackend?.kind === 'local' ||
    (i.localModel === 'running' && agent.status !== 'disabled');
  if (local) return out('local');
  if (block) return out(block);
  if (agent.status === 'disabled') {
    // a switch or a policy the agent has not seen change yet: its next check decides, quietly
    const stale =
      (agent.reason === 'cloud-off' && i.settings.cloudAi) ||
      (agent.reason === 'offline-only' && !i.settings.offlineOnly) ||
      (agent.reason === 'forbidden' && i.projectPolicy !== 'forbid');
    return stale ? out('no-key', true) : out(REASON[agent.reason] ?? 'no-key');
  }
  return out('no-key', agent.status === 'checking');
}
