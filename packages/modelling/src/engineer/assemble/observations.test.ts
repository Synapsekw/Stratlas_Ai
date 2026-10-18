import { ProcModel, type ComponentObservation, type ProposalComponent } from '@aio/schema';
import { expect, it } from 'vitest';
import { monopoleEvidence, monopoleProposal, setupFor } from '../fixtures';
import { assemble } from './assemble';
import { base, byId, byKind } from './testAssemble';
import { buildEngineeringGlb } from '../meshAssemblies';
import { meshAssemblies } from '../meshAssemblies';
import { readGlb } from '../../glb';

const q = { basis: 'observed' as const };
const observation = (
  id: string,
  kind: ComponentObservation['kind'],
  x: number,
): ComponentObservation => ({
  id,
  kind,
  name: id,
  centre: [x, 29, -1.4],
  size: [0.44, 1.9, 0.21],
  azimuthDeg: 73,
  tiltDeg: 3,
  quality: { centre: q, width: q, height: q, depth: q, azimuthDeg: q, tiltDeg: q },
  sources: [{ kind: 'drawing', ref: 'dxf-test' }],
});
const run = (observations: ComponentObservation[]) =>
  assemble({
    ...base,
    family: 'telecom-monopole',
    setup: { ...setupFor('telecom-monopole'), reference: { what: 'height', valueM: 31 } },
    evidence: { ...monopoleEvidence(), height: 31.139, observations },
    proposal: monopoleProposal(),
  });

const cloudBox = (): ComponentObservation => ({
  ...observation('obs-cloud-box', 'equipment-box', 12),
  name: 'Unclassified enclosure',
  centre: [12, 35, -7],
  size: [0.38, 0.6, 0.19],
  azimuthDeg: 90,
  tiltDeg: 30,
  quality: {
    centre: { basis: 'inferred', note: 'Centre uses inferred depth.' },
    width: { basis: 'measured', support: 180 },
    height: { basis: 'measured', support: 180 },
    depth: { basis: 'inferred', note: 'Rear face not observed.' },
    azimuthDeg: { basis: 'measured', support: 180 },
    tiltDeg: { basis: 'measured', support: 180 },
  },
  sources: [{ kind: 'cloud', ref: 'cloud-1' }],
  notes: ['Equipment type unresolved; front face only.'],
});

it('keeps independent unknown boxes selectable without duplicate fallback antennas or invented supports', () => {
  const box = cloudBox();
  const second: ComponentObservation = {
    ...box,
    id: 'obs-cloud-box-b',
    centre: [11, 34, -6],
    size: [0.27, 0.4, 0.16],
    azimuthDeg: 0,
    tiltDeg: 0,
  };
  const warnings = [
    'Partial crown coverage: additional equipment may be missing.',
    'Sideways roll is unsupported.',
  ];
  const { model } = assemble({
    ...base,
    family: 'telecom-monopole',
    setup: setupFor('telecom-monopole'),
    evidence: { ...monopoleEvidence(), observations: [box, second], warnings },
    proposal: monopoleProposal(),
  });
  expect(byKind(model, 'antenna')).toEqual([]);
  expect(byKind(model, 'antennaMount')).toEqual([]);
  expect(model.assemblies.filter((a) => a.category === 'Cabling')).toEqual([]);
  const kept = byId(model, box.id);
  expect(kept).toMatchObject({
    kind: 'cabinet',
    type: 'equipment-box',
    sources: box.sources,
    params: { size: box.size, yawDeg: 90, tiltDeg: 30 },
    quality: {
      size: { basis: 'inferred' },
      base: { basis: 'inferred' },
      tiltDeg: box.quality.tiltDeg,
    },
    unobserved: ['back'],
  });
  if (kept.kind !== 'cabinet') throw new Error('expected enclosure');
  expect(kept.params.base[0]).toBeCloseTo(11.85, 10);
  expect(kept.params.base[1]).toBeCloseTo(35 - 0.3 * Math.cos(Math.PI / 6), 10);
  expect(kept.params.base[2]).toBeCloseTo(-7, 10);
  expect(model.evidence?.unresolved).toEqual(expect.arrayContaining(warnings));
  expect(kept.description).toContain('Equipment type unresolved');
  expect(ProcModel.safeParse(model).success).toBe(true);
  const built = buildEngineeringGlb(model, { detail: 'fast', drafts: true, generator: 'test' });
  expect(built.failed).toEqual([]);
  const nodes = readGlb(built.glb).json.nodes as {
    name: string;
    extras?: { component?: string; type?: string };
  }[];
  for (const o of [box, second]) {
    expect(nodes.filter((n) => n.name === o.id)).toHaveLength(1);
    expect(nodes.find((n) => n.name === o.id)?.extras).toMatchObject({
      component: o.id,
      type: 'equipment-box',
    });
  }
});

