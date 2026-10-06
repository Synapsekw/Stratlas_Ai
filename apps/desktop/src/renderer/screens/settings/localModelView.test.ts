import { describe, expect, it } from 'vitest';
import {
  candidates,
  contextLabel,
  localRoutesTo,
  sizeLabel,
  withModel,
  withProbe,
} from './localModelView';

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
