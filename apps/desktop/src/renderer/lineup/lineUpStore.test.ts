import type { CaptureHints } from '@aio/workspace';
import type { CaptureLineUp, LineUpMeasure, ProjectManifest } from '@aio/schema';
import { createWorkspace } from '@aio/workspace';
import { describe, expect, it, vi } from 'vitest';
import { createLineUpMemory } from './lineUpMemory';
import { createLineUpStore } from './lineUpStore';
import { cloud, lineUpManifest, measureOf, ortho } from './testing';

const AT = '2026-10-17T10:00:00.000Z';

function setup(
  opts: {
    manifest?: ProjectManifest;
    measure?: LineUpMeasure | { error: string };
    hints?: CaptureHints;
  } = {},
) {
  const workspace = createWorkspace();
  workspace
    .getState()
    .openProject({ id: 'p', root: 'C:/p', manifest: opts.manifest ?? lineUpManifest() });
  const calls: string[] = [];
  // like the app's saves: the written value goes into the open manifest
  const saveCapture = vi.fn((captureId: string, lineUp: CaptureLineUp | null) => {
    calls.push(
      `save ${captureId} ${lineUp ? `${String(lineUp.eastM)},${String(lineUp.northM)}` : 'null'}`,
    );
    const m = workspace.getState().project?.manifest;
    if (m)
      workspace.getState().replaceManifest({
        ...m,
        captures: m.captures.map((c) => {
          if (c.id !== captureId) return c;
          const rest = { ...c };
          Reflect.deleteProperty(rest, 'lineUp');
          return lineUp ? { ...rest, lineUp } : rest;
        }),
      });
    return Promise.resolve<string | null>(null);
  });
  const pinCaptures = vi.fn((layerIds: readonly string[], captureId: string | null) => {
    calls.push(`pin ${layerIds.join(',')} ${captureId ?? 'null'}`);
    const m = workspace.getState().project?.manifest;
    if (m)
      workspace.getState().replaceManifest({
        ...m,
        layers: m.layers.map((l) => {
          if (!layerIds.includes(l.id)) return l;
          const rest = { ...l };
          Reflect.deleteProperty(rest, 'capture');
          return captureId ? { ...rest, capture: captureId } : rest;
        }),
      });
    return Promise.resolve<string | null>(null);
  });
  const measure = vi.fn(() => Promise.resolve(opts.measure ?? measureOf()));
  const store = createLineUpStore({
    workspace,
    measure,
    saveCapture,
    pinCaptures,
    hints: () => opts.hints ?? {},
    issues: () => [],
    measurements: () => [],
    memory: createLineUpMemory(null),
    now: () => AT,
  });
  const captureOf = (id: string) =>
    workspace.getState().project?.manifest.captures.find((c) => c.id === id);
  return { store, workspace, saveCapture, pinCaptures, measure, calls, captureOf };
}

