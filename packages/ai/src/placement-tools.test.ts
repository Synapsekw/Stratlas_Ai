import { describe, expect, it, vi } from 'vitest';
import { runRendererTool, ToolError, type RendererToolContext } from './renderer-tools';
import { fixtureWorkspace } from './test-fixtures';
import { approvalFor, getToolSpec, riskOf } from './tools';
import type { AddSightingRequest, AppHooks, PlaceOnModelRequest } from './tool-kit';

function ctx(app: AppHooks = {}): RendererToolContext {
  return {
    workspace: fixtureWorkspace(),
    window: 'scene3d',
    scene: () => null,
    fetchJson: () => Promise.resolve(null),
    captureFrame: () => Promise.resolve(null),
    now: () => new Date('2026-10-15T12:00:00Z'),
    app,
  };
}

describe('placement tools', () => {
  it('are write tools that ask for approval', () => {
    for (const n of ['place_on_model', 'add_sighting']) {
      expect(getToolSpec(n), n).toBeDefined();
      expect(riskOf(n), n).toBe('write');
      expect(approvalFor(n), n).toBe(true);
    }
  });

  it('place_on_model hands the ids and layer to the app and reports each outcome', async () => {
    const undo = vi.fn();
    const placeOnModel = vi.fn((req: PlaceOnModelRequest) =>
      Promise.resolve({
        layer: { id: 'm1', name: 'Plant mesh' },
        outcomes: req.ids.map((id, k) =>
          k === 0
            ? { id, code: 'AG01', placed: [{ on: 'mesh' as const, type: 'spolygon' }] }
            : { id, code: 'AG02', reason: 'missed' },
        ),
        undo,
      }),
    );
    const r = await runRendererTool(
      'place_on_model',
      { ids: ['AG01', 'review.json#d2'], layer: 'Plant mesh' },
      ctx({ placeOnModel }),
    );
    expect(placeOnModel).toHaveBeenCalledWith({
      ids: ['AG01', 'review.json#d2'],
      layer: 'Plant mesh',
    });
    expect(r.summary).toBe('1 of 2 findings placed on Plant mesh');
    expect(r.result).toMatchObject({ outcomes: [{ code: 'AG01' }, { reason: 'missed' }] });
    r.undo?.();
    expect(undo).toHaveBeenCalledTimes(1);
  });

  it('add_sighting resolves a place to a point, or passes a photo box', async () => {
    const calls: AddSightingRequest[] = [];
    const addSighting = vi.fn((req: AddSightingRequest) => {
      calls.push(req);
      return Promise.resolve({
        code: 'F01',
        placed: [{ on: 'pointcloud' as const, type: 'point3' }],
      });
    });
    const c = ctx({ addSighting });
    await runRendererTool(
      'add_sighting',
      { issue: 'F01', layer: 'pc1', at: { kind: 'point', p: [1, 2, 3] } },
      c,
    );
    await runRendererTool(
      'add_sighting',
      { issue: 'F01', layer: 'm1', at: { photo: 'P7', box: [10, 20, 30, 40] } },
      c,
    );
    expect(calls).toEqual([
      { issue: 'F01', layer: 'pc1', at: { kind: 'point', p: [1, 2, 3] } },
      { issue: 'F01', layer: 'm1', at: { kind: 'photo', photo: 'P7', box: [10, 20, 30, 40] } },
    ]);
  });

  it('say they need the desktop app when the hooks are missing', async () => {
    await expect(
      runRendererTool('place_on_model', { ids: ['F01'], layer: 'm1' }, ctx()),
    ).rejects.toBeInstanceOf(ToolError);
    await expect(
      runRendererTool(
        'add_sighting',
        { issue: 'F01', layer: 'm1', at: { kind: 'point', p: [0, 0, 0] } },
        ctx(),
      ),
    ).rejects.toThrow('only in the desktop app');
  });

  it('refuse a box with no area', async () => {
    await expect(
      runRendererTool(
        'add_sighting',
        { issue: 'F01', layer: 'm1', at: { photo: 'P7', box: [0, 0, 0, 5] } },
        ctx(),
      ),
    ).rejects.toThrow('Invalid input');
  });

  it('add_sighting says why nothing was placed when the app gives a reason', async () => {
    const addSighting = vi.fn(() =>
      Promise.resolve({ code: 'F01', placed: [], reason: 'the box missed the model' }),
    );
    const r = await runRendererTool(
      'add_sighting',
      { issue: 'F01', layer: 'm1', at: { photo: 'P7', box: [10, 20, 30, 40] } },
      ctx({ addSighting }),
    );
    expect(r.summary).toBe('F01: 0 places added (the box missed the model)');
    expect(r.result).toMatchObject({ code: 'F01', placed: [], reason: 'the box missed the model' });
  });
});
