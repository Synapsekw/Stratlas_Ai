/**
 * `ai:bundledAgent` and `ai:bundledAgentCheck` (A3): what the Analytics pack's model is and
 * whether it may run the offline agent, and the tool-calling check that decides it. The check
 * takes the model through the bundled agent's `acquire` (so it waits for nothing and refuses
 * while a detector run holds the card), runs `runToolCheck` against the pack's server and keeps
 * the result in `Settings.bundledAgentCheck` with the model's SHA-256 and the pack version.
 */
import { localProvider, runToolCheck, toolCheckVersion, type ToolCheckResult } from '@aio/ai/main';
import type { BundledAgentCheck, IpcChannel } from '@aio/schema';
import { en } from '@aio/ui/i18n/en';
import { runtimeReleaseOf, type BundledAgent } from './analytics/agentModel';
import type { AnalyticsPack } from './analytics/pack';
import type { Handler } from './ipc';

export interface BundledAgentIpcDeps {
  handle: <C extends IpcChannel>(channel: C, handler: Handler<C>) => void;
  agent: Pick<BundledAgent, 'acquire' | 'status'>;
  findPack(): Promise<AnalyticsPack | null>;
  /** Keep the check in `Settings.bundledAgentCheck`. */
  saveCheck(check: BundledAgentCheck): Promise<void>;
  /** `runToolCheck` (tests give a fake). */
  runCheck?: (model: Parameters<typeof runToolCheck>[0]['model']) => Promise<ToolCheckResult>;
  now?: () => Date;
}

export const CHECK_RUNNING = 'The tool-calling check is already running.';

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** What the settings keep of one check. */
export function toStoredCheck(
  pack: AnalyticsPack,
  r: ToolCheckResult,
  checkedAt: Date,
): BundledAgentCheck {
  return {
    modelSha256: pack.manifest.model.sha256.toLowerCase(),
    runtimeRelease: runtimeReleaseOf(pack),
    checkVersion: toolCheckVersion(),
    modelId: pack.manifest.model.id,
    packVersion: pack.version,
    passed: r.passed,
    correct: r.correct,
    total: r.total,
    needed: r.needed,
    invalidCalls: r.invalidCalls,
    meanLatencyMs: Math.max(0, Math.round(r.meanLatencyMs)),
    ...(r.promptTokens !== undefined
      ? { promptTokens: Math.max(0, Math.round(r.promptTokens)) }
      : {}),
    checkedAt: checkedAt.toISOString(),
    cases: r.cases.slice(0, 50).map((c) => ({
      id: c.id.slice(0, 80),
      ok: c.ok,
      outcome: c.outcome,
      ...(c.tool ? { tool: c.tool.slice(0, 80) } : {}),
    })),
  };
}

export function registerBundledAgentIpc(d: BundledAgentIpcDeps): void {
  const runCheck = d.runCheck ?? ((model) => runToolCheck({ model }));
  const now = d.now ?? (() => new Date());
  let checking = false;

  d.handle('ai:bundledAgent', () => d.agent.status());

  d.handle('ai:bundledAgentCheck', async () => {
    if (checking) return { ok: false, error: CHECK_RUNNING };
    checking = true;
    try {
      const pack = await d.findPack();
      if (!pack) return { ok: false, error: en['localAi.bundled.noPack'] };
      const got = await d.agent.acquire();
      if (!got.ok) return { ok: false, error: got.message };
      let result: ToolCheckResult;
      try {
        const model = localProvider({ baseUrl: got.baseUrl }).languageModel(
          got.modelId,
          got.apiKey,
        );
        result = await runCheck(model);
      } catch (e) {
        return { ok: false, error: `The bundled model did not answer the check: ${message(e)}` };
      } finally {
        got.release();
      }
      const check = toStoredCheck(pack, result, now());
      await d.saveCheck(check);
      return { ok: true, check, status: await d.agent.status() };
    } finally {
      checking = false;
    }
  });
}
