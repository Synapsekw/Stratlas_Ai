/**
 * Local price table for the cost meter (AI-7). USD per million tokens, list prices. Estimates only:
 * the provider's invoice is authoritative. Bump PRICES_AS_OF when a row changes.
 */
export const PRICES_AS_OF = '2026-09-25';

export interface ModelPrice {
  input: number;
  output: number;
  /** Cache read price; defaults to a tenth of input. */
  cacheRead?: number;
  /** Cache write price; defaults to 1.25 times input. */
  cacheWrite?: number;
}

const PRICES: Record<string, ModelPrice> = {
  // Anthropic first-party list prices.
  'claude-fable-5-1': { input: 10, output: 50 },
  'claude-fable-5': { input: 10, output: 50 },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2 },
  'claude-opus-5': { input: 5, output: 25 },
  'claude-opus-4-8': { input: 5, output: 25 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2 },
  'claude-sonnet-5': { input: 2, output: 10 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-haiku-4-5': { input: 1, output: 5 },
  // OpenAI and Google: last known list prices; check before relying on them.
  'gpt-5': { input: 1.25, output: 10, cacheRead: 0.125 },
  'gpt-5-mini': { input: 0.25, output: 2, cacheRead: 0.025 },
  'gemini-2.5-pro': { input: 1.25, output: 10 },
  'gemini-2.5-flash': { input: 0.3, output: 2.5 },
};

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
