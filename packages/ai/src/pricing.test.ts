import { describe, expect, it } from 'vitest';
import { estimateCostUsd, formatMeter } from './pricing';
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
