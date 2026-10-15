import type { ProjectManifest } from '@aio/schema';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  actionsFor,
  defineAction,
  everyLayer,
  makeActionCtx,
  registerActions,
  targetCount,
  type Action,
} from '.';

const manifest = {
  captures: [{ id: 'c1', label: 'c1', date: '2026-01-01' }],
  layers: [
    { kind: 'mesh', id: 'm', name: 'Model', visible: true, src: { path: 'm.glb' }, transform: [] },
    { kind: 'photos', id: 'p', name: 'Photos', visible: true, items: [] },
    { kind: 'photos', id: 'q', name: 'More photos', visible: true, items: [] },
  ],
} as unknown as ProjectManifest;
const ctx = makeActionCtx({ manifest });

let off: (() => void)[] = [];
const reg = (...a: Action[]) => {
  off.push(registerActions(a));
};
afterEach(() => {
  for (const f of off) f();
  off = [];
});

const act = (id: string, over: Partial<Action> = {}): Action => ({
  id,
  label: () => id,
  section: 'view',
  targets: ['layers'],
  run: () => undefined,
  ...over,
});

describe('actionsFor', () => {
  it('offers an action only on the target kinds it names', () => {
    reg(
      act('a'),
      defineAction({
        id: 'b',
        label: () => 'b',
        section: 'view',
        targets: ['project'],
        run: () => undefined,
      }),
    );
    expect(actionsFor({ kind: 'layers', layerIds: ['m'] }, ctx).map((i) => i.id)).toEqual(['a']);
    expect(actionsFor({ kind: 'project' }, ctx).map((i) => i.id)).toEqual(['b']);
  });

  it('offers only multi actions when the target holds several items', () => {
    reg(act('one'), act('many', { multi: true }));
    expect(actionsFor({ kind: 'layers', layerIds: ['m', 'p'] }, ctx).map((i) => i.id)).toEqual([
      'many',
    ]);
    expect(actionsFor({ kind: 'layers', layerIds: ['m'] }, ctx).map((i) => i.id)).toEqual([
      'one',
      'many',
    ]);
    expect(
      targetCount({
        kind: 'photos',
        picks: [
          { layerId: 'p', photoId: 'a' },
          { layerId: 'p', photoId: 'a' },
        ],
      }),
    ).toBe(1);
  });

  it('shows an action on mixed kinds only when it applies to every layer', () => {
    reg(
      act('photosOnly', {
        multi: true,
        appliesTo: (t, c) => everyLayer(t, c, (l) => l.kind === 'photos'),
      }),
    );
    expect(actionsFor({ kind: 'layers', layerIds: ['p', 'q'] }, ctx)).toHaveLength(1);
    expect(actionsFor({ kind: 'layers', layerIds: ['p', 'm'] }, ctx)).toHaveLength(0);
  });

  it('greys a disabled action with its reason and does not run it', () => {
    const run = vi.fn();
    reg(act('d', { disabled: () => 'Not here.', run }));
    const [item] = actionsFor({ kind: 'layers', layerIds: ['m'] }, ctx);
    expect(item?.disabled).toBe('Not here.');
    item?.run();
    expect(run).not.toHaveBeenCalled();
  });

  it('sorts by section, then by registration order', () => {
    reg(
      act('del', { section: 'danger' }),
      act('z', { section: 'view' }),
      act('o', { section: 'open' }),
      act('y', { section: 'view' }),
    );
    expect(actionsFor({ kind: 'layers', layerIds: ['m'] }, ctx).map((i) => i.id)).toEqual([
      'o',
      'z',
      'y',
      'del',
    ]);
  });

  it('replaces an action registered again under the same id, and unregisters', () => {
    reg(act('x', { label: () => 'first' }));
    const undo = registerActions([act('x', { label: () => 'second' })]);
    expect(actionsFor({ kind: 'layers', layerIds: ['m'] }, ctx).map((i) => i.label)).toEqual([
      'second',
    ]);
    undo();
    expect(actionsFor({ kind: 'layers', layerIds: ['m'] }, ctx)).toEqual([]);
  });

  it('runs with the target, the context and the picked sub item; a failed run notes', async () => {
    const note = vi.fn();
    const c = makeActionCtx({ manifest, host: { ...ctx.host, note } });
    const run = vi.fn((_t: unknown, _c: unknown, sub?: string) => {
      if (sub === 'bad') return Promise.reject(new Error('Broken.'));
      return undefined;
    });
    reg(
      act('s', {
        run,
        submenu: () => [
          { id: 'ok', label: 'OK' },
          { id: 'bad', label: 'Bad' },
        ],
      }),
    );
    const [item] = actionsFor({ kind: 'layers', layerIds: ['m'] }, c);
    expect(item?.present).toBe('submenu');
    item?.run('ok');
    expect(run).toHaveBeenCalledWith({ kind: 'layers', layerIds: ['m'] }, c, 'ok');
    item?.run('bad');
    await vi.waitFor(() => {
      expect(note).toHaveBeenCalledWith('Broken.', true);
    });
  });

  it('gives the default test id, or the kept one', () => {
    reg(act('k'), act('legacy', { testId: 'menu-delete' }));
    const [k, legacy] = actionsFor({ kind: 'layers', layerIds: ['m'] }, ctx);
    expect(k?.testId).toBe('ctx-item-k');
    expect(k?.shortcut).toBeNull();
    expect(legacy?.testId).toBe('menu-delete');
  });

  it('runs at once (a pick saves before the menu redraws)', () => {
    const run = vi.fn();
    reg(act('now', { run }));
    actionsFor({ kind: 'layers', layerIds: ['m'] }, ctx)[0]?.run();
    expect(run).toHaveBeenCalledTimes(1);
  });
});
