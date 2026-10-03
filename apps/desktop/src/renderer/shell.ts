import type { IpcChannel, IpcRequest, IpcResponse } from '@aio/schema';
import { workspace } from '@aio/workspace';
import { useEffect, useState } from 'react';
import { createBridge, type Res } from './bridge';
import { getShell, useShellStore, type Shell } from './store';

/** Typed, never-throwing access to main. */
export const bridge = createBridge(window.aio);

/** The app shell store: screen, settings, library, palette and stage layout. */
export const shell = getShell(workspace);

/** Call a read-only channel when `key` changes; null while loading. */
export function useCall<C extends IpcChannel>(
  channel: C,
  request: IpcRequest<C>,
  key: unknown = null,
): Res<IpcResponse<C>> | null {
  const [res, setRes] = useState<{ key: unknown; res: Res<IpcResponse<C>> } | null>(null);
  useEffect(() => {
    let live = true;
    void bridge.call(channel, request).then((r) => {
      if (live) setRes({ key, res: r });
    });
    return () => {
      live = false;
    };
    // The request object is rebuilt each render; `key` says when to refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channel, key]);
  return res && res.key === key ? res.res : null;
}

export function useShell<T>(selector: (s: Shell) => T): T {
  return useShellStore(shell, selector);
}
