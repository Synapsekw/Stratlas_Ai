import { runRendererTool, ToolError, type RendererToolContext } from '@aio/ai';
import { createWorkspace } from '@aio/workspace';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { KEEP_LOCAL, registerModellingTools } from './agentTools';
import { setupModeller } from './testing';

/** The tools are registered once (a global registry); each test swaps what they act on. */
let env = setupModeller();
let cloud = true;
let allowed = false;
const sent: string[] = [];

beforeAll(() => {
  registerModellingTools({
    modeller: {
      getState: () => env.modeller.getState(),
      setState: (...a: Parameters<typeof env.modeller.setState>) => {
        env.modeller.setState(...a);
      },
      subscribe: (...a: Parameters<typeof env.modeller.subscribe>) => env.modeller.subscribe(...a),
      getInitialState: () => env.modeller.getInitialState(),
    } as typeof env.modeller,
    cloudRoute: () => Promise.resolve(cloud),
    cloudDrawings: () => allowed,
    dataUrl: (path) => {
      sent.push(path);
      return Promise.resolve('data:image/png;base64,AAAA');
    },
    clouds: () => [{ id: 'scan-1', name: 'Modelling scan' }],
  });
});

beforeEach(() => {
  env = setupModeller();
  cloud = true;
  allowed = false;
  sent.length = 0;
});

const ctx: RendererToolContext = {
  workspace: createWorkspace(),
  window: 'scene3d',
  scene: () => null,
  fetchJson: () => Promise.resolve(null),
  captureFrame: () => Promise.resolve(null),
  now: () => new Date('2026-10-06T10:00:00Z'),
};

const run = (name: string, input: unknown) => runRendererTool(name, input, ctx);

describe('model builder agent tools', () => {
  it('by default send no drawing content to a cloud model (decision 5)', async () => {
    const r = await run('propose_model_parts', { from: 'drawing', tags: ['T-102'] });
    const text = JSON.stringify(r.result);
    expect(text).not.toMatch(/T-102|tank|radius|TANKS|plot\.dxf/i);
    expect(r.result).toMatchObject({
      added: [{ id: 'dxf-1B', kind: 'cylinder', status: 'draft', by: 'drawing' }],
      note: KEEP_LOCAL,
    });
    expect(r.summary).toBe('1 draft part');
    // the draft is in the Model builder all the same
    expect(env.files.get('site-model')?.parts[0]).toMatchObject({ tag: 'T-102', status: 'draft' });
    const listed = JSON.stringify((await run('list_model_parts', {})).result);
    expect(listed).not.toMatch(/T-102|radius/);
    await expect(run('view_plan', {})).rejects.toThrow(KEEP_LOCAL);
    expect(sent).toEqual([]);
  });

  it('share drawings when the project allows cloud AI for drawings', async () => {
    allowed = true;
    const r = await run('propose_model_parts', { from: 'drawing', tags: ['T-102'] });
    expect(r.result).toMatchObject({
      added: [
        {
          id: 'dxf-1B',
          tag: 'T-102',
          class: 'tank',
          size: 'Cylinder, radius 4.0 m, height 10.0 m',
        },
      ],
    });
    expect((await run('view_plan', {})).result).toEqual({
      image: 'data:image/png;base64,AAAA',
      drawing: 'plot.dxf',
    });
    expect(sent).toEqual(['drawings/plot/plan.png']);
  });

  it('share drawings with a local model: nothing leaves the computer', async () => {
    cloud = false;
    const r = await run('propose_model_parts', { from: 'drawing' });
    expect(JSON.stringify(r.result)).toMatch(/T-101/);
    expect((await run('view_plan', { drawing: 'plot' })).result).toMatchObject({
      drawing: 'plot.dxf',
    });
  });

  it('adds parts the agent works out, edits one by tag and builds', async () => {
    await run('propose_model_parts', {
      from: 'agent',
      parts: [{ kind: 'cylinder', tag: 'T-9', base: [0, 0, 0], radius: 3, height: 8 }],
    });
    const edited = await run('edit_model_part', {
      part: 't-9',
      status: 'accepted',
      set: { height: 9.5, name: 'Day tank' },
    });
    expect(edited.result).toMatchObject({
      part: { id: 'agent-1', status: 'accepted', name: 'Day tank', tag: 'T-9' },
    });
    expect(env.files.get('site-model')?.parts[0]).toMatchObject({ height: 9.5 });
    await expect(run('edit_model_part', { part: 'nope', status: 'accepted' })).rejects.toThrow(
      'The model has no part "nope".',
    );
    expect((await run('build_model', {})).result).toEqual({
      layer: 'model-site-model',
      draft: false,
    });
  });

  it('checks inputs and names the point clouds it can fit', async () => {
    await expect(run('propose_model_parts', { from: 'agent' })).rejects.toBeInstanceOf(ToolError);
    await expect(run('fit_primitives', { layer: 'other' })).rejects.toThrow(
      'No point cloud "other". Point clouds: Modelling scan.',
    );
  });
});