it('preserves an independent box mesh under input reorder, translation and compass rotation', () => {
  const box = cloudBox();
  const panel: ComponentObservation = {
    ...observation('obs-cloud-panel', 'panel', 10),
    sources: box.sources,
  };
  const first = run([box, panel]).model;
  const shiftedBox: ComponentObservation = { ...box, centre: [107, 47, -288], azimuthDeg: 180 };
  const shiftedPanel: ComponentObservation = {
    ...panel,
    centre: [101.4, 41, -290],
    azimuthDeg: 163,
  };
  const shifted = run([shiftedPanel, shiftedBox]).model;
  const points = (model: typeof first) => {
    const component = meshAssemblies(model, { detail: 'fast', include: (a) => a.id === box.id })
      .components[0];
    if (!component) throw new Error('missing box mesh');
    return component.prims.flatMap((p) =>
      Array.from({ length: p.positions.length / 3 }, (_, i) => [
        (p.positions[i * 3] ?? 0) + component.anchor[0],
        (p.positions[i * 3 + 1] ?? 0) + component.anchor[1],
        (p.positions[i * 3 + 2] ?? 0) + component.anchor[2],
      ]),
    );
  };
  const firstPoints = points(first);
  // Project onto the independently specified measured axes: a zero-tilt box can still pass
  // a rotation/translation invariance test, but cannot fit these measured face extents.
  const axes = [
    [0, 0, 1],
    [0.5, Math.sqrt(3) / 2, 0],
    [Math.sqrt(3) / 2, -0.5, 0],
  ];
  for (const [i, axis] of axes.entries()) {
    const projected = firstPoints.map((p) =>
      p.reduce((sum, n, j) => sum + (n - (box.centre[j] ?? 0)) * (axis[j] ?? 0), 0),
    );
    expect(Math.min(...projected)).toBeCloseTo(-(box.size[i] ?? 0) / 2, 6);
    expect(Math.max(...projected)).toBeCloseTo((box.size[i] ?? 0) / 2, 6);
  }
  const expected = firstPoints.map(([x = 0, y = 0, z = 0]) => [100 - z, 12 + y, -300 + x]);
  const actual = points(shifted);
  expect(actual).toHaveLength(expected.length);
  for (const p of expected)
    expect(actual.some((q) => Math.hypot(...q.map((n, i) => n - (p[i] ?? 0))) < 1e-5)).toBe(true);
  expect(byId(shifted, box.id).sources).toEqual(box.sources);
  expect(byId(shifted, box.id).quality).toEqual(byId(first, box.id).quality);
});

it('keeps coarse fallback equipment when no independent device was found', () => {
  const pipe = observation('obs-cloud-pipe', 'mounting-pipe', 1);
  expect(byKind(run([pipe]).model, 'antenna').length).toBeGreaterThan(0);
  expect(byKind(run([]).model, 'antenna').length).toBeGreaterThan(0);
});

