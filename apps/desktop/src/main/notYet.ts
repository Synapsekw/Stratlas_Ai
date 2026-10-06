import type { IpcChannel, IpcRequest, IpcResponse } from '@aio/schema';
import { validated, type Handler } from './ipc';

/** Registers a validated IPC handler (main's `handle`). */
export type Handle = <C extends IpcChannel>(channel: C, handler: Handler<C>) => void;

/**
 * The answer of a channel this build does not do yet (M8 C0 and M9 T0 stubs). Each stream replaces the
 * stubs of its own module; the renderer can tell the case apart by `code`.
 */
export function notYet(what: string): { ok: false; error: string; code: 'not-implemented' } {
  return {
    ok: false,
    error: `${what} is not available yet in this build.`,
    code: 'not-implemented',
  };
}

/**
 * Test helper: register a module's handlers into a table, each wrapped like main does (request and
 * response validated against the contract), so a test calls them as the renderer would.
 */
export function collectHandlers(register: (handle: Handle) => void) {
  const table = new Map<IpcChannel, (raw: unknown) => Promise<unknown>>();
  register((channel, handler) => {
    table.set(channel, validated(channel, handler));
  });
  return {
    channels: () => [...table.keys()].sort(),
    call: async <C extends IpcChannel>(channel: C, req: IpcRequest<C>): Promise<IpcResponse<C>> => {
      const run = table.get(channel);
      if (!run) throw new Error(`No handler for ${channel}`);
      return (await run(req)) as IpcResponse<C>;
    },
  };
}
