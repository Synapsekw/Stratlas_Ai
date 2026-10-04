import { describe, expect, it, vi } from 'vitest';
import { createAgentRuntime, type AgentRuntimeHost } from './main';
import { cleanNarrative, narrativeRequest, parseNarrativeReply } from './narrative';
import { createProviderRegistry } from './providers';
import { createScriptedProvider } from './scripted';

const facts = { project: 'HCl Tank', issues: { total: 13 } };

function runtime(cloud = true, host: Partial<AgentRuntimeHost> = {}) {
  return createAgentRuntime(
    {
      getKey: () => Promise.resolve(null),
      cloudAllowed: () => cloud,
      emit: () => undefined,
      ...host,
    },
    {
      providers: createProviderRegistry([createScriptedProvider('anthropic')]),
      maxRetries: 0,
    },
  );
}

describe('narrativeRequest', () => {
  it('asks for one JSON object with the parts and carries the statistics verbatim', () => {
    const r = narrativeRequest(facts, ['summary', 'findings']);
    expect(r.system).toContain('keys "summary", "findings"');
    expect(r.system).toContain('never invent numbers');
    expect(r.prompt).toContain('"project": "HCl Tank"');
    expect(r.prompt).toContain('summary: the executive summary');
    expect(r.prompt).not.toContain('method: the scope');
  });
});

describe('parseNarrativeReply', () => {
  it('reads the parts from a JSON answer, even wrapped in prose or a fence', () => {
    const r = parseNarrativeReply(
      'Here it is:\n```json\n{"summary": "A — B.", "method": "M {x}", "extra": 1}\n```',
    );
    expect(r).toEqual({ ok: true, parts: { summary: 'A, B.', method: 'M {x}' } });
  });

  it('takes a plain answer as the only part asked for, and refuses it for several', () => {
    expect(parseNarrativeReply('Plain text.', ['method'])).toEqual({
      ok: true,
      parts: { method: 'Plain text.' },
    });
    expect(parseNarrativeReply('Plain text.').ok).toBe(false);
    expect(parseNarrativeReply('{"other": "x"}').ok).toBe(false);
  });

  it('removes dashes and extra blank lines', () => {
    expect(cleanNarrative(' 5–10 m\r\n\r\n\r\n\r\nNext — end ')).toBe('5 to 10 m\n\nNext, end');
  });
});

describe('draft on the report route', () => {
  it('answers with the scripted narrative and meters the project', async () => {
    const recordUsage = vi.fn();
    const rt = runtime(true, { recordUsage });
    const req = narrativeRequest(facts);
    const r = await rt.draft({ runId: 'r1', projectId: 'p', task: 'report', ...req });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.provider).toBe('anthropic');
    const parsed = parseNarrativeReply(r.text);
    expect(parsed.ok && parsed.parts.summary).toContain('HCl Tank');
    expect(parsed.ok && parsed.parts.findings).toContain('13 issues');
    expect(recordUsage).toHaveBeenCalledWith(
      'p',
      expect.objectContaining({ provider: 'anthropic' }),
    );
  });

  it('refuses while cloud AI is off, and reports the report route in status', async () => {
    const rt = runtime(false);
    const r = await rt.draft({
      runId: 'r2',
      projectId: 'p',
      task: 'report',
      system: 's',
      prompt: 'p',
    });
    expect(r).toEqual({ ok: false, error: expect.stringContaining('Cloud AI is off') as string });
    const s = await rt.status({ task: 'report' });
    expect(s).toMatchObject({ ready: false, reason: 'cloud-off', route: { task: 'report' } });
  });

  it('refuses a project whose policy forbids cloud AI', async () => {
    const rt = runtime(true, { policy: () => Promise.resolve('forbid') });
    const r = await rt.draft({
      runId: 'r3',
      projectId: 'p',
      task: 'report',
      system: 's',
      prompt: 'p',
    });
    expect(r.ok).toBe(false);
  });
});