const classifyBox = (
  changes: Partial<ProposalComponent> = {},
  kind: ComponentObservation['kind'] = 'equipment-box',
  parentPipe?: ComponentObservation,
  sourceBox: ComponentObservation = cloudBox(),
) => {
  const box = { ...sourceBox, kind, ...(parentPipe ? { parent: parentPipe.id } : {}) };
  const proposal = monopoleProposal();
  proposal.components = [
    {
      role: 'box-review',
      kind: 'antenna',
      count: 1,
      units: 'm',
      params: { observationId: box.id, kind: 'rru', height: 99, azimuthDeg: 0 },
      observed: true,
      imageIds: ['img-photo-source'],
      description: 'Radio identified in the source photo.',
      ...changes,
    },
  ];
  const image = {
    file: 'img/test.png',
    view: 'source',
    w: 100,
    h: 100,
    bytes: 100,
    sha1: 'a'.repeat(40),
  };
  return assemble({
    ...base,
    family: 'telecom-monopole',
    setup: setupFor('telecom-monopole'),
    proposal,
    evidence: {
      ...monopoleEvidence(),
      observations: [box, ...(parentPipe ? [parentPipe] : [])],
      images: [
        { ...image, id: 'img-photo-source', kind: 'photo' },
        { ...image, id: 'img-model-front', kind: 'side' },
        { ...image, id: 'img-crop-front', kind: 'crop' },
      ],
    },
  });
};

it.each(['panel', 'rru'] as const)(
  'refines an unknown box to %s only from its exact original-photo association, retaining measured geometry',
  (kind) => {
    const box = cloudBox();
    const out = classifyBox({ params: { observationId: box.id, kind, height: 99, azimuthDeg: 0 } });
    const kept = byId(out.model, box.id);
    expect(kept).toMatchObject({
      kind: 'antenna',
      type: 'equipment-box',
      params: {
        kind,
        centre: box.centre,
        size: box.size,
        azimuthDeg: box.azimuthDeg,
        tiltDeg: box.tiltDeg,
      },
      quality: {
        kind: { basis: 'observed' },
        centre: box.quality.centre,
        size: { basis: 'inferred' },
        azimuthDeg: box.quality.azimuthDeg,
        tiltDeg: box.quality.tiltDeg,
      },
      unobserved: ['back'],
    });
    expect(kept.sources).toEqual([...box.sources, { kind: 'photo', ref: 'img-photo-source' }]);
    expect(kept.description).toContain('front face only');
    expect(out.unresolved.join(' ')).not.toContain('classification differs');
    expect(byKind(out.model, 'antenna')).toHaveLength(1);
    expect(byKind(out.model, 'antennaMount')).toEqual([]);
    expect(ProcModel.safeParse(out.model).success).toBe(true);
  },
);

it.each([
  { imageIds: ['img-model-front'] },
  { imageIds: ['img-crop-front'] },
  { imageIds: ['img-missing-photo'] },
  { imageIds: [] },
  { observed: false },
  { count: 2 },
  { params: { observationId: 'obs-wrong', kind: 'rru' } },
  { params: { observationId: 'obs-cloud-box', kind: 'dish' } },
] satisfies Partial<ProposalComponent>[])(
  'does not refine an unknown box from unsupported AI evidence %j',
  (changes) => {
    expect(byId(classifyBox(changes).model, cloudBox().id)).toMatchObject({
      kind: 'cabinet',
      type: 'equipment-box',
    });
  },
);

it('does not replace a known source class even when AI supplies an original photo', () => {
  const out = classifyBox({}, 'panel');
  expect(byId(out.model, cloudBox().id)).toMatchObject({
    kind: 'antenna',
    params: { kind: 'panel' },
  });
  expect(out.unresolved.join(' ')).toContain('classification differs');
});

const cloudPipe = (): ComponentObservation => ({
  ...observation('obs-cloud-pipe', 'mounting-pipe', 11.6),
  centre: [11.6, 35, -7],
  size: [0.08, 2, 0.08],
  path: [
    [11.6, 34, -7],
    [11.6, 36, -7],
  ],
  sources: [{ kind: 'cloud', ref: 'cloud-1' }],
});

