import { ProcModel, type EngineerProposal, type ProposalComponent } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { monopoleEvidence, monopoleProposal, setupFor } from '../fixtures';
import { buildEngineeringGlb } from '../meshAssemblies';
import { assemble, type AssembleInput } from './assemble';
import { base, byKind, must, noUser } from './testAssemble';

const component = (
  role: string,
  kind: string,
  count: number,
  params: ProposalComponent['params'],
  levels: number[] = [],
): ProposalComponent => ({
  role,
  kind,
  count,
  params,
  levels,
  units: 'm',
  observed: true,
  imageIds: ['img-side'],
});

const proposal = (): EngineerProposal => ({
  ...monopoleProposal(),
  components: [
    component('pole', 'monopole', 1, { rBase: 0.5, rTop: 0.33 }),
    component(
      'antenna',
      'antenna',
      12,
      { type: 'panel', size: 2.1, sectors: 3, azimuthDeg: 0 },
      [0.87],
    ),
    component(
      'small-panel',
      'antenna',
      4,
      { type: 'panel', size: 0.6, sectors: 4, azimuthDeg: 30 },
      [0.88],
    ),
    component('whip', 'antenna', 1, { type: 'whip', size: 1.5, sectors: 1, azimuthDeg: 60 }, [1]),
  ],
});

const input = (): AssembleInput => ({
  ...base,
  family: 'telecom-monopole',
  proposal: proposal(),
  setup: { ...setupFor('telecom-monopole'), reference: { what: 'height', valueM: 31 } },
});

const contaminated = () => ({
  ...monopoleEvidence(),
  height: 2.4,
  bounds: {
    min: [-4, 0, -4] as [number, number, number],
    max: [4, 31.2, 4] as [number, number, number],
  },
  taper: {
    profile: [
      { y: 0, r: 3.75 },
      { y: 2.4, r: 3.8 },
    ],
    residualM: 0.002,
  },
});

