import { correctionPrompt } from '@aio/ai';
import type { ProjectManifest } from '@aio/schema';
import type { Bridge, Res } from '../bridge';
import type { SendFailure, SendPreview } from './CorrectionPanel.types';

/** How a send ended: a run started, or it stopped at the AI pane's send preview. */
export type SendOutcome = 'sent' | 'preview';

/** The part of the agent session a correction send needs. */
export interface CorrectionAgent {
  getState(): { busy: boolean; preview: unknown; turns: readonly unknown[] };
  send(text: string): Promise<void>;
}

/**
 * Sends through the agent and says what happened. `agent.send` returns quietly without sending
 * when the agent is busy, a preview is already open or the route is not ready, so the state is
 * read afterwards: a new preview or a started run counts, anything else throws `notSent`.
 */
export async function sendToAgent(
  agent: CorrectionAgent,
  text: string,
  notSent: string,
): Promise<SendOutcome> {
  const before = agent.getState();
  await agent.send(text);
  const after = agent.getState();
  if (after.preview && after.preview !== before.preview) return 'preview';
  if (after.busy || after.turns.length > before.turns.length) return 'sent';
  throw new Error(notSent);
}

export const SEND_TIMEOUT_MESSAGE =
  'The AI did not answer in time. Your request is saved; press Send to try again.';

/**
 * The promise, or the timeout message once `ms` have passed without it settling. A timed-out step
 * is not cancelled: a send may still start later. The agentBusy blocker keeps a second press from
 * sending the same requests twice while that reply runs.
 */
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
  /** Resolves with the outcome; anything other than 'preview' counts as sent. */
  send: (text: string) => Promise<unknown>;
  timeoutMs?: number;
}): Promise<SendOutcome> {
  const ms = deps.timeoutMs ?? 30_000;
  const submitted = await bounded(deps.prepare(deps.ids), ms);
  const outcome = await bounded(deps.send(correctionPrompt(submitted)), ms);
  return outcome === 'preview' ? 'preview' : 'sent';
}

/**
 * Saves, then optionally sends. A failed save rejects (nothing was saved, the text stays); a
 * failed send resolves with `sendError`, because the request is saved and still open, so a
 * second press sends it instead of saving a duplicate. `select` picks the saved request only
 * once it is sent (or when only saving): after a failed send the composer stays open, with Send
 * counting the open request.
 */
export async function saveThenSend(o: {
  save: () => Promise<string>;
  /** Resolves with the outcome; anything other than 'preview' counts as sent. */
  send?: (id: string) => Promise<unknown>;
  select?: (id: string) => void;
}): Promise<SendFailure | SendPreview | undefined> {
  const id = await o.save();
  if (!o.send) {
    o.select?.(id);
    return undefined;
  }
  let outcome: unknown;
  try {
    outcome = await o.send(id);
  } catch (e) {
    return { sendError: e instanceof Error ? e.message : String(e) };
  }
  o.select?.(id);
  return outcome === 'preview' ? { preview: true } : undefined;
}

/** After Accept the box is free for the next correction; after Reject the request stays open to reply. */
export function afterDecision(
  decision: 'accept' | 'reject',
  ui: { setRequestId: (id: string | undefined) => void; setView: (v: 'before' | 'after') => void },
): void {
  if (decision === 'accept') ui.setRequestId(undefined);
  ui.setView('before');
}

/** A bridge answer that is itself ok-or-failure: its value, or its error thrown. */
function must<T extends { ok: boolean }>(r: Res<T>): Extract<T, { ok: true }> {
  if (!r.ok) throw new Error(r.error);
  if (!r.value.ok)
    throw new Error((r.value as { error?: string }).error ?? 'The request was refused.');
  return r.value as Extract<T, { ok: true }>;
}

/**
 * The project's own consent for the missing kinds ("Allow for this project", as in the evidence
 * preview), then the manifest again so the blocker sees it. A refusal is thrown, for the panel.
 */
export async function allowCloudKinds(
  missing: readonly ('photos' | 'scans' | 'drawings')[],
  deps: {
    call: Bridge['call'];
    project: () => { id: string; root: string } | null | undefined;
    replaceManifest: (projectId: string, manifest: ProjectManifest) => void;
  },
): Promise<void> {
  const project = deps.project();
  if (!project) return;
  const photos = missing.includes('photos');
  const scans = missing.includes('scans');
  if (photos || scans)
    must(
      await deps.call('ai:setCloudEvidence', {
        projectId: project.id,
        ...(photos ? { photos: true } : {}),
        ...(scans ? { scans: true } : {}),
      }),
    );
  if (missing.includes('drawings'))
    must(await deps.call('ai:setCloudDrawings', { projectId: project.id, allow: true }));
  const opened = must(await deps.call('project:open', { path: project.root }));
  deps.replaceManifest(project.id, opened.manifest);
}