it.each(['panel', 'rru'] as const)(
  'adds explicitly inferred %s hardware to a photo-classified box only through its source-supported parent pipe',
  (kind) => {
    const box = cloudBox();
    const pipe = cloudPipe();
    const before = JSON.stringify(pipe);
    const { model } = classifyBox(
      { params: { observationId: box.id, kind } },
      'equipment-box',
      pipe,
    );
    const clamps = model.assemblies.filter((a) => a.parent === box.id && a.kind === 'antennaMount');
    const cables = model.assemblies.filter((a) => a.parent === box.id && a.category === 'Cabling');
    expect(clamps).toHaveLength(2);
    expect(cables).toHaveLength(kind === 'panel' ? 4 : 2);
    for (const clamp of clamps)
      expect(clamp).toMatchObject({
        quality: { size: { basis: 'inferred' }, kind: { basis: 'inferred' } },
      });
    for (const cable of cables) {
      expect(cable).toMatchObject({ quality: { path: { basis: 'inferred' } } });
      expect(cable.description).toContain(
        'Cable count, ports and electrical connectivity are not measured',
      );
    }
    expect(byId(model, box.id)).toMatchObject({
      parent: pipe.id,
      params: {
        centre: box.centre,
        size: box.size,
        azimuthDeg: box.azimuthDeg,
        tiltDeg: box.tiltDeg,
      },
    });
    expect(JSON.stringify(pipe)).toBe(before);
    expect(ProcModel.safeParse(model).success).toBe(true);
    expect(
      buildEngineeringGlb(model, { detail: 'detailed', drafts: true, generator: 'test' }).failed,
    ).toEqual([]);
  },
);

it('retains an unknown box parent without inventing brackets or cable counts from generated views', () => {
  const box = cloudBox();
  const pipe = cloudPipe();
  const out = classifyBox({ imageIds: ['img-crop-front'] }, 'equipment-box', pipe);
  expect(byId(out.model, box.id)).toMatchObject({ kind: 'cabinet', parent: pipe.id });
  expect(out.model.assemblies.filter((a) => a.parent === box.id)).toEqual([]);
  expect(out.unresolved.join(' ')).toContain(
    'equipment type unresolved; brackets and cable routes were not inferred',
  );
});

it('does not label inferred clamp attachment positions as measured when the source device centre is measured', () => {
  const box = cloudBox();
  box.quality.centre = { basis: 'measured', support: 180 };
  const { model } = classifyBox({}, 'equipment-box', cloudPipe(), box);
  expect(byId(model, box.id).quality.centre).toEqual(box.quality.centre);
  const clamps = model.assemblies.filter((a) => a.parent === box.id && a.kind === 'antennaMount');
  expect(clamps).toHaveLength(2);
  for (const clamp of clamps) {
    for (const key of ['centre', 'anchor']) {
      expect(clamp.quality[key]).toMatchObject({ basis: 'inferred' });
      expect(clamp.quality[key]?.support).toBeUndefined();
      expect(clamp.quality[key]?.note).toContain('not directly observed');
    }
  }
  expect(ProcModel.safeParse(model).success).toBe(true);
});

it('retains inferred bearing provenance when deriving a tilted enclosure bottom from a measured centre', () => {
  const box = cloudBox();
  box.quality.centre = { basis: 'measured', support: 180 };
  box.quality.azimuthDeg = { basis: 'inferred', note: 'Face bearing is ambiguous.' };
  expect(byId(run([box]).model, box.id)).toMatchObject({
    quality: { base: { basis: 'inferred' }, yawDeg: box.quality.azimuthDeg },
  });
});

