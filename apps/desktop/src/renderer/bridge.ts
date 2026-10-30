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

/**
 * Something that has to be on disk before a pipeline reads the project: null once it is, or the
 * sentence that says why the job was not started.
 */
export type JobStartCheck = () => Promise<string | null>;

const jobStartChecks = new Set<JobStartCheck>();

/**
 * Run `check` before every `jobs:start` of this window. A pipeline reads the project's files, and
 * some are written late (the issue saver and the detections store wait for a pause in the edits),
 * so each saver registers a check that writes its pending change first. Every job start goes
 * through `createBridge`, so this is the one place; a check that answers a sentence stops the
 * start. Answers the function that takes the check away again.
 */
export function beforeJobStart(check: JobStartCheck): () => void {
  jobStartChecks.add(check);
  return () => {
    jobStartChecks.delete(check);
  };
}

/** The first refusal of the checks, one after the other in the order they were registered. */
async function jobStartRefusal(): Promise<string | null> {
  for (const check of [...jobStartChecks]) {
    try {
      const refusal = await check();
      if (refusal !== null) return refusal;
    } catch (e) {
      return readableError(e);
    }
  }
  return null;
}

const afterCalls = new Map<IpcChannel, Set<() => void>>();

/**
 * Run `done` after every call on `channel` that main answered, whoever made it: what follows a
 * change made in one place (a key saved in Settings has the agent check its route again) without
 * that place knowing. Every call goes through `createBridge`, so this is the one place. Answers
 * the function that takes it away again.
 */
export function afterCall(channel: IpcChannel, done: () => void): () => void {
  const set = afterCalls.get(channel) ?? new Set();
  set.add(done);
  afterCalls.set(channel, set);
  return () => {
    set.delete(done);
  };
}

/** Wrap window.aio so every call resolves to a result instead of throwing. */
export function createBridge(aio: AioBridge | undefined): Bridge {
  return {
    async call(channel, request) {
      if (!aio) return { ok: false, error: 'The app bridge is not available.' };
      if (channel === 'jobs:start') {
        const refusal = await jobStartRefusal();
        if (refusal !== null) return { ok: false, error: refusal };
      }
      try {
        const value = await aio.invoke(channel, request);
        for (const done of [...(afterCalls.get(channel) ?? [])]) done();
        return { ok: true, value };
      } catch (e) {
        return { ok: false, error: readableError(e) };
      }
    },
  };
}
