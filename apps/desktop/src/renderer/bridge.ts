import type { AioBridge, IpcChannel, IpcRequest, IpcResponse } from '@aio/schema';

export type Res<T> = { ok: true; value: T } | { ok: false; error: string };

/** Turn an Electron invoke rejection into a sentence a person can read. */
export function readableError(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  const noHandler = /No handler registered for '([^']+)'/.exec(raw);
  if (noHandler) return `The ${noHandler[1] ?? ''} service is not available in this build.`;
  return raw.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}

export interface Bridge {
  call<C extends IpcChannel>(channel: C, request: IpcRequest<C>): Promise<Res<IpcResponse<C>>>;
}

/** Wrap window.aio so every call resolves to a result instead of throwing. */
export function createBridge(aio: AioBridge | undefined): Bridge {
  return {
    async call(channel, request) {
      if (!aio) return { ok: false, error: 'The app bridge is not available.' };
      try {
        return { ok: true, value: await aio.invoke(channel, request) };
      } catch (e) {
        return { ok: false, error: readableError(e) };
      }
    },
  };
}