it('does not report supported measured mounts and decks as unplaced or misclassified', () => {
  const pipe = observation('obs-pipe', 'mounting-pipe', 1);
  const deck: ComponentObservation = {
    ...observation('obs-deck', 'platform', 0),
    path: [
      [-2, 27, -2],
      [2, 27, -2],
      [2, 27, 2],
      [-2, 27, 2],
    ],
  };
  const proposal = monopoleProposal();
  proposal.components = [
    {
      role: 'mount',
      kind: 'antennaMount',
      count: 1,
      units: 'm',
      params: { observationId: pipe.id, type: 'pipe' },
      imageIds: [],
      observed: true,
    },
    {
      role: 'deck',
      kind: 'deck',
      count: 1,
      units: 'm',
      params: { observationId: deck.id },
      imageIds: [],
      observed: true,
    },
    {
      role: 'hatch',
      kind: 'hatch',
      count: 1,
      units: 'm',
      params: {},
      imageIds: [],
      observed: true,
    },
  ];
  const out = assemble({
    ...base,
    family: 'telecom-monopole',
    setup: setupFor('telecom-monopole'),
    evidence: { ...monopoleEvidence(), observations: [pipe, deck] },
    proposal,
  });
  expect(byId(out.model, pipe.id).kind).toBe('pipeRun');
  expect(byId(out.model, deck.id).kind).toBe('deck');
  expect(out.unresolved.join(' ')).not.toContain('classification differs');
  expect(out.unresolved.join(' ')).not.toContain('"deck" components');
  expect(out.unresolved.join(' ')).toContain('"hatch" components');
});

it('does not duplicate measured platforms from an AI group and retains local evidence warnings', () => {
  const proposal = monopoleProposal();
  proposal.components.push({
    role: 'platform',
    kind: 'ringPlatform',
    count: 1,
    units: 'm',
    params: {},
    levels: [0.8],
    imageIds: [],
    observed: true,
  });
  const warnings = [
    'P14: insufficient cloud support.',
    'Drawing registration requires alignment review.',
  ];
  const out = assemble({
    ...base,
    family: 'telecom-monopole',
    setup: setupFor('telecom-monopole'),
    evidence: {
      ...monopoleEvidence(),
      warnings,
      observations: [
        {
          ...observation('obs-deck', 'platform', 0),
          centre: [0, 27, 0],
          size: [4, 0.1, 4],
          path: [
            [-2, 27, -2],
            [2, 27, -2],
            [2, 27, 2],
            [-2, 27, 2],
          ],
        },
      ],
    },
    proposal,
  });
  expect(byKind(out.model, 'deck').map((a) => a.id)).toEqual(['obs-deck']);
  expect(out.model.evidence?.unresolved).toEqual(expect.arrayContaining(warnings));
});

it('associates an AI review with one source object without replacing its measured pose', () => {
  const panel = observation('obs-a01', 'panel', 1);
  const proposal = monopoleProposal();
  proposal.components = [
    {
      role: 'panel-review',
      kind: 'antenna',
      count: 1,
      units: 'm',
      params: { observationId: panel.id, kind: 'rru', azimuthDeg: 220, height: 9 },
      imageIds: [],
      observed: true,
      description: 'Possible radio housing.',
    },
  ];
  const out = assemble({
    ...base,
    family: 'telecom-monopole',
    setup: setupFor('telecom-monopole'),
    evidence: { ...monopoleEvidence(), observations: [panel] },
    proposal,
  });
  expect(byId(out.model, panel.id)).toMatchObject({
    params: { centre: panel.centre, size: panel.size, azimuthDeg: panel.azimuthDeg, kind: 'panel' },
  });
  expect(
    out.unresolved.some((s) => s.includes(panel.id) && s.includes('classification differs')),
  ).toBe(true);
});

