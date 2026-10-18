import type { CaptureHints } from '@aio/workspace';
import type { CaptureLineUp, CaptureLineUpTurn, LineUpMeasure, ProjectManifest } from '@aio/schema';
import { createWorkspace } from '@aio/workspace';
import { describe, expect, it, vi } from 'vitest';
import { createLineUpMemory } from './lineUpMemory';
import { createLineUpStore, refusalOf } from './lineUpStore';
import { cloud, fitOf, lineUpManifest, measureOf, ortho } from './testing';

const AT = '2026-10-17T10:00:00.000Z';

function setup(
  opts: {
    manifest?: ProjectManifest;
    measure?: LineUpMeasure | { error: string };
    hints?: CaptureHints;
    /** A save's error, by the count of saves before it. */
    failSave?: (n: number) => string | null;
    /** Runs inside each pin write, before it lands. */
    onPin?: () => void;
  } = {},
) {
  const workspace = createWorkspace();
  workspace
    .getState()
    .openProject({ id: 'p', root: 'C:/p', manifest: opts.manifest ?? lineUpManifest() });
  const calls: string[] = [];
  // like the app's saves: the written value goes into the open manifest
  let saves = 0;
  const saveCapture = vi.fn(
    (captureId: string, lineUp: CaptureLineUp | null, lineUpTurn: CaptureLineUpTurn | null) => {
      const err = opts.failSave?.(saves++) ?? null;
      if (err) {
        calls.push(`save ${captureId} failed`);
        return Promise.resolve<string | null>(err);
      }
      calls.push(
        `save ${captureId} ${lineUp ? `${String(lineUp.eastM)},${String(lineUp.northM)}` : 'null'}${lineUpTurn ? ' turned' : ''}`,
      );
      const m = workspace.getState().project?.manifest;
      if (m)
        workspace.getState().replaceManifest({
          ...m,
          captures: m.captures.map((c) => {
            if (c.id !== captureId) return c;
            const rest = { ...c };
            Reflect.deleteProperty(rest, 'lineUp');
            Reflect.deleteProperty(rest, 'lineUpTurn');
            // as builder:updateCapture: a lineUp without a turn drops the stored one
            return lineUp ? { ...rest, lineUp, ...(lineUpTurn ? { lineUpTurn } : {}) } : rest;
          }),
        });
      return Promise.resolve<string | null>(null);
    },
  );
  const pinCaptures = vi.fn((layerIds: readonly string[], captureId: string | null) => {
    calls.push(`pin ${layerIds.join(',')} ${captureId ?? 'null'}`);
    opts.onPin?.();
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
    expect(saveCapture).toHaveBeenCalledWith(
      'd2',
      { eastM: -2, northM: 0, with: 'd1', spreadM: 0.02, at: AT },
      null,
    );
    expect(store.getState().dialog).toBeNull();
    expect(store.getState().notice?.text).toBe(
      'Survey 13 April 2026 lined up with Survey 2 March 2026 (2.00 m).',
    );
    expect(store.getState().notice?.action?.kind).toBe('undo');
    await store.getState().apply();
    expect(saveCapture).toHaveBeenLastCalledWith('d2', null, null);
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
  it('measures again when a date moved after the measurement', async () => {
    const { store, workspace, saveCapture, measure } = setup();
    store.getState().offerFrom(measureOf(), 'o1|o2');
    // d1 is lined up elsewhere before the offer is taken
    const m = workspace.getState().project?.manifest;
    if (m)
      workspace.getState().replaceManifest({
        ...m,
        captures: m.captures.map((c) =>
          c.id === 'd1' ? { ...c, lineUp: { eastM: 0.5, northM: 0, with: 'd2', at: AT } } : c,
        ),
      });
    await store.getState().acceptOffer();
    store.getState().choose('d1');
    await store.getState().confirm();
    expect(saveCapture).not.toHaveBeenCalled();
    expect(measure).toHaveBeenCalledTimes(1);
    expect(store.getState().dialog).toMatchObject({ keep: 'd1', measuring: false });
    // measured where the dates are now: this one may be saved
    await store.getState().confirm();
    expect(saveCapture).toHaveBeenCalledTimes(1);
  });

  it('writes nothing more when another project opens between the pin and the save', async () => {
    const manifest = lineUpManifest({
      layers: [ortho('o1', 'd1'), ortho('o2', 'd2'), cloud('vol2')],
    });
    const s = setup({
      manifest,
      hints: { layers: { d2: ['vol2'] } },
      onPin: () => {
        s.workspace.getState().openProject({ id: 'q', root: 'C:/q', manifest: lineUpManifest() });
      },
    });
    await s.store.getState().open('d1', 'd2');
    s.store.getState().choose('d1');
    await s.store.getState().confirm();
    expect(s.calls).toEqual(['pin vol2 d2']);
    expect(s.saveCapture).not.toHaveBeenCalled();
    expect(s.store.getState().notice).toBeNull();
  });

  it('takes the pins off again when the save fails', async () => {
    const manifest = lineUpManifest({
      layers: [ortho('o1', 'd1'), ortho('o2', 'd2'), cloud('vol2')],
    });
    const { store, calls } = setup({
      manifest,
      hints: { layers: { d2: ['vol2'] } },
      failSave: () => 'No space left.',
    });
    await store.getState().open('d1', 'd2');
    store.getState().choose('d1');
    await store.getState().confirm();
    expect(calls).toEqual(['pin vol2 d2', 'save d2 failed', 'pin vol2 null']);
    expect(store.getState().dialog?.error).toBe('No space left.');
    expect(store.getState().notice).toBeNull();
  });

  it('takes the pins off again when Redo fails', async () => {
    const manifest = lineUpManifest({
      layers: [ortho('o1', 'd1'), ortho('o2', 'd2'), cloud('vol2')],
    });
    const { store, calls } = setup({
      manifest,
      hints: { layers: { d2: ['vol2'] } },
      failSave: (n) => (n === 2 ? 'No space left.' : null),
    });
    await store.getState().open('d1', 'd2');
    store.getState().choose('d1');
    await store.getState().confirm();
    await store.getState().apply();
    await store.getState().apply();
    expect(calls.slice(4)).toEqual(['pin vol2 d2', 'save d2 failed', 'pin vol2 null']);
    expect(store.getState().notice).toMatchObject({
      text: 'No space left.',
      action: { kind: 'redo' },
    });
  });

  it('refuses a line-up that would move a date more than 500 m', async () => {
    const far = { eastM: 499, northM: 0, with: 'd1', at: AT };
    const { store, saveCapture } = setup({
      manifest: lineUpManifest({ lineUps: { d2: far } }),
      measure: measureOf({ eastM: 2, totalM: 2 }),
    });
    await store.getState().open('d1', 'd2');
    store.getState().choose('d1');
    expect(store.getState().dialog?.error).toBe(
      'These dates cannot be lined up: the date would move more than 500 m, turn more than 2° or scale more than 2% from where its files place it.',
    );
    await store.getState().confirm();
    expect(saveCapture).not.toHaveBeenCalled();
    // keeping the other date moves d1 by 2 m: that one fits
    store.getState().choose('d2');
    expect(store.getState().dialog?.error).toBeNull();
    await store.getState().confirm();
    expect(saveCapture).toHaveBeenCalledWith('d1', expect.objectContaining({ eastM: -2 }), null);
  });

  it('undo restores lineUp and lineUpTurn together', async () => {
    const old = { eastM: 0.5, northM: -0.25, with: 'd1', at: AT };
    const oldTurn = { rotationDeg: 0.4, scale: 0.999, pivotE: 500020, pivotN: 3999990 };
    const { store, saveCapture, captureOf } = setup({
      manifest: lineUpManifest({ lineUps: { d2: old }, turns: { d2: oldTurn } }),
      measure: measureOf({ fit: fitOf() }),
    });
    await store.getState().open('d1', 'd2');
    store.getState().choose('d1');
    await store.getState().confirm();
    expect(saveCapture).toHaveBeenCalledTimes(1);
    const [, saved, savedTurn] = saveCapture.mock.calls[0] ?? [];
    expect(savedTurn?.rotationDeg).toBeCloseTo(0.65, 9);
    expect(captureOf('d2')?.lineUp).toEqual(saved);
    expect(captureOf('d2')?.lineUpTurn).toEqual(savedTurn);
    expect(store.getState().notice?.text).toBe(
      'Survey 13 April 2026 lined up with Survey 2 March 2026 (2.40 m).',
    );
    await store.getState().apply();
    expect(saveCapture).toHaveBeenLastCalledWith('d2', old, oldTurn);
    expect(captureOf('d2')?.lineUp).toEqual(old);
    expect(captureOf('d2')?.lineUpTurn).toEqual(oldTurn);
    await store.getState().apply();
    expect(saveCapture).toHaveBeenLastCalledWith('d2', saved, savedTurn);
    expect(captureOf('d2')?.lineUpTurn).toEqual(savedTurn);
  });

  it('removes a turned line-up whole, and its undo brings the turn back', async () => {
    const old = { eastM: 0.5, northM: -0.25, with: 'd1', at: AT };
    const oldTurn = { rotationDeg: 0.4, scale: 0.999, pivotE: 500020, pivotN: 3999990 };
    const { store, saveCapture, captureOf } = setup({
      manifest: lineUpManifest({ lineUps: { d2: old }, turns: { d2: oldTurn } }),
    });
    await store.getState().remove('d2');
    expect(saveCapture).toHaveBeenLastCalledWith('d2', null, null);
    expect(captureOf('d2')?.lineUpTurn).toBeUndefined();
    await store.getState().apply();
    expect(saveCapture).toHaveBeenLastCalledWith('d2', old, oldTurn);
    expect(captureOf('d2')?.lineUpTurn).toEqual(oldTurn);
  });

  it('range refusal', async () => {
    const turned = measureOf({
      verdict: 'disagree',
      fit: fitOf({ rotationDeg: 3, verdict: 'range' }),
    });
    const range =
      'These dates cannot be lined up: one is turned more than 1° or scaled more than 1% against the other.';
    expect(refusalOf(turned)).toBe(range);
    expect(refusalOf(measureOf({ verdict: 'disagree' }))).toBe(
      "These dates cannot be lined up: their parts don't fit one shift, turn and scale, so part of the site may have warped or changed too much.",
    );
    const { store, saveCapture } = setup({ measure: turned });
    await store.getState().open('d1', 'd2');
    store.getState().choose('d1');
    expect(store.getState().dialog?.error).toBe(range);
    await store.getState().confirm();
    expect(saveCapture).not.toHaveBeenCalled();
  });

  it('tells same-named dates apart in the offer and the done notice', async () => {
    const manifest = lineUpManifest({
      captures: [
        { id: 'd1', label: 'Survey', date: '2024-09-04' },
        { id: 'd2', label: 'Survey', date: '2024-09-10' },
      ],
    });
    const { store } = setup({ manifest });
    store.getState().offerFrom(measureOf(), 'o1|o2');
    expect(store.getState().offer?.text).toMatch(
      /^Survey · 10 Sep 2024 doesn't line up with Survey · 4 Sep 2024\./,
    );
    await store.getState().open('d1', 'd2');
    store.getState().choose('d1');
    await store.getState().confirm();
    expect(store.getState().notice?.text).toBe(
      'Survey · 10 Sep 2024 lined up with Survey · 4 Sep 2024 (2.00 m).',
    );
  });
});