describe('engineering model quality regressions', () => {
  it('uses a known height with reference provenance instead of a short compound fit', () => {
    const result = assemble({ ...input(), evidence: contaminated() });
    const pole = must(byKind(result.model, 'monopole')[0]);
    expect(pole.params.profile.at(-1)?.y).toBe(31);
    expect(result.model.scale).toEqual({
      status: 'reference',
      reference: { what: 'height', valueM: 31 },
    });
    expect(pole.params.profile.map((p) => p.r)).toEqual([0.5, 0.33]);
    expect(pole.quality.profile?.basis).toBe('observed');
    expect(pole.quality.base?.basis).toBe('measured');
    expect(result.unresolved.some((s) => /profile|fit/i.test(s))).toBe(true);
    expect(ProcModel.safeParse(result.model).success).toBe(true);
  });

  it('keeps the measured cloud scale when an approximate reference height is supplied', () => {
    const result = assemble({ ...input(), evidence: monopoleEvidence() });
    const pole = must(byKind(result.model, 'monopole')[0]);
    expect(pole.params.profile.at(-1)?.y).toBe(30);
    expect(pole.quality.profile?.basis).toBe('measured');
    expect(result.model.scale?.status).toBe('measured');
  });

  it('does not label the height of a low compound fit as the measured height of a tall source', () => {
    const run = input();
    const result = assemble({
      ...run,
      setup: setupFor('telecom-monopole'),
      evidence: contaminated(),
    });
    expect(result.model.scale?.status).toBe('provisional');
    const pole = must(byKind(result.model, 'monopole')[0]);
    expect(pole.params.profile.at(-1)?.y).toBe(30);
    expect(pole.params.profile.map((p) => p.r)).toEqual([0.5, 0.33]);
    expect(pole.quality.profile?.basis).toBe('observed');
  });

  it.each([
    { estimate: undefined, reference: undefined, height: 30, status: 'provisional' },
    { estimate: 31, reference: undefined, height: 31, status: 'provisional' },
    { estimate: undefined, reference: 31, height: 31, status: 'reference' },
  ] as const)(
    'keeps an explicitly unknown height unknown with estimate $estimate and reference $reference',
    ({ estimate, reference, height, status }) => {
      const evidence = monopoleEvidence();
      evidence.height = null;
      evidence.bounds = { min: [-1, 0, -1], max: [1, 31, 1] };
      evidence.taper = {
        profile: [
          { y: 0, r: 0.5 },
          { y: 20, r: 0.35 },
        ],
        residualM: 0.01,
      };
      const p = proposal();
      p.components = [
        component('pole', 'monopole', 1, {
          rBase: 0.6,
          rTop: 0.4,
          ...(estimate === undefined ? {} : { height: estimate }),
        }),
      ];
      const setup = setupFor('telecom-monopole');
      if (reference !== undefined) setup.reference = { what: 'height', valueM: reference };
      const result = assemble({ ...input(), setup, evidence, proposal: p });
      expect(result.model.scale?.status).toBe(status);
      const pole = must(byKind(result.model, 'monopole')[0]);
      expect(pole.params.profile.at(-1)?.y).toBe(height);
      expect(pole.params.profile[0]?.r).toBe(0.5);
      expect(pole.params.profile.at(-1)?.r).toBe(0.35);
      expect(pole.quality.profile?.basis).toBe('measured');
      expect(pole.quality.base?.basis).toBe('measured');
    },
  );

  it('keeps large panels, small panels and a whip distinct in the generated geometry', () => {
    const result = assemble(input());
    const ants = byKind(result.model, 'antenna');
    expect(ants).toHaveLength(17);
    expect(ants.filter((a) => a.params.kind === 'panel' && a.params.size[1] === 2.1)).toHaveLength(
      12,
    );
    const small = ants.filter((a) => a.params.size[1] === 0.6);
    expect(small).toHaveLength(4);
    expect(small.map((a) => a.params.azimuthDeg).sort((a, b) => a - b)).toEqual([
      30, 120, 210, 300,
    ]);
    expect(small.every((a) => a.params.centre[1] === 27.28)).toBe(true);
    const whip = must(ants.find((a) => a.params.kind === 'omni'));
    expect(whip.params.size).toEqual([0.07500000000000001, 1.5, 0.07500000000000001]);
    expect(whip.params.centre[1]).toBe(31);
    expect(whip.params.azimuthDeg).toBe(60);
    expect(
      buildEngineeringGlb(result.model, { detail: 'fast', drafts: true, generator: 'test' }).failed,
    ).toEqual([]);
  });

  it('does not turn one merged headframe candidate into an individual panel or a single long row', () => {
    const evidence = monopoleEvidence();
    evidence.members = [
      {
        kind: 'antenna-candidate',
        metrics: {},
        items: [{ centre: [0, 28, 0], size: 5.9, support: 280_000, azimuthDeg: 354 }],
      },
    ];
    const result = assemble({ ...input(), evidence });
    const antennas = byKind(result.model, 'antenna');
    expect(antennas).toHaveLength(17);
    expect(
      antennas.filter((a) => a.params.kind === 'panel' && a.params.size[1] === 2.1),
    ).toHaveLength(12);
    expect(
      antennas.filter((a) => a.params.kind === 'panel' && a.params.size[1] === 0.6),
    ).toHaveLength(4);
    expect(antennas.filter((a) => a.params.kind === 'omni')).toHaveLength(1);
    expect(
      [
        ...new Set(
          antennas.filter((a) => a.params.size[1] === 2.1).map((a) => a.params.azimuthDeg),
        ),
      ].sort((a, b) => a - b),
    ).toEqual([0, 120, 240]);
    expect(antennas.every((a) => Math.hypot(a.params.centre[0], a.params.centre[2]) < 3)).toBe(
      true,
    );
    expect(antennas.every((a) => a.quality.centre?.basis !== 'measured')).toBe(true);
    expect(result.unresolved.some((s) => /antenna.*candidate|candidate.*antenna/i.test(s))).toBe(
      true,
    );
  });

  it('keeps a valid measured panel without forcing all unseen panels into its single observed sector', () => {
    const evidence = monopoleEvidence();
    evidence.members = [
      {
        kind: 'antenna-candidate',
        metrics: {},
        items: [{ centre: [0, 26.97, -1.2], size: 2.1, support: 300, azimuthDeg: 0 }],
      },
    ];
    const result = assemble({ ...input(), evidence });
    const large = byKind(result.model, 'antenna').filter((a) => a.params.size[1] === 2.1);
    expect(large).toHaveLength(12);
    const measured = large.filter((a) => a.quality.centre?.basis === 'measured');
    expect(measured).toHaveLength(1);
    expect(must(measured[0]).params.centre).toEqual([0, 26.97, -1.2]);
    expect([...new Set(large.map((a) => a.params.azimuthDeg))].sort((a, b) => a - b)).toEqual([
      0, 120, 240,
    ]);
    expect(large.every((a) => Math.hypot(a.params.centre[0], a.params.centre[2]) < 3)).toBe(true);
  });

  it('preserves accepted group IDs and user edits when proposals reorder', () => {
    const first = assemble(input()).model;
    const small = must(byKind(first, 'antenna').find((a) => a.params.size[1] === 0.6));
    const previous = {
      ...first,
      assemblies: first.assemblies.map((a) =>
        a.id === small.id ? { ...a, status: 'accepted' as const } : a,
      ),
    };
    const p = proposal();
    const user = { ...noUser(), params: { [small.id]: { tiltDeg: 7 } } };
    const rebuilt = assemble({
      ...input(),
      previous,
      user,
      proposal: { ...p, components: [...p.components].reverse() },
    });
    const kept = must(byKind(rebuilt.model, 'antenna').find((a) => a.id === small.id));
    expect(kept.status).toBe('accepted');
    expect(kept.params.size[1]).toBe(0.6);
    expect(kept.params.tiltDeg).toBe(7);
    expect(kept.quality.tiltDeg?.basis).toBe('user');
    expect(
      byKind(rebuilt.model, 'antenna')
        .map((a) => a.id)
        .sort(),
    ).toEqual(
      byKind(first, 'antenna')
        .map((a) => a.id)
        .sort(),
    );
  });

  it('honours zero counts per group and globally without changing other groups', () => {
    const run = input();
    const model = assemble({ ...run, user: { ...noUser(), counts: { 'small-panel': 0 } } }).model;
    expect(byKind(model, 'antenna')).toHaveLength(13);
    expect(byKind(model, 'antenna').filter((a) => a.params.kind === 'omni')).toHaveLength(1);
    expect(
      byKind(assemble({ ...run, user: { ...noUser(), counts: { antenna: 0 } } }).model, 'antenna'),
    ).toEqual([]);
  });

  it('honours a named count when only one custom group remains', () => {
    const p = proposal();
    const result = assemble({
      ...input(),
      proposal: {
        ...p,
        components: p.components.filter((c) => c.role !== 'antenna' && c.role !== 'small-panel'),
      },
      user: { ...noUser(), counts: { whip: 0 } },
    });
    expect(byKind(result.model, 'antenna')).toEqual([]);
  });

  it('does not reassign a disabled group measurement to another antenna group', () => {
    const evidence = monopoleEvidence();
    evidence.members = [
      {
        kind: 'antenna-candidate',
        metrics: {},
        items: [
          { centre: [0, 26, -1], size: 2.1, support: 100 },
          { centre: [1, 27, 0], size: 0.6, support: 500 },
        ],
      },
    ];
    const p = proposal();
    p.components = [
      component('antenna', 'antenna', 1, { type: 'panel', size: 2.1, sectors: 1 }, [26 / 31]),
      component('small', 'antenna', 1, { type: 'panel', size: 0.6, sectors: 1 }, [27 / 31]),
    ];
    const result = assemble({
      ...input(),
      evidence,
      proposal: p,
      user: { ...noUser(), counts: { small: 0 } },
    });
    const antennas = byKind(result.model, 'antenna');
    expect(antennas).toHaveLength(1);
    expect(must(antennas[0]).params.size[1]).toBe(2.1);
    expect(must(antennas[0]).params.centre[1]).toBe(26);
  });

  it('keeps an accepted legacy group when a same-role group is added, changed, reordered and removed', () => {
    const large = {
      ...component(
        'antenna',
        'antenna',
        1,
        { type: 'panel', size: 2.1, sectors: 1, azimuthDeg: 0 },
        [0.84],
      ),
      imageIds: ['img-large'],
      description: 'Upper long panels.',
    };
    const small = {
      ...component(
        'antenna',
        'antenna',
        1,
        { type: 'panel', size: 0.6, sectors: 1, azimuthDeg: 120 },
        [0.9],
      ),
      imageIds: ['img-small'],
      description: 'Small panels on separate pipes.',
    };
    const p = proposal();
    const first = assemble({ ...input(), proposal: { ...p, components: [large] } }).model;
    const accepted = { ...must(byKind(first, 'antenna')[0]), status: 'accepted' as const };
    expect(accepted.id).toBe('antenna-s1-1');
    const previous = {
      ...first,
      assemblies: first.assemblies.map((a) => (a.id === accepted.id ? accepted : a)),
    };
    const added = assemble({
      ...input(),
      previous,
      proposal: { ...p, components: [large, small] },
    }).model;
    expect(byKind(added, 'antenna')).toHaveLength(2);
    expect(byKind(added, 'antenna').find((a) => a.id === accepted.id)).toBe(accepted);
    const smallId = must(byKind(added, 'antenna').find((a) => a.params.size[1] === 0.6)).id;
    const changed = { ...small, params: { ...small.params, size: 3.2 }, levels: [0.92] };
    const reordered = assemble({
      ...input(),
      previous: added,
      proposal: { ...p, components: [changed, large] },
    }).model;
    expect(byKind(reordered, 'antenna')).toHaveLength(2);
    expect(byKind(reordered, 'antenna').find((a) => a.id === accepted.id)).toBe(accepted);
    expect(byKind(reordered, 'antenna').find((a) => a.id === smallId)?.params.size[1]).toBe(3.2);
    const onlySmall = assemble({
      ...input(),
      previous: reordered,
      proposal: { ...p, components: [changed] },
    }).model;
    expect(byKind(onlySmall, 'antenna')).toHaveLength(2); // The removed accepted large group is retained once.
    expect(byKind(onlySmall, 'antenna').find((a) => a.id === accepted.id)).toBe(accepted);
    expect(byKind(onlySmall, 'antenna').find((a) => a.id === smallId)?.params.size[1]).toBe(3.2);
    const restored = assemble({
      ...input(),
      previous: onlySmall,
      proposal: { ...p, components: [large, changed] },
    }).model;
    expect(byKind(restored, 'antenna')).toHaveLength(2);
    expect(byKind(restored, 'antenna').find((a) => a.id === accepted.id)).toBe(accepted);
  });

  it('keeps repeated role labels valid and stable across proposal reordering', () => {
    const p = proposal();
    p.components = p.components.map((c) => (c.kind === 'antenna' ? { ...c, role: 'antenna' } : c));
    const first = assemble({ ...input(), proposal: p }).model;
    expect(ProcModel.safeParse(first).success).toBe(true);
    const next = assemble({
      ...input(),
      proposal: { ...p, components: [...p.components].reverse() },
      previous: first,
    }).model;
    expect(
      byKind(next, 'antenna')
        .map((a) => [a.id, a.params.kind, a.params.size])
        .sort(),
    ).toEqual(
      byKind(first, 'antenna')
        .map((a) => [a.id, a.params.kind, a.params.size])
        .sort(),
    );
  });

  it('rejects low unconfirmed and canopy-sized light candidates but keeps plausible high candidates', () => {
    const evidence = monopoleEvidence();
    evidence.members = [
      {
        kind: 'light-candidate',
        metrics: {},
        items: [
          { centre: [0, 1.5, -1], size: 0.3, support: 50 },
          { centre: [0, 20, -1], size: 5.2, support: 500 },
          { centre: [0, 24, -1], size: 0.3, support: 50 },
        ],
      },
    ];
    const result = assemble({ ...input(), evidence });
    const lights = byKind(result.model, 'warningLight');
    expect(lights).toHaveLength(1);
    expect(must(lights[0]).params.centre[1]).toBe(24);
    expect(must(lights[0]).params.size).toBe(0.3);
    expect(result.unresolved.some((s) => /light.*candidate|candidate.*light/i.test(s))).toBe(true);
  });

  it('keeps a visually confirmed low light and an explicit user count without importing an oversized fit', () => {
    const evidence = monopoleEvidence();
    evidence.members = [
      {
        kind: 'light-candidate',
        metrics: {},
        items: [{ centre: [0, 1.55, -1], size: 0.3, support: 50 }],
      },
    ];
    const p = proposal();
    const low = component('low-light', 'warningLight', 1, { fixture: 'single', size: 0.3 }, [0.05]);
    const confirmed = assemble({
      ...input(),
      evidence,
      proposal: { ...p, components: [...p.components, low] },
    });
    expect(byKind(confirmed.model, 'warningLight')).toHaveLength(1);
    const explicit = assemble({
      ...input(),
      evidence,
      user: { ...noUser(), counts: { 'light-l1': 1 } },
    });
    expect(byKind(explicit.model, 'warningLight')).toHaveLength(1);
  });

  it('preserves an explicit light size edit at a low candidate level', () => {
    const evidence = monopoleEvidence();
    evidence.members = [
      {
        kind: 'light-candidate',
        metrics: {},
        items: [
          { centre: [0, 1.5, -1], size: 5.2, support: 500 },
          { centre: [1, 1.5, 0], size: 0.3, support: 50 },
        ],
      },
    ];
    const result = assemble({
      ...input(),
      evidence,
      user: { ...noUser(), params: { 'light-l1-1': { size: 0.45 } } },
    });
    expect(byKind(result.model, 'warningLight')).toHaveLength(1);
    expect(must(byKind(result.model, 'warningLight')[0]).params.size).toBe(0.45);
  });
});
