import { ToolMeta } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { MODELLING_TOOL_SPECS, modellingToolInputs } from './modelling-tools';
import { allToolSpecs, approvalFor, getToolSpec, riskOf, toolsForWindow } from './tools';

const NAMES = [
  'list_model_parts',
  'propose_model_parts',
  'fit_primitives',
  'edit_model_part',
  'build_model',
  'view_plan',
];

describe('model builder agent tools', () => {
  it('are in the catalogue with valid metadata', () => {
    expect(MODELLING_TOOL_SPECS.map((s) => s.meta.name).slice(0, NAMES.length)).toEqual(NAMES);
    for (const s of MODELLING_TOOL_SPECS) {
      expect(ToolMeta.safeParse(s.meta).success).toBe(true);
      expect(allToolSpecs()).toContain(s);
      expect(getToolSpec(s.meta.name)).toBe(s);
    }
  });

  it('write through approval; only the plan picture is a send, and listing is a read', () => {
    for (const n of ['propose_model_parts', 'fit_primitives', 'edit_model_part', 'build_model']) {
      expect(riskOf(n), n).toBe('write');
      expect(approvalFor(n), n).toBe(true);
    }
    expect(riskOf('view_plan')).toBe('send');
    expect(approvalFor('view_plan')).toBe(true);
    expect(riskOf('list_model_parts')).toBe('read');
  });

  it('are offered in the 3D view, map and point cloud windows, not in the issue list', () => {
    expect(toolsForWindow('scene3d').map((s) => s.meta.name)).toEqual(
      expect.arrayContaining(NAMES),
    );
    expect(toolsForWindow('issues').map((s) => s.meta.name)).not.toContain('build_model');
  });

  it('check their inputs', () => {
    const i = modellingToolInputs;
    expect(i.propose_model_parts.safeParse({ from: 'drawing', tags: ['T-102'] }).success).toBe(
      true,
    );
    expect(i.propose_model_parts.safeParse({ from: 'agent' }).success).toBe(false);
    const tank = {
      kind: 'cylinder',
      tag: 'T-9',
      base: [0, 0, 0],
      radius: 4,
      height: 10,
    };
    expect(i.propose_model_parts.safeParse({ from: 'agent', parts: [tank] }).success).toBe(true);
    // the agent never sets id, status or origin: the app does
    expect(
      i.propose_model_parts.safeParse({ from: 'agent', parts: [{ ...tank, status: 'accepted' }] })
        .success,
    ).toBe(false);
    expect(i.edit_model_part.safeParse({ part: 'T-101' }).success).toBe(false);
    expect(i.edit_model_part.safeParse({ part: 'T-101', set: { height: 14 } }).success).toBe(true);
    expect(i.edit_model_part.safeParse({ part: 'T-101', set: { height: -1 } }).success).toBe(false);
    expect(i.fit_primitives.safeParse({ layer: 'scan', kinds: ['cylinder'] }).success).toBe(true);
    expect(i.build_model.safeParse({ model: 'not a file/name' }).success).toBe(false);
  });
});

const ENGINEER = [
  'list_components',
  'edit_component',
  'set_count',
  'set_levels',
  'add_component',
  'remove_component',
];

describe('engineering model correction tools', () => {
  it('are in the catalogue after the model builder tools', () => {
    expect(MODELLING_TOOL_SPECS.map((s) => s.meta.name).slice(NAMES.length)).toEqual(ENGINEER);
    for (const n of ENGINEER) expect(ToolMeta.safeParse(getToolSpec(n)?.meta).success).toBe(true);
  });

  it('change the model only through approval; listing is a read', () => {
    for (const n of ENGINEER.slice(1)) {
      expect(riskOf(n), n).toBe('write');
      expect(approvalFor(n), n).toBe(true);
    }
    expect(riskOf('list_components')).toBe('read');
  });

  it('check their inputs, bounded', () => {
    const i = modellingToolInputs;
    expect(i.set_count.safeParse({ role: 'flue', count: 4 }).success).toBe(true);
    expect(i.set_count.safeParse({ role: 'flue', count: 65 }).success).toBe(false);
    expect(i.set_count.safeParse({ role: 'flue', count: 2.5 }).success).toBe(false);
    expect(i.set_count.safeParse({ role: 'Flue Pipes', count: 2 }).success).toBe(false);
    expect(i.set_levels.safeParse({ role: 'light-l1', levels: [45] }).success).toBe(true);
    expect(i.set_levels.safeParse({ role: 'light', levels: [-1] }).success).toBe(false);
    expect(
      i.set_levels.safeParse({ role: 'light', levels: Array.from({ length: 17 }, (_, k) => k) })
        .success,
    ).toBe(false);
    expect(i.edit_component.safeParse({ component: 'flue-2' }).success).toBe(false);
    expect(i.edit_component.safeParse({ component: 'flue-2', set: { rOuter: 0.6 } }).success).toBe(
      true,
    );
    expect(i.edit_component.safeParse({ component: 'flue', status: 'accepted' }).success).toBe(
      true,
    );
    // scalars only: no geometry through an edit
    expect(
      i.edit_component.safeParse({ component: 'flue-2', set: { centre: [0, 0, 0] } }).success,
    ).toBe(false);
    expect(
      i.edit_component.safeParse({ component: 'flue-2', set: { rOuter: Number.POSITIVE_INFINITY } })
        .success,
    ).toBe(false);
    expect(i.remove_component.safeParse({ component: 'ladder-1' }).success).toBe(true);
    expect(i.remove_component.safeParse({ component: 'ladder-1', confirm: true }).success).toBe(
      true,
    );
    expect(
      i.add_component.safeParse({
        kind: 'cabinet',
        role: 'cabinet',
        params: { base: [5, 0, 0], size: [1, 2, 1], yawDeg: 0 },
      }).success,
    ).toBe(true);
    expect(i.add_component.safeParse({ kind: 'windmill', role: 'mill', params: {} }).success).toBe(
      false,
    );
  });
});
