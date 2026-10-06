/**
 * Pure helpers of Settings, AI providers, Local model (M8 C7): where Find models looks, the badge
 * texts, and how a chosen model or a test result changes the settings.
 */
import { isLoopbackUrl, LOCAL_SERVERS, serverRoot, type ModelRoute } from '@aio/ai/routes';
import type { LocalModelInfo, LocalModelSettings } from '@aio/schema';

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
