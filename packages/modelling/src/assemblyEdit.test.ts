import { Assembly, AssemblyKind } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import {
  addAssembly,
  applyAssemblyField,
  assemblyFields,
  kindLabel,
  newAssembly,
  nextAssemblyId,
  removeAssembly,
  removeAssemblyOverrides,
  roleOfKind,
} from './assemblyEdit';
import { assemble } from './engineer/assemble/assemble';
import { base, byId, must, assembleStack, withStatus } from './engineer/assemble/testAssemble';
import { setupFor, stackEvidence, stackProposal } from './engineer/fixtures';
import { setAssemblyStatus } from './procmodel';

const NOW = '2026-10-16T00:00:00.000Z';

describe('assemblyFields', () => {
  it('shows supported controls for fitted roofs, step routes and clamp assemblies', () => {
    const model = assembleStack().model;
    const roof = newAssembly(model, 'deck');
    if (roof.kind !== 'deck') throw new Error('deck');
    roof.params.outline = [
      [0, 0],
      [2, 0],
      [2, 2],
      [0, 2],
    ];
    roof.params.elevations = [4, 4.2, 4.2, 4];
    expect(assemblyFields(roof).find((f) => f.key === 'y')).toMatchObject({
      readOnly: true,
      label: 'Height · project Y',
    });
    const steps = newAssembly(model, 'ladder');
    if (steps.kind !== 'ladder') throw new Error('ladder');
    steps.params.style = 'step-bolts';
    expect(assemblyFields(steps).some((f) => f.key === 'rungSpacing' || f.key === 'cage')).toBe(
      false,
    );
    const clamp = newAssembly(model, 'antennaMount');
    if (clamp.kind !== 'antennaMount') throw new Error('mount');
    clamp.params.kind = 'clamp';
    expect(assemblyFields(clamp).find((f) => f.key === 'kind')).toMatchObject({
      readOnly: true,
      options: [{ value: 'clamp', label: 'Clamp assembly' }],
    });
  });
  it('lists the editable values with their units and the basis each is known on', () => {
    const { model } = assembleStack();
    const flue = assemblyFields(byId(model, 'flue-1'));
    const outer = must(flue.find((f) => f.key === 'rOuter'));
    expect(outer).toMatchObject({ label: 'Outer radius', unit: 'm', value: 0.9 });
    expect(['inferred', 'observed', 'measured', 'user']).toContain(outer.basis);
    // vectors and paths are measured, not typed in
    expect(flue.some((f) => f.key === 'centre')).toBe(false);
    const shaft = assemblyFields(byId(model, 'shaft-1'));
    expect(shaft.find((f) => f.key === 'openTop')).toMatchObject({ value: true });
  });

  it('offers named choices where the schema has them, and degrees for directions', () => {
    const { model } = assemble({
      ...base,
      evidence: null,
      proposal: null,
      family: 'telecom-lattice',
      setup: setupFor('telecom-lattice'),
    });
    expect(model).toBeDefined();
    const a = newAssembly(model, 'antenna');
    const f = assemblyFields(a);
    expect(must(f.find((x) => x.key === 'kind')).options?.map((o) => o.value)).toEqual([
      'panel',
      'dish',
      'rru',
      'omni',
    ]);
    expect(must(f.find((x) => x.key === 'azimuthDeg'))).toMatchObject({
      unit: 'deg',
      min: 0,
      max: 360,
    });
    expect(f.every((x) => x.basis === 'user')).toBe(true);
  });
});

