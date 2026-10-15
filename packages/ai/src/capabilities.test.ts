import { describe, expect, it } from 'vitest';
import { capsFor, engineerReady } from './capabilities';
import type { ModelRoute } from './routes';

const engineer = (
  provider: ModelRoute['provider'],
  model: string,
  treatAsVision?: boolean,
): ModelRoute => ({
  task: 'engineer',
  provider,
  model,
  ...(treatAsVision === undefined ? {} : { treatAsVision }),
});

describe('capsFor', () => {
  it.each(['claude-opus-5-5', 'claude-sonnet-4-5', 'claude-haiku-4-5', 'claude-opus-9-1'])(
    'knows Anthropic %s by pattern',
    (model) => {
      expect(capsFor('anthropic', model)).toEqual({
        vision: true,
        structured: true,
        maxImages: 20,
        maxImagePx: 1568,
      });
    },
  );

  it.each(['gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'gpt-5', 'gpt-5-mini', 'gpt-6-luna'])(
    'knows OpenAI %s by pattern',
    (model) => {
      expect(capsFor('openai', model)).toEqual({
        vision: true,
        structured: true,
        maxImages: 20,
        maxImagePx: 2048,
      });
    },
  );

  it('does not guess at a model it does not know', () => {
    expect(capsFor('anthropic', 'claude-2')).toBeNull();
    expect(capsFor('openai', 'gpt-3.5-turbo')).toBeNull();
    expect(capsFor('openai', 'acme-vlm-2')).toBeNull();
    expect(capsFor('google', 'gemini-3.5-flash')).toBeNull();
    // a pattern belongs to its provider only
    expect(capsFor('openai', 'claude-opus-5-5')).toBeNull();
  });

  it('gives conservative caps to an unknown model the person treats as a vision model', () => {
    expect(capsFor('openai', 'acme-vlm-2', { treatAsVision: true })).toEqual({
      vision: true,
      structured: true,
      maxImages: 8,
      maxImagePx: 1024,
    });
  });

  it('keeps the table entry for a known model even with the setting on', () => {
    expect(capsFor('anthropic', 'claude-opus-5-5', { treatAsVision: true })?.maxImages).toBe(20);
  });

  it('reads a local model from the capability probe', () => {
    expect(capsFor('local', 'llava', { local: { tools: true, vision: true } })).toEqual({
      vision: true,
      structured: true,
      maxImages: 8,
      maxImagePx: 1024,
    });
    expect(capsFor('local', 'llama3.2', { local: { tools: true, vision: false } })).toEqual({
      vision: false,
      structured: true,
      maxImages: 0,
      maxImagePx: 0,
    });
    expect(capsFor('local', 'llava')).toBeNull();
  });
});

describe('engineerReady', () => {
  it('accepts a known vision model with structured output', () => {
    expect(engineerReady(engineer('anthropic', 'claude-opus-5-5'))).toEqual({
      ok: true,
      caps: { vision: true, structured: true, maxImages: 20, maxImagePx: 1568 },
    });
    expect(engineerReady(engineer('openai', 'gpt-6-luna')).ok).toBe(true);
  });

  it('refuses an unknown cloud model and names the setting that unlocks it', () => {
    const r = engineerReady(engineer('openai', 'acme-vlm-2'));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain('acme-vlm-2');
    expect(r.reason).toContain('"Treat as vision model"');
    expect(r.reason).toContain('Settings, AI providers');
    expect(r.reason).not.toMatch(/[–—]/);
  });

  it('accepts an unknown cloud model with "Treat as vision model" on, with conservative caps', () => {
    expect(engineerReady(engineer('openai', 'acme-vlm-2', true))).toEqual({
      ok: true,
      caps: { vision: true, structured: true, maxImages: 8, maxImagePx: 1024 },
    });
  });

  it('refuses a text-only local model with a clear reason', () => {
    const r = engineerReady(engineer('local', 'llama3.2'), { tools: true, vision: false });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain('cannot read images');
    expect(r.reason).toContain('Settings, AI providers');
  });

  it('keeps a text-only local model refused even with "Treat as vision model" on', () => {
    const r = engineerReady(engineer('local', 'llama3.2', true), { tools: true, vision: false });
    expect(r.ok).toBe(false);
  });

  it('accepts a local model the probe found with vision', () => {
    expect(engineerReady(engineer('local', 'llava'), { tools: false, vision: true }).ok).toBe(true);
  });

  it('refuses a local model that was never checked unless the person treats it as vision', () => {
    const r = engineerReady(engineer('local', 'llava'));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('"Treat as vision model"');
    expect(engineerReady(engineer('local', 'llava', true)).ok).toBe(true);
  });
});
