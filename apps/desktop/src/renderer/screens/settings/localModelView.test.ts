import type { BundledAgentCheck, BundledAgentStatus, LocalModelSettings } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import {
  bundledPassed,
  candidates,
  checkLine,
  contextLabel,
  localRoutesTo,
  sizeLabel,
  toBundled,
  toOwnServer,
  withModel,
  withProbe,
} from './localModelView';

const SHA = 'b'.repeat(64);
const PACK = {
  version: '0.2.0',
  modelId: 'qwen3.5-9b-q4_k_m',
  modelSha256: SHA,
  runtimeRelease: 'b0000',
  contextTokens: 16_384,
};
const CHECK: BundledAgentCheck = {
  modelSha256: SHA,
  runtimeRelease: 'b0000',
  modelId: 'qwen3.5-9b-q4_k_m',
  packVersion: '0.2.0',
  passed: true,
  correct: 12,
  total: 12,
  needed: 10,
  invalidCalls: 0,
  meanLatencyMs: 412,
  checkedAt: '2026-11-12T00:00:00.000Z',
  cases: [],
};
const OWN: LocalModelSettings = {
  enabled: true,
  baseUrl: 'http://localhost:11434/v1',
  model: 'my-model',
  kind: 'ollama',
  contextTokens: 8192,
  capabilities: { tools: true, vision: false },
};

describe('the bundled model in Settings (A3)', () => {
  const passed: BundledAgentStatus = { pack: PACK, check: CHECK, blocked: null };
  it('choosing it: compact, the 16k context, vision, tools only after a pass; the address kept', () => {
    expect(toBundled(OWN, PACK, passed)).toEqual({
      ...OWN,
      enabled: true,
      source: 'bundled',
      model: 'qwen3.5-9b-q4_k_m',
      toolProfile: 'compact',
      contextTokens: 16_384,
      capabilities: { tools: true, vision: true },
    });
    const unchecked = { pack: PACK, check: null, blocked: 'Check first.' };
    expect(toBundled(OWN, PACK, unchecked).capabilities).toEqual({ tools: false, vision: true });
    expect(bundledPassed(unchecked)).toBe(false);
  });

  it('switching back restores the own server saved before, else drops the bundled values', () => {
    const bundled = toBundled(OWN, PACK, passed);
    expect(toOwnServer(JSON.stringify(OWN), bundled)).toEqual({ ...OWN, source: 'server' });
    expect(toOwnServer('not json', bundled)).toEqual({
      enabled: true,
      baseUrl: OWN.baseUrl,
      model: 'qwen3.5-9b-q4_k_m',
      kind: 'ollama',
      toolProfile: 'compact',
      source: 'server',
    });
  });

  it('the check line: a pass, a failure, or why not yet', () => {
    expect(checkLine(passed)).toEqual({
      tone: 'ok',
      text: 'Passed: 12 of 12 right, 0.4 s per request. Offline AI can run on this model.',
    });
    expect(
      checkLine({ pack: PACK, check: { ...CHECK, passed: false }, blocked: 'Failed text.' }),
    ).toEqual({ tone: 'err', text: 'Failed text.' });
    expect(checkLine({ pack: PACK, check: null, blocked: 'Check first.' })).toEqual({
      tone: 'faint',
      text: 'Check first.',
    });
    expect(checkLine(null)).toBeNull();
  });
});

describe('Find models candidates', () => {
  it('tries the typed address, then the default ports on this machine', () => {
    expect(candidates('http://127.0.0.1:5555/v1')).toEqual([
      'http://127.0.0.1:5555/v1',
      'http://localhost:11434/v1',
      'http://localhost:1234/v1',
      'http://localhost:8080/v1',
    ]);
  });

  it('does not repeat the typed default', () => {
    expect(candidates('http://localhost:1234/v1/')).toEqual([
      'http://localhost:1234/v1/',
      'http://localhost:11434/v1',
      'http://localhost:8080/v1',
    ]);
  });

  it('tries only the typed address when it is on another machine', () => {
    expect(candidates('http://192.168.1.20:11434/v1')).toEqual(['http://192.168.1.20:11434/v1']);
  });
});

describe('badges', () => {
  it('shows context and size briefly', () => {
    expect(contextLabel(8192)).toBe('8k');
    expect(contextLabel(131072)).toBe('128k');
    expect(contextLabel(512)).toBe('512');
    expect(sizeLabel(4_683_087_332)).toBe('4.7 GB');
    expect(sizeLabel(274_302_450)).toBe('274 MB');
  });
});

describe('settings changes', () => {
  const cfg = {
    enabled: true,
    baseUrl: 'http://localhost:11434/v1',
    model: 'old',
    capabilities: { tools: true, vision: false },
    contextTokens: 4096,
    toolProfile: 'compact' as const,
  };

  it('choosing a model forgets the old test result and takes the listed context', () => {
    expect(withModel(cfg, { id: 'new', contextTokens: 32768 })).toEqual({
      enabled: true,
      baseUrl: 'http://localhost:11434/v1',
      model: 'new',
      contextTokens: 32768,
      toolProfile: 'compact',
    });
    expect(withModel(cfg, { id: 'other' })).not.toHaveProperty('contextTokens');
  });

  it('a test stores what it measured', () => {
    expect(withProbe(cfg, { tools: false, vision: true, contextTokens: 8192 })).toMatchObject({
      capabilities: { tools: false, vision: true },
      contextTokens: 8192,
    });
    expect(withProbe(cfg, { tools: true, vision: true }).contextTokens).toBe(4096);
  });

  it('routes on the local model follow the chosen model', () => {
    expect(
      localRoutesTo(
        [
          { task: 'chat', provider: 'local', model: 'old' },
          { task: 'vision', provider: 'anthropic', model: 'claude-opus-5-5' },
        ],
        'new',
      ),
    ).toEqual([
      { task: 'chat', provider: 'local', model: 'new' },
      { task: 'vision', provider: 'anthropic', model: 'claude-opus-5-5' },
    ]);
  });
});
