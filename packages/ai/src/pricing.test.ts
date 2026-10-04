import { describe, expect, it } from 'vitest';
import { addProviderUsage, estimateCostUsd, formatMeter, totalUsage } from './pricing';
import { missingKeyMessage, modelLabel } from './routes';

describe('cost estimate', () => {
  it('prices input and output per million tokens', () => {
    expect(
      estimateCostUsd('claude-sonnet-5-5', { inputTokens: 1_000_000, outputTokens: 100_000 }),
    ).toBeCloseTo(3);
  });

  it('prices cache reads lower than plain input', () => {
    const plain = estimateCostUsd('claude-opus-5-5', { inputTokens: 10_000, outputTokens: 0 });
    const cached = estimateCostUsd('claude-opus-5-5', {
      inputTokens: 10_000,
      outputTokens: 0,
      cacheReadTokens: 9_000,
    });
    expect(cached).toBeLessThan(plain ?? 0);
  });

  it('returns undefined for unknown models', () => {
    expect(estimateCostUsd('some-local-model', { inputTokens: 1, outputTokens: 1 })).toBe(
      undefined,
    );
  });

  it('knows the current OpenAI and Gemini models verified on the pricing pages', () => {
    expect(
      estimateCostUsd('gpt-6.1-sol', { inputTokens: 1_000_000, outputTokens: 1_000_000 }),
    ).toBeCloseTo(12);
    expect(
      estimateCostUsd('gemini-3.1-pro-preview', { inputTokens: 1_000_000, outputTokens: 0 }),
    ).toBeCloseTo(2);
    expect(
      estimateCostUsd('claude-fable-5-1', {
        inputTokens: 1_000_000,
        outputTokens: 0,
        cacheReadTokens: 1_000_000,
      }),
    ).toBeCloseTo(0.25);
  });

  it('adds usage per provider and totals it', () => {
    let list = addProviderUsage([], {
      provider: 'anthropic',
      inputTokens: 10,
      outputTokens: 2,
      costUsd: 0.5,
    });
    list = addProviderUsage(list, {
      provider: 'anthropic',
      inputTokens: 5,
      outputTokens: 1,
      costUsd: 0.25,
    });
    list = addProviderUsage(list, { provider: 'local', inputTokens: 7, outputTokens: 3 });
    list = addProviderUsage(list, { provider: 'openai', inputTokens: 1, outputTokens: 1 });
    expect(list.find((u) => u.provider === 'anthropic')).toEqual({
      provider: 'anthropic',
      inputTokens: 15,
      outputTokens: 3,
      costUsd: 0.75,
      costKnown: true,
    });
    // A local model costs nothing; an unpriced cloud model makes the cost a lower bound.
    expect(list.find((u) => u.provider === 'local')?.costKnown).toBe(true);
    expect(list.find((u) => u.provider === 'openai')?.costKnown).toBe(false);
    expect(totalUsage(list)).toEqual({
      inputTokens: 23,
      outputTokens: 7,
      costUsd: 0.75,
      costKnown: false,
    });
  });

  it('formats the meter', () => {
    expect(formatMeter(12_400, 0.04)).toBe('12.4k tok · $0.04');
    expect(formatMeter(300, 0.0004)).toBe('300 tok · <$0.01');
    expect(formatMeter(300, undefined)).toBe('300 tok');
  });
});

describe('labels', () => {
  it('names providers in the missing key message', () => {
    expect(missingKeyMessage('Anthropic')).toBe('Add an Anthropic key in Settings, AI providers.');
    expect(missingKeyMessage('Google Gemini')).toBe(
      'Add a Google Gemini key in Settings, AI providers.',
    );
  });

  it('shortens model ids', () => {
    expect(modelLabel('claude-sonnet-5-5')).toBe('Claude Sonnet 5.5');
    expect(modelLabel('claude-opus-5')).toBe('Claude Opus 5');
    expect(modelLabel('gpt-5-mini')).toBe('GPT-5-mini');
  });
});
