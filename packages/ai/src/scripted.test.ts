import { EngineerProposal, type EngineerSetup } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { runEngineer, type EngineerCall, type EngineerHost } from './engineer';
import { createProviderRegistry } from './providers';
import { createScriptedProvider, SCRIPTED_ENGINEER } from './scripted';

const PNG =
  'data:image/png;base64,' +
  Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]),
    Buffer.from('IHDR', 'latin1'),
    Buffer.from([0, 0, 0, 8, 0, 0, 0, 8, 8, 2, 0, 0, 0, 0, 0, 0, 0]),
    Buffer.from([0, 0, 0, 0]),
    Buffer.from('IEND', 'latin1'),
    Buffer.from([0, 0, 0, 0]),
  ]).toString('base64');

const SETUP: EngineerSetup = {
  sources: { clouds: [], meshes: [], photos: [] },
  family: 'auto',
  scope: 'asset',
  detail: 'standard',
  placement: 'unplaced',
};

function call(marker: string): EngineerCall {
  return {
    projectId: 'p1',
    runId: 'run-1',
    pass: 1,
    images: [{ id: 'p1', kind: 'photo', dataUrl: PNG, bytes: 40 }],
    summary: JSON.stringify({ note: marker }),
    setup: SETUP,
  };
}

function host(provider: 'anthropic' | 'openai'): EngineerHost & { requests: () => number } {
  let requests = 0;
  const counted = createScriptedProvider(provider, true, {
    onGenerate: () => {
      requests += 1;
    },
  });
  return {
    route: () => ({
      task: 'engineer',
      provider,
      model: provider === 'anthropic' ? 'claude-opus-5-5' : 'gpt-6-luna',
    }),
    key: () => Promise.resolve(null),
    offlineOnly: () => false,
    policy: () => ({ ai: 'allow', photos: true, scans: true }),
    cache: { get: () => Promise.resolve(null), put: () => Promise.resolve() },
    spent: () => 0,
    usage: () => undefined,
    budgetUsd: 2,
    signal: new AbortController().signal,
    providers: createProviderRegistry([counted]),
    maxRetries: 0,
    requests: () => requests,
  };
}

describe('scripted engineer replies', () => {
  it.each(['anthropic', 'openai'] as const)(
    '%s: the default reply is a valid chimney',
    async (p) => {
      const h = host(p);
      const r = await runEngineer(call('no marker'), h);
      expect(r).toMatchObject({ kind: 'proposal', proposal: { family: { value: 'chimney' } } });
      expect(h.requests()).toBe(1);
    },
  );

  it.each([
    ['#engineer flare', 'flare'],
    ['#engineer lattice', 'telecom-lattice'],
    ['#engineer monopole', 'telecom-monopole'],
    ['#engineer chimney', 'chimney'],
  ])('%s gives a valid %s proposal, the same for both providers', async (marker, family) => {
    const a = await runEngineer(call(marker), host('anthropic'));
    const o = await runEngineer(call(marker), host('openai'));
    expect(a).toMatchObject({ kind: 'proposal', proposal: { family: { value: family } } });
    expect(o.kind === 'proposal' && o.proposal).toEqual(a.kind === 'proposal' && a.proposal);
  });

  it('#engineer invalid answers invalid first, then valid on the repair', async () => {
    const h = host('anthropic');
    const r = await runEngineer(call('#engineer invalid'), h);
    expect(r).toMatchObject({ kind: 'proposal' });
    expect(h.requests()).toBe(2);
  });

  it('#engineer invalid-always fails as invalid after one repair', async () => {
    const h = host('openai');
    expect(await runEngineer(call('#engineer invalid-always'), h)).toMatchObject({
      kind: 'failed',
      code: 'invalid',
    });
    expect(h.requests()).toBe(2);
  });

  it('#engineer conflict flags two structures', async () => {
    const r = await runEngineer(call('#engineer conflict'), host('anthropic'));
    expect(r).toMatchObject({ kind: 'proposal', identityConflict: true });
  });

  it('#engineer rate-limit answers 429', async () => {
    const h = host('anthropic');
    expect(await runEngineer(call('#engineer rate-limit'), h)).toMatchObject({
      kind: 'failed',
      code: 'rate-limit',
    });
  });

  it('every fixture is a valid proposal once mapped', () => {
    for (const [name, wire] of Object.entries(SCRIPTED_ENGINEER)) {
      const w = wire as {
        components: {
          params: { name: string; value: unknown }[];
          levels: number[];
          description: string;
        }[];
      };
      const p = {
        ...wire,
        components: w.components.map((c) => ({
          ...c,
          params: Object.fromEntries(c.params.map((x) => [x.name, x.value])),
          levels: c.levels.length ? c.levels : undefined,
          description: c.description || undefined,
        })),
      };
      const clean = JSON.parse(JSON.stringify(p)) as unknown;
      // `invalid` is out of range on purpose (the first reply of `#engineer invalid`)
      expect(EngineerProposal.safeParse(clean).success, name).toBe(name !== 'invalid');
    }
  });
});
