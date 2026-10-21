import type { IpcChannel } from '@aio/schema';

/** Main-process exclusion covering asynchronous starts as well as live runtimes. */
export function createUpdateWorkGate(live: () => boolean = () => false) {
  let pending = 0;
  let restarting = false;
  let workRefusal: string | null = null;
  return {
    blockWork(reason: string | null) {
      workRefusal = reason;
    },
    enter() {
      if (workRefusal) throw new Error(workRefusal);
      if (restarting) throw new Error('An update restart is in progress.');
      pending++;
      let released = false;
      return () => {
        if (!released) {
          released = true;
          pending--;
        }
      };
    },
    busy() {
      return pending > 0 || live();
    },
    acquire() {
      if (restarting || pending > 0 || live()) return null;
      restarting = true;
      return () => {
        restarting = false;
      };
    },
  };
}
export type UpdateWorkGate = ReturnType<typeof createUpdateWorkGate>;

/** Reserve an IPC operation before its asynchronous body can race an update restart. */
export async function runWithUpdateWork<T>(
  channel: IpcChannel,
  gate: UpdateWorkGate,
  run: () => Promise<T>,
): Promise<T> {
  const work =
    channel === 'settings:set' ||
    (!/^(websiteUpdate|update):/.test(channel) &&
      /:(?:start|resume|run|import|importModel|importCatalogue|install|remove|download|export|extract|compute|create|save|convert|process|stitch|build|apply|commit|setGpu)/i.test(
        channel,
      ));
  const release = work ? gate.enter() : null;
  try {
    return await run();
  } finally {
    release?.();
  }
}

/** A keep-running action such as opening a DMG must release even when it succeeds. */
export async function runUpdateHandover(
  acquire: (() => (() => void) | null) | undefined,
  quitsOnSuccess: boolean,
  run: () => Promise<{ ok: boolean; error?: string }>,
): Promise<{ ok: boolean; error?: string }> {
  const release = acquire?.();
  if (acquire && !release)
    return {
      ok: false,
      error: 'Finish processing, imports and tool installation before restarting.',
    };
  let quitting = false;
  try {
    const result = await run();
    quitting = result.ok && quitsOnSuccess;
    return result;
  } finally {
    if (!quitting) release?.();
  }
}
