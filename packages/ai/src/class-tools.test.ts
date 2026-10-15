import { describe, expect, it } from 'vitest';
import { runRendererTool, type RendererToolContext } from './renderer-tools';
import { fixtureWorkspace } from './test-fixtures';
import { approvalFor } from './tools';
import { registerAppHooks } from './tool-kit';

function ctx(ws = fixtureWorkspace()): RendererToolContext {
  return {
    workspace: ws,
    window: 'issues',
    scene: () => null,
    fetchJson: () => Promise.resolve(null),
    captureFrame: () => Promise.resolve(null),
    now: () => new Date('2026-10-15T12:00:00Z'),
  };
}

describe('propose_class', () => {
  it('asks a person before it runs', () => {
    expect(approvalFor('propose_class')).toBe(true);
  });

  it('answers with an existing class (any case) without creating one', async () => {
    const r = await runRendererTool('propose_class', { label: 'CORROSION' }, ctx());
    expect(r.result).toEqual({ classId: 'corrosion', label: 'Corrosion', created: false });
  });

  it('creates the class through the app once approved', async () => {
    const asked: string[] = [];
    const off = registerAppHooks({
      createClass: (label) => {
        asked.push(label);
        return Promise.resolve({ id: 'spalling', label });
      },
    });
    try {
      const r = await runRendererTool('propose_class', { label: 'Spalling' }, ctx());
      expect(asked).toEqual(['Spalling']);
      expect(r.result).toEqual({ classId: 'spalling', label: 'Spalling', created: true });
      expect(r.summary).toBe('Created class Spalling');
    } finally {
      off();
    }
  });

  it('says so when the app cannot create classes', async () => {
    await expect(runRendererTool('propose_class', { label: 'Spalling' }, ctx())).rejects.toThrow(
      'This app cannot create classes.',
    );
  });
});
