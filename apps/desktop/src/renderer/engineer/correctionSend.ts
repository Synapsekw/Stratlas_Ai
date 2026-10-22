import { correctionPrompt } from '@aio/ai';
import type { SendFailure } from './CorrectionPanel.types';

export const SEND_TIMEOUT_MESSAGE =
  'The AI did not answer in time. Your request is saved; press Send to try again.';

/** The promise, or the timeout message once `ms` have passed without it settling. */
function bounded<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(SEND_TIMEOUT_MESSAGE));
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    clearTimeout(timer);
  });
}

/**
 * Hands saved, open requests to the AI: `prepare` checks and serialises them, `send` posts the
 * correction prompt. Each step is bounded, so a hung status check or send can never keep the
 * panel locked; the requests stay saved and open either way.
 */
export async function sendCorrections(deps: {
  ids: string[];
  prepare: (ids: string[]) => Promise<string>;
  send: (text: string) => Promise<void>;
  timeoutMs?: number;
}): Promise<void> {
  const ms = deps.timeoutMs ?? 30_000;
  const submitted = await bounded(deps.prepare(deps.ids), ms);
  await bounded(deps.send(correctionPrompt(submitted)), ms);
}

/**
 * Saves, then optionally sends. A failed save rejects (nothing was saved, the text stays); a
 * failed send resolves with `sendError`, because the request is saved and still open, so a
 * second press sends it instead of saving a duplicate.
 */
export async function saveThenSend(o: {
  save: () => Promise<string>;
  send?: (id: string) => Promise<void>;
}): Promise<SendFailure | undefined> {
  const id = await o.save();
  if (!o.send) return undefined;
  try {
    await o.send(id);
    return undefined;
  } catch (e) {
    return { sendError: e instanceof Error ? e.message : String(e) };
  }
}

/** After Accept the box is free for the next correction; after Reject the request stays open to reply. */
export function afterDecision(
  decision: 'accept' | 'reject',
  ui: { setRequestId: (id: string | undefined) => void; setView: (v: 'before' | 'after') => void },
): void {
  if (decision === 'accept') ui.setRequestId(undefined);
  ui.setView('before');
}
