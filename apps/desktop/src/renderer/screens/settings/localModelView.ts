/**
 * Pure helpers of Settings, AI providers, Local model (M8 C7): where Find models looks, the badge
 * texts, and how a chosen model or a test result changes the settings.
 */
import { isLoopbackUrl, LOCAL_SERVERS, serverRoot, type ModelRoute } from '@aio/ai/routes';
import {
  LocalModelSettings as LocalModelSettingsSchema,
  type BundledAgentStatus,
  type LocalModelInfo,
  type LocalModelSettings,
} from '@aio/schema';
import { t } from '@aio/ui';

type BundledPack = NonNullable<BundledAgentStatus['pack']>;

/** The stored check passed for the model installed now. */
export function bundledPassed(status: BundledAgentStatus | null): boolean {
  return status?.pack != null && status.check != null && status.blocked === null;
}

/**
 * The bundled Analytics model chosen (A3): compact, the server's context, vision, tools once its
 * check passed. The address stays the person's own server, so switching back finds it again; the
 * model name is the pack's (the settings hold one model name).
 */
export function toBundled(
  cfg: LocalModelSettings,
  pack: BundledPack,
  status: BundledAgentStatus | null,
): LocalModelSettings {
  return {
    ...cfg,
    enabled: true,
    source: 'bundled',
    model: pack.modelId,
    toolProfile: 'compact',
    contextTokens: pack.contextTokens,
    capabilities: { tools: bundledPassed(status), vision: true },
  };
}

/**
 * Back to the person's own server: the settings saved before the bundled model was chosen (this
 * workstation), else the current ones without what belonged to the bundled model.
 */
export function toOwnServer(saved: string | null, cfg: LocalModelSettings): LocalModelSettings {
  let parsed: unknown;
  try {
    parsed = saved ? JSON.parse(saved) : null;
  } catch {
    parsed = null;
  }
  const before = LocalModelSettingsSchema.safeParse(parsed);
  if (before.success && before.data.source !== 'bundled')
    return { ...before.data, enabled: cfg.enabled, source: 'server' };
  const rest: LocalModelSettings = { ...cfg, source: 'server' };
  delete rest.capabilities;
  delete rest.contextTokens;
  return rest;
}

/** The line under Check tool calling: the pass, why the model may not run the agent, or nothing. */
export function checkLine(
  status: BundledAgentStatus | null,
): { tone: 'ok' | 'err' | 'faint'; text: string } | null {
  if (!status) return null;
  if (bundledPassed(status) && status.check) {
    return {
      tone: 'ok',
      text: t('localAi.bundled.passed', {
        correct: status.check.correct,
        total: status.check.total,
        seconds: (status.check.meanLatencyMs / 1000).toFixed(1),
      }),
    };
  }
  if (status.blocked === null) return null;
  const failed =
    status.pack !== null &&
    status.check !== null &&
    !status.check.passed &&
    status.check.modelSha256 === status.pack.modelSha256;
  return { tone: failed ? 'err' : 'faint', text: status.blocked };
}

/**
 * The addresses Find models tries, in order: the typed one, then (when it is on this machine) the
 * default ports of Ollama, LM Studio and the llama.cpp server. An address on another machine is
 * tried alone, after the person accepted the warning.
 */
export function candidates(typed: string): string[] {
  if (!isLoopbackUrl(typed)) return [typed];
  const seen = serverRoot(typed);
  return [typed, ...LOCAL_SERVERS.map((s) => s.baseUrl).filter((u) => serverRoot(u) !== seen)];
}

/** 8192 to "8k". */
export function contextLabel(tokens: number): string {
  return tokens >= 1024 ? `${String(Math.round(tokens / 1024))}k` : String(tokens);
}

/** 4 683 087 332 to "4.7 GB". */
export function sizeLabel(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  return `${String(Math.round(bytes / 1e6))} MB`;
}

/** A newly chosen model: the old test result no longer applies; the listed context does. */
export function withModel(
  cfg: LocalModelSettings,
  info: Pick<LocalModelInfo, 'id' | 'contextTokens'>,
): LocalModelSettings {
  const rest: LocalModelSettings = { ...cfg };
  delete rest.capabilities;
  delete rest.contextTokens;
  return {
    ...rest,
    model: info.id,
    ...(info.contextTokens ? { contextTokens: info.contextTokens } : {}),
  };
}

/** What Test measured, kept with the model (the agent checks its routes against it). */
export function withProbe(
  cfg: LocalModelSettings,
  probe: { tools: boolean; vision: boolean; contextTokens?: number | undefined },
): LocalModelSettings {
  return {
    ...cfg,
    capabilities: { tools: probe.tools, vision: probe.vision },
    ...(probe.contextTokens ? { contextTokens: probe.contextTokens } : {}),
  };
}

/** Routes on the local model use the model now chosen. */
export function localRoutesTo(routes: readonly ModelRoute[], model: string): ModelRoute[] {
  return routes.map((r) => (r.provider === 'local' ? { ...r, model } : r));
}
