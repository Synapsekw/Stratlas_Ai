/**
 * Local price table for the cost meter (AI-7). USD per million tokens, list prices, standard tier,
 * prompts in the base context tier. Estimates only: the provider's invoice is authoritative.
 * Sources and the date they were checked are in packages/ai/README.md. Bump PRICES_AS_OF when a
 * row changes.
 */
export const PRICES_AS_OF = '2026-10-04';

export interface ModelPrice {
  input: number;
  output: number;
  /** Cache read price; defaults to a tenth of input. */
  cacheRead?: number;
  /** Cache write price (5 minute writes); defaults to 1.25 times input. */
  cacheWrite?: number;
}

const PRICES: Record<string, ModelPrice> = {
  // Anthropic, platform.claude.com/docs/en/about-claude/pricing.
  'claude-fable-5-1': { input: 10, output: 50, cacheRead: 0.25 },
  'claude-fable-5': { input: 10, output: 50, cacheRead: 1 },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2 },
  'claude-opus-5': { input: 5, output: 25 },
  'claude-opus-4-8': { input: 5, output: 25 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2 },
  'claude-sonnet-5': { input: 2, output: 10, cacheRead: 0.2 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-haiku-4-5': { input: 1, output: 5 },
  // OpenAI, developers.openai.com/api/docs/pricing (short context, up to 272K input).
  'gpt-6-astra': { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
  'gpt-6.1-sol': { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
  'gpt-6-sol': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  'gpt-6-luna': { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
  'gpt-5.6-sol': { input: 4, output: 20, cacheRead: 0.4, cacheWrite: 5 },
  'gpt-5.6-luna': { input: 0.2, output: 1.2, cacheRead: 0.02, cacheWrite: 0.25 },
  'gpt-5.5': { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 5 },
  'gpt-5.4-mini': { input: 0.75, output: 4.5, cacheRead: 0.075, cacheWrite: 0.75 },
  'gpt-5-nano': { input: 0.05, output: 0.4, cacheRead: 0.005, cacheWrite: 0.05 },
  // Google Gemini, ai.google.dev/gemini-api/docs/pricing (paid tier, prompts up to 200k).
  // Gemini bills cache storage per hour instead of cache writes; writes are priced as input.
  'gemini-3.1-pro-preview': { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 2 },
  'gemini-2.5-pro': { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 1.25 },
  // Introductory price until 2026-12-31; doubles from 2027-01-01.
  'gemini-3.8-flash': { input: 0.75, output: 3.75, cacheRead: 0.075, cacheWrite: 0.75 },
  'gemini-3.5-flash': { input: 1.5, output: 9, cacheRead: 0.15, cacheWrite: 1.5 },
  'gemini-3.5-flash-lite': { input: 0.3, output: 2.5, cacheRead: 0.3, cacheWrite: 0.3 },
  'gemini-3.1-flash-lite': { input: 0.25, output: 1.5, cacheRead: 0.025, cacheWrite: 0.25 },
};

/** Providers that run on this machine and cost nothing per token. */
const FREE_PROVIDERS = new Set(['local']);

export function priceFor(model: string): ModelPrice | undefined {
  return PRICES[model];
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

/** Estimated cost in USD, or undefined when the model is not in the table. */
export function estimateCostUsd(model: string, u: TokenUsage): number | undefined {
  const p = priceFor(model);
  if (!p) return undefined;
  const cacheRead = u.cacheReadTokens ?? 0;
  const cacheWrite = u.cacheWriteTokens ?? 0;
  const plainInput = Math.max(0, u.inputTokens - cacheRead - cacheWrite);
  const usd =
    plainInput * p.input +
    cacheRead * (p.cacheRead ?? p.input / 10) +
    cacheWrite * (p.cacheWrite ?? p.input * 1.25) +
    u.outputTokens * p.output;
  return usd / 1_000_000;
}

/** "12.4k tok · $0.04" style meter text. */
export function formatMeter(tokens: number, costUsd: number | undefined): string {
  const tok = tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k tok` : `${tokens} tok`;
  if (costUsd === undefined) return tok;
  const cost = costUsd < 0.01 && costUsd > 0 ? '<$0.01' : `$${costUsd.toFixed(2)}`;
  return `${tok} · ${cost}`;
}

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  /** False when some usage had no price: the cost is then a lower bound. */
  costKnown: boolean;
}

export interface ProviderUsageRow extends UsageTotals {
  provider: string;
}

/** Add one usage report to a per-provider list (a new list; the input is not changed). */
export function addProviderUsage(
  list: readonly ProviderUsageRow[],
  u: { provider: string; inputTokens: number; outputTokens: number; costUsd?: number },
): ProviderUsageRow[] {
  const cost = FREE_PROVIDERS.has(u.provider) ? 0 : u.costUsd;
  const prev = list.find((r) => r.provider === u.provider);
  const next: ProviderUsageRow = {
    provider: u.provider,
    inputTokens: (prev?.inputTokens ?? 0) + u.inputTokens,
    outputTokens: (prev?.outputTokens ?? 0) + u.outputTokens,
    costUsd: (prev?.costUsd ?? 0) + (cost ?? 0),
    costKnown: (prev?.costKnown ?? true) && cost !== undefined,
  };
  return prev ? list.map((r) => (r === prev ? next : r)) : [...list, next];
}

export function totalUsage(list: readonly UsageTotals[]): UsageTotals {
  return list.reduce<UsageTotals>(
    (a, r) => ({
      inputTokens: a.inputTokens + r.inputTokens,
      outputTokens: a.outputTokens + r.outputTokens,
      costUsd: a.costUsd + r.costUsd,
      costKnown: a.costKnown && r.costKnown,
    }),
    { inputTokens: 0, outputTokens: 0, costUsd: 0, costKnown: true },
  );
}