describe('applyAssemblyField', () => {
  it('returns overrides with the key as user, and a rebuild keeps ids and accepted components', () => {
    const first = assembleStack().model;
    const accepted = setAssemblyStatus(first, ['flue-1', 'shaft-1'], 'accepted', NOW);
    const overrides = applyAssemblyField(accepted, 'flue-2', 'rOuter', 1.1);
    expect(overrides.params['flue-2']).toEqual({ rOuter: 1.1 });
    const again = assemble({
      ...base,
      evidence: stackEvidence(),
      proposal: stackProposal(),
      previous: accepted,
      user: overrides,
    });
    expect(again.model.assemblies.map((a) => a.id).sort()).toEqual(
      first.assemblies.map((a) => a.id).sort(),
    );
    const flue2 = byId(again.model, 'flue-2');
    expect(flue2.kind === 'flue' && flue2.params.rOuter).toBe(1.1);
    expect(flue2.quality.rOuter?.basis).toBe('user');
    expect(byId(again.model, 'flue-1').status).toBe('accepted');
    expect(byId(again.model, 'shaft-1').status).toBe('accepted');
    // the earlier edit survives a second one
    const second = applyAssemblyField(again.model, 'flue-3', 'height', 7);
    expect(second.params['flue-2']).toEqual({ rOuter: 1.1 });
    expect(second.params['flue-3']).toEqual({ height: 7 });
  });

  it('carries components made by hand so a rebuild does not drop them, and removal asks for it', () => {
    const m0 = assembleStack().model;
    const added = newAssembly(m0, 'hatch');
    const m1 = addAssembly(m0, added, NOW);
    const o = applyAssemblyField(m1, 'flue-1', 'height', 5);
    expect(o.added.map((a) => a.id)).toEqual([added.id]);
    const r = removeAssemblyOverrides(m1, 'flue-3');
    expect(r.removed).toEqual(['flue-3']);
    expect(r.params['flue-3']).toBeUndefined();
  });
});

describe('adding and removing', () => {
  it('makes a valid draft of every kind with the next free id for its role', () => {
    const m = assembleStack().model;
    for (const kind of AssemblyKind.options) {
      const a = newAssembly(m, kind);
      expect(
        Assembly.safeParse(a).success,
        `${kind}: ${JSON.stringify(Assembly.safeParse(a).error?.issues)}`,
      ).toBe(true);
      expect(a.status).toBe('draft');
      expect(a.origin).toEqual({ by: 'manual' });
      expect(a.id.startsWith(roleOfKind(kind))).toBe(true);
      expect(Object.values(a.quality).every((q) => q.basis === 'user')).toBe(true);
      expect(kindLabel(kind).length).toBeGreaterThan(2);
    }
    expect(nextAssemblyId(m, 'flue')).toBe('flue-4');
    expect(nextAssemblyId(m, 'ringPlatform')).toBe('platform-1');
    expect(nextAssemblyId(m, 'warningLight')).toMatch(/^light-\d+$/);
    const withFlue = addAssembly(m, newAssembly(m, 'flue'), NOW);
    expect(nextAssemblyId(withFlue, 'flue')).toBe('flue-5');
    expect(newAssembly(m, 'flue').id).toBe('flue-4');
  });

  it('removes one component and stamps the model', () => {
    const m = assembleStack().model;
    const r = removeAssembly(m, 'flue-1', NOW);
    expect(r.assemblies.some((a) => a.id === 'flue-1')).toBe(false);
    expect(r.assemblies).toHaveLength(m.assemblies.length - 1);
    expect(r.updatedAt).toBe(NOW);
  });
});

describe('re-accepting', () => {
  it('keeps the reviewed record when a component is accepted again', () => {
    const m = assembleStack().model;
    const flagged = {
      ...m,
      assemblies: m.assemblies.map((a) =>
        a.id === 'flue-1'
          ? { ...a, status: 'rejected' as const, reviewed: { hash: 'abcdef12', runId: 'run-a' } }
          : a,
      ),
    };
    const back = setAssemblyStatus(
      withStatus(flagged, 'flue-1', 'rejected'),
      ['flue-1'],
      'accepted',
      NOW,
    );
    expect(byId(back, 'flue-1').reviewed).toEqual({ hash: 'abcdef12', runId: 'run-a' });
    expect(byId(back, 'flue-1').status).toBe('accepted');
  });
});
