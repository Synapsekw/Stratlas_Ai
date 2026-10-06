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
    expect(MODELLING_TOOL_SPECS.map((s) => s.meta.name)).toEqual(NAMES);
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