describe('lineUpStore', () => {
  it('measures, lines up and undoes', async () => {
    const { store, saveCapture, measure, captureOf } = setup();
    await store.getState().open('d1', 'd2');
    expect(measure).toHaveBeenCalledWith('d1', 'd2');
    expect(store.getState().dialog).toMatchObject({ measuring: false, error: null, keep: null });
    store.getState().choose('d1');
    expect(store.getState().dialog?.moves).toEqual({ layers: 2, items: 0 });
    await store.getState().confirm();
    expect(saveCapture).toHaveBeenCalledTimes(1);
    expect(saveCapture).toHaveBeenCalledWith('d2', {
      eastM: -2,
      northM: 0,
      with: 'd1',
      spreadM: 0.02,
      at: AT,
    });
    expect(store.getState().dialog).toBeNull();
    expect(store.getState().notice?.text).toBe(
      'Survey 13 April 2026 lined up with Survey 2 March 2026 (2.00 m).',
    );
    expect(store.getState().notice?.action?.kind).toBe('undo');
    await store.getState().apply();
    expect(saveCapture).toHaveBeenLastCalledWith('d2', null);
    expect(captureOf('d2')?.lineUp).toBeUndefined();
    expect(store.getState().notice?.text).toBe('Line-up undone.');
    expect(store.getState().notice?.action?.kind).toBe('redo');
    await store.getState().apply();
    expect(captureOf('d2')?.lineUp).toMatchObject({ eastM: -2, northM: 0 });
    expect(store.getState().notice?.text).toBe('Lined up again.');
  });

  it('keeps Line up off until a date is chosen', async () => {
    const { store, saveCapture } = setup();
    await store.getState().open('d1', 'd2');
    await store.getState().confirm();
    expect(saveCapture).not.toHaveBeenCalled();
    expect(store.getState().dialog).not.toBeNull();
  });

  it('shows the reason and saves nothing for a refused measurement', async () => {
    const { store, saveCapture } = setup({ measure: measureOf({ verdict: 'texture' }) });
    await store.getState().open('d1', 'd2');
    store.getState().choose('d1');
    expect(store.getState().dialog?.error).toBe(
      'These dates cannot be lined up: there is too little detail to match (water, snow or bare ground, for example).',
    );
    await store.getState().confirm();
    expect(saveCapture).not.toHaveBeenCalled();
  });

  it('says a failed measurement and saves nothing', async () => {
    const { store, saveCapture } = setup({ measure: { error: 'Unknown pipeline.' } });
    await store.getState().open('d1', 'd2');
    store.getState().choose('d2');
    expect(store.getState().dialog).toMatchObject({
      measuring: false,
      measure: null,
      error: 'The measurement did not finish: Unknown pipeline.',
    });
    await store.getState().confirm();
    expect(saveCapture).not.toHaveBeenCalled();
  });

  it('runs the change again after a line-up from the Changes panel', async () => {
    const { store, saveCapture } = setup();
    const then = vi.fn(() => {
      expect(saveCapture).toHaveBeenCalledTimes(1);
    });
    await store.getState().open('d1', 'd2', then);
    store.getState().choose('d1');
    await Promise.all([store.getState().confirm(), store.getState().confirm()]);
    expect(saveCapture).toHaveBeenCalledTimes(1);
    expect(then).toHaveBeenCalledTimes(1);
  });

  it('removes a line-up with undo', async () => {
    const old = { eastM: 1.5, northM: -0.5, with: 'd1', at: AT };
    const { store, captureOf } = setup({ manifest: lineUpManifest({ lineUps: { d2: old } }) });
    await store.getState().remove('d2');
    expect(captureOf('d2')?.lineUp).toBeUndefined();
    expect(store.getState().notice?.text).toBe('Line-up of Survey 13 April 2026 removed.');
    await store.getState().apply();
    expect(captureOf('d2')?.lineUp).toEqual(old);
    await store.getState().remove('d1');
    // nothing to remove: the notice stays as it was
    expect(store.getState().notice?.text).toBe('Line-up undone.');
  });

  it('pins layers only the volume hints date', async () => {
    const manifest = lineUpManifest({
      layers: [ortho('o1', 'd1'), ortho('o2', 'd2'), cloud('vol2')],
    });
    const { store, calls } = setup({ manifest, hints: { layers: { d2: ['vol2'] } } });
    await store.getState().open('d1', 'd2');
    store.getState().choose('d1');
    expect(store.getState().dialog?.moves).toEqual({ layers: 2, items: 0 });
    await store.getState().confirm();
    expect(calls).toEqual(['pin vol2 d2', 'save d2 -2,0']);
    await store.getState().apply();
    expect(calls.slice(2)).toEqual(['save d2 null', 'pin vol2 null']);
    await store.getState().apply();
    expect(calls.slice(4)).toEqual(['pin vol2 d2', 'save d2 -2,0']);
  });

  it('drops the notice and writes nothing when another project opens', async () => {
    const { store, workspace, saveCapture, pinCaptures } = setup();
    await store.getState().open('d1', 'd2');
    store.getState().choose('d1');
    await store.getState().confirm();
    expect(store.getState().notice).not.toBeNull();
    workspace.getState().openProject({ id: 'q', root: 'C:/q', manifest: lineUpManifest() });
    expect(store.getState().notice).toBeNull();
    await store.getState().apply();
    expect(saveCapture).toHaveBeenCalledTimes(1);
    expect(pinCaptures).not.toHaveBeenCalled();
    // a dialog open on the old project goes too
    await store.getState().open('d1', 'd2');
    workspace.getState().openProject({ id: 'p', root: 'C:/p', manifest: lineUpManifest() });
    expect(store.getState().dialog).toBeNull();
  });
});