it('adds removable inferred service loops and platform supports without changing measured devices', () => {
  const pipe = {
    ...observation('obs-p01', 'mounting-pipe', 1),
    size: [0.1, 5, 0.1] as [number, number, number],
  };
  const panel = { ...observation('obs-a01', 'panel', 1.5), parent: pipe.id };
  const deck = {
    ...observation('obs-deck', 'platform', 0),
    centre: [0, 27, 0] as [number, number, number],
    path: [
      [-2, 27, -2],
      [2, 27, -2],
      [2, 27, 2],
      [-2, 27, 2],
    ] as [number, number, number][],
  };
  const { model } = run([pipe, panel, deck]);
  const cable = model.assemblies.find((a) => a.id === panel.id + '-service-loop');
  expect(cable).toMatchObject({
    params: { bendRadius: 0 },
    parent: panel.id,
    kind: 'pipeRun',
    material: 'cable',
    quality: { path: { basis: 'inferred' } },
  });
  expect(model.assemblies.some((a) => a.id === pipe.id + '-support-1')).toBe(true);
  expect(model.assemblies.some((a) => a.id === pipe.id + '-collar-1')).toBe(true);
  const looms = model.assemblies.filter((a) => a.id.startsWith(deck.id + '-loom-'));
  expect(looms).toHaveLength(4);
  for (const a of looms) {
    if (a.kind !== 'pipeRun') throw new Error('Loom must be a cable');
    for (const p of a.params.path) {
      expect(Math.abs(p[0])).toBeLessThan(2);
      expect(Math.abs(p[2])).toBeLessThan(2);
    }
  }
  const clamp = model.assemblies.find((a) => a.id === panel.id + '-bracket-1');
  expect(clamp?.kind).toBe('antennaMount');
  if (clamp?.kind === 'antennaMount') {
    expect(clamp.params.kind).toBe('clamp');
    // The bracket reaches the mechanically tilted back, not a horizontal projection.
    expect(clamp.params.anchor?.[1]).not.toBeCloseTo(panel.centre[1] - 0.32 * panel.size[1], 5);
  }
  expect(
    model.assemblies.filter((a) => a.parent === panel.id && a.category === 'Cabling'),
  ).toHaveLength(4);
  expect(byId(model, panel.id)).toMatchObject({
    params: { centre: panel.centre, size: panel.size },
  });
  expect(
    buildEngineeringGlb(model, { detail: 'detailed', drafts: true, generator: 'test' }).failed,
  ).toEqual([]);
  const without = assemble({
    ...base,
    family: 'telecom-monopole',
    setup: setupFor('telecom-monopole'),
    evidence: { ...monopoleEvidence(), observations: [pipe, panel, deck] },
    user: { ...base.user, removed: [panel.id + '-service-loop'] },
  }).model;
  expect(without.assemblies.some((a) => a.id === panel.id + '-service-loop')).toBe(false);
  expect(without.assemblies.some((a) => a.id === panel.id)).toBe(true);
});

it('prefers measured climbing steps over an approximate AI ladder, preserving every step centre', () => {
  const steps: ComponentObservation = {
    ...observation('obs-steps', 'climbing-steps', 1),
    size: [0.35, 8, 0.025],
    path: [
      [1, 3, 0],
      [1.02, 3.3, 0],
      [1.04, 3.6, 0],
    ],
    azimuthDeg: 90,
  };
  const { model } = run([steps]);
  expect(byKind(model, 'ladder')).toHaveLength(1);
  expect(byId(model, steps.id)).toMatchObject({
    params: { steps: steps.path, style: 'step-bolts' },
  });
  expect(ProcModel.safeParse(model).success).toBe(true);
});

it('preserves steep measured device tilt and bounds the longest safety line', () => {
  const pipe = observation('obs-pipe', 'mounting-pipe', 1);
  const panel = { ...observation('obs-panel', 'panel', 1.5), parent: pipe.id, tiltDeg: 60 };
  const steps: ComponentObservation = {
    ...observation('obs-steps', 'climbing-steps', 0),
    path: Array.from({ length: 256 }, (_, i) => [0.6, 2 + i * 0.29, 0]),
  };
  const { model } = run([pipe, panel, steps]);
  expect(model.assemblies.some((a) => a.id === steps.id + '-safety-line')).toBe(true);
  expect(byId(model, panel.id).params).toMatchObject({ tiltDeg: 60 });
  expect(byId(model, panel.id + '-bracket-1').params).toMatchObject({ tiltDeg: 60 });
  expect(ProcModel.safeParse(model).success).toBe(true);
});

