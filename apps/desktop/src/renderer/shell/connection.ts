import type { IconName, MessageKey } from '@aio/ui';
import { useSyncExternalStore } from 'react';

/**
 * What the title bar says about the network: the mode the workstation is in (`offlineOnly` in
 * Settings, the one switch main checks before any network use) and what that leaves of cloud AI.
 * One function decides both, so the pair cannot disagree: offline only never comes with a cloud AI
 * that reads as on.
 */
export type ConnectionMode = 'online' | 'offline';

/** Cloud AI as it really is: `blocked` is the person's switch on, with something stopping it. */
export type CloudState = 'on' | 'off' | 'blocked';

export interface ConnectionInput {
  /** `settings.offlineOnly`: the workstation makes no network connection. */
  offlineOnly: boolean;
  /** `settings.cloudAi`: the person allowed cloud AI. */
  cloudAi: boolean;
  /** The open package forbids cloud AI (`cloudAiBlocked(pkg)`). */
  pkgBlocked: boolean;
}

export interface ConnectionStatus {
  mode: ConnectionMode;
  modeIcon: IconName;
  modeLabel: MessageKey;
  modeTip: MessageKey;
  cloud: CloudState;
  /** Cloud AI can answer right now. */
  cloudActive: boolean;
  /** What stops cloud AI apart from its own switch; offline only comes first, it stops everything. */
  cloudStoppedBy: 'offline' | 'package' | null;
  cloudLabel: MessageKey;
  cloudTip: MessageKey;
  /** The same state in one word, for the popover row. */
  cloudWord: MessageKey;
}

export function connectionStatus({
  offlineOnly,
  cloudAi,
  pkgBlocked,
}: ConnectionInput): ConnectionStatus {
  const stoppedBy = offlineOnly ? 'offline' : pkgBlocked ? 'package' : null;
  const cloud: CloudState = !cloudAi ? 'off' : stoppedBy ? 'blocked' : 'on';
  return {
    mode: offlineOnly ? 'offline' : 'online',
    modeIcon: offlineOnly ? 'offline' : 'globe',
    modeLabel: offlineOnly ? 'titlebar.offlineOnly' : 'titlebar.online',
    modeTip: offlineOnly ? 'titlebar.offlineOnlyTip' : 'titlebar.onlineTip',
    cloud,
    cloudActive: cloud === 'on',
    cloudStoppedBy: stoppedBy,
    cloudLabel:
      cloud === 'on'
        ? 'titlebar.cloudOn'
        : cloud === 'blocked'
          ? 'titlebar.cloudBlocked'
          : 'titlebar.cloudOff',
    cloudTip:
      stoppedBy === 'offline'
        ? 'titlebar.cloudOfflineTip'
        : stoppedBy === 'package'
          ? 'titlebar.cloudBlockedTip'
          : cloud === 'on'
            ? 'titlebar.cloudOnTip'
            : 'titlebar.cloudOffTip',
    cloudWord:
      cloud === 'on'
        ? 'connection.on'
        : cloud === 'blocked'
          ? 'connection.blocked'
          : 'connection.off',
  };
}

function watchNetwork(changed: () => void): () => void {
  window.addEventListener('online', changed);
  window.addEventListener('offline', changed);
  return () => {
    window.removeEventListener('online', changed);
    window.removeEventListener('offline', changed);
  };
}

/**
 * Whether the computer has a network at all, as the operating system reports it
 * (`navigator.onLine` and its events). Nothing is asked of any server to find out.
 */
export function useNetworkUp(): boolean {
  return useSyncExternalStore(
    watchNetwork,
    () => navigator.onLine,
    () => true,
  );
}
