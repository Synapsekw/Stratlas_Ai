/**
 * The Analytics pack's own model as the offline agent (A3, decisions 2 and 3). The agent takes
 * the model through the local ask's `acquire`: the same one request at a time, the same refusal
 * while a detector run or a GPU photo job holds the card, the same free graphics memory check and
 * server lease, and the same keep-warm after it (so the detector queue waits for an agent run
 * through `localAsk.active()`, with no second lock). The model may run the agent only while the
 * stored tool-calling check passed for the model file installed now (its SHA-256).
 */
import type { BundledAgentCheck, BundledAgentStatus } from '@aio/schema';
import { en } from '@aio/ui/i18n/en';
import type { LocalAsk } from './ask';
import type { AnalyticsPack } from './pack';
import { VLM_CONTEXT_TOKENS } from './server';

export interface BundledAgentDeps {
  localAsk: Pick<LocalAsk, 'acquire' | 'active'>;
  /** The installed Analytics pack, null when none is usable. */
  findPack(): Promise<AnalyticsPack | null>;
  /** `Settings.bundledAgentCheck` now. */
  check(): BundledAgentCheck | undefined;
}

export type BundledAcquire =
  | { ok: true; baseUrl: string; apiKey: string; modelId: string; release: () => void }
  | { ok: false; message: string };

export interface BundledAgent {
  /** The model for one agent run (or the check): release it in a `finally`. */
  acquire(signal?: AbortSignal): Promise<BundledAcquire>;
  /** An agent run or the check holds the model (the detector queue waits). */
  active(): boolean;
  status(): Promise<BundledAgentStatus>;
  /** Null when the bundled model may run the agent, else why not (`status().blocked`). */
  ready(): Promise<string | null>;
}

const fill = (text: string, vars: Record<string, string | number>) =>
  text.replace(/\{(\w+)\}/g, (whole, n: string) => (n in vars ? String(vars[n]) : whole));

/** Why the bundled model may not run the agent, for the person; null when it may. */
export function blockedBy(
  pack: BundledAgentStatus['pack'],
  check: BundledAgentCheck | null,
): string | null {
  if (!pack) return en['localAi.bundled.noPack'];
  if (check?.modelSha256.toLowerCase() !== pack.modelSha256.toLowerCase())
    return en['localAi.bundled.checkFirst'];
  if (!check.passed) {
    return fill(en['localAi.bundled.failed'], {
      correct: check.correct,
      total: check.total,
      needed: check.needed,
    });
  }
  return null;
}

let runs = 0;

export function createBundledAgent(d: BundledAgentDeps): BundledAgent {
  async function status(): Promise<BundledAgentStatus> {
    const found = await d.findPack();
    const pack = found
      ? {
          version: found.version,
          modelId: found.manifest.model.id,
          modelSha256: found.manifest.model.sha256.toLowerCase(),
          contextTokens: VLM_CONTEXT_TOKENS,
        }
      : null;
    const check = d.check() ?? null;
    return { pack, check, blocked: blockedBy(pack, check) };
  }

  return {
    async acquire(signal) {
      runs += 1;
      const got = await d.localAsk.acquire(`agent-${String(runs)}`, signal);
      if (got.ok) {
        return {
          ok: true,
          baseUrl: got.url,
          apiKey: got.key,
          modelId: got.model,
          release: got.release,
        };
      }
      if (got.code === 'gpu') return { ok: false, message: en['localAi.bundled.gpuBusy'] };
      if (got.code === 'busy') return { ok: false, message: en['localAi.bundled.busy'] };
      return { ok: false, message: got.error };
    },
    active: () => d.localAsk.active(),
    status,
    ready: async () => (await status()).blocked,
  };
}