it('builds source-positioned compound parts only when surroundings are requested', () => {
  const roof = {
    ...observation('obs-roof', 'canopy', 3),
    centre: [3, 4, 1] as [number, number, number],
    size: [2, 0.06, 3] as [number, number, number],
    path: [
      [2, 4, -0.5],
      [4, 4.1, -0.5],
      [4, 4.1, 2.5],
      [2, 4, 2.5],
    ] as [number, number, number][],
  };
  const fence = {
    ...observation('obs-fence', 'fence', 0),
    size: [8, 2, 8] as [number, number, number],
    path: [
      [-4, 0, -4],
      [4, 0, -4],
      [4, 0, 4],
      [-4, 0, 4],
      [-4, 0, -4],
    ] as [number, number, number][],
  };
  expect(run([roof, fence]).model.assemblies.some((a) => a.id === roof.id)).toBe(false);
  const { model } = assemble({
    ...base,
    family: 'telecom-monopole',
    scope: 'asset-and-surroundings',
    setup: setupFor('telecom-monopole'),
    evidence: { ...monopoleEvidence(), observations: [roof, fence] },
  });
  expect(byId(model, roof.id)).toMatchObject({
    kind: 'deck',
    params: { elevations: [4, 4.1, 4.1, 4] },
  });
  expect(byId(model, fence.id)).toMatchObject({
    kind: 'guardrail',
    params: { path: fence.path, height: 2 },
  });
  expect(model.assemblies.some((a) => a.id === fence.id + '-surface')).toBe(true);
  const open = assemble({
    ...base,
    family: 'telecom-monopole',
    scope: 'asset-and-surroundings',
    setup: setupFor('telecom-monopole'),
    evidence: {
      ...monopoleEvidence(),
      observations: [{ ...fence, path: fence.path.slice(0, -1) }],
    },
  });
  expect(open.model.assemblies.some((a) => a.id === fence.id + '-surface')).toBe(false);
  expect(
    buildEngineeringGlb(model, { detail: 'detailed', drafts: true, generator: 'test' }).failed,
  ).toEqual([]);
});

it('retains individual device poses, unequal dimensions, IDs and shared mounting pipe', () => {
  const pipe = {
    ...observation('obs-p01', 'mounting-pipe', 1),
    size: [0.1, 6, 0.1] as [number, number, number],
    path: [
      [1, 26, -1.4],
      [1.04, 32, -1.3],
    ] as [number, number, number][],
  };
  const panel = { ...observation('obs-a01', 'panel', 1.5), parent: pipe.id };
  const radio = {
    ...observation('obs-r01', 'rru', 1.8),
    parent: pipe.id,
    size: [0.32, 0.52, 0.15] as [number, number, number],
    azimuthDeg: 81,
  };
  const { model } = run([pipe, panel, radio]);
  expect(ProcModel.safeParse(model).success).toBe(true);
  expect(byKind(model, 'antenna')).toHaveLength(2);
  expect(byId(model, panel.id)).toMatchObject({
    parent: pipe.id,
    sources: panel.sources,
    params: { centre: panel.centre, size: panel.size, azimuthDeg: 73, tiltDeg: 3 },
  });
  expect(byId(model, radio.id)).toMatchObject({
    parent: pipe.id,
    params: { size: radio.size, azimuthDeg: 81 },
  });
  expect(byId(model, pipe.id)).toMatchObject({
    kind: 'pipeRun',
    params: { path: pipe.path, diameter: 0.1 },
  });
  expect(
    run([radio, panel, pipe])
      .model.assemblies.map((a) => a.id)
      .sort(),
  ).toEqual(model.assemblies.map((a) => a.id).sort());
  expect(model.scale?.status).toBe('measured');
  expect(byKind(model, 'monopole')[0]?.params.profile.at(-1)?.y).toBeCloseTo(31.139);
});

it('keeps a measured platform level and offset polygon rather than moving it clear of devices', () => {
  const platform = {
    ...observation('obs-deck', 'platform', 1),
    centre: [0.3, 29, -0.4] as [number, number, number],
    path: [
      [-1, 29, -1],
      [2, 29, -1],
      [2, 29, 1],
      [-1, 29, 1],
    ] as [number, number, number][],
  };
  const { model } = run([observation('obs-a01', 'panel', 1.5), platform]);
  expect(byId(model, platform.id)).toMatchObject({
    kind: 'deck',
    params: {
      y: 29,
      outline: [
        [-1, -1],
        [2, -1],
        [2, 1],
        [-1, 1],
      ],
      grating: true,
    },
  });
  expect(byKind(model, 'deck')).toHaveLength(1);
});
