// @vitest-environment jsdom
import type { ProjectManifest } from '@aio/schema';
import { actionsFor, makeActionCtx, t, type MenuTarget } from '@aio/ui';
import { workspace } from '@aio/workspace';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { call, loadOrientation } = vi.hoisted(() => ({
  call: vi.fn(),
  loadOrientation: vi.fn(() => Promise.resolve()),
}));
vi.mock('../../shell', () => ({ bridge: { call } }));
vi.mock('../../builder/orientationFile', () => ({ loadOrientation }));

const { registerRereadActions, rereadPhotos, rereadSummary, twinCount } =
  await import('./rereadActions');
const { toasts } = await import('../../exports/exports');

const manifest = {
  captures: [],
  layers: [
    { kind: 'photos', id: 'set', name: 'Set', visible: true, items: [] },
    { kind: 'mesh', id: 'mesh', name: 'Mesh', visible: true },
  ],
} as unknown as ProjectManifest;
const after: ProjectManifest = { ...manifest, name: 'after' };

const layers = (...layerIds: string[]): MenuTarget => ({ kind: 'layers', layerIds });
const ctx = (o: { pkg?: boolean; canEdit?: boolean } = {}) =>
  makeActionCtx({ manifest, canEdit: true, ...o });
const item = (target: MenuTarget, c = ctx()) =>
  actionsFor(target, c).find((i) => i.id === 'layers.rereadPhotos');

const done = (o: Record<string, unknown> = {}) => ({
  ok: true,
  value: {
    ok: true,
    manifest: after,
    reread: 3,
    kept: 1,
    twins: 1,
    notFound: 0,
    refined: false,
    ...o,
  },
});

beforeEach(() => {
  registerRereadActions();
  workspace.getState().openProject({ id: 'p1', root: '/p1', manifest });
  call.mockReset();
  loadOrientation.mockClear();
  toasts.setState({ toasts: [] });
});
afterEach(() => {
  workspace.getState().closeProject();
});

const lastToast = () => toasts.getState().toasts.at(-1);

describe('Re-read photo positions', () => {
  it('is offered on one photos dataset only, greyed in a package or for a reviewer', () => {
    expect(item(layers('set'))?.disabled).toBe(false);
    expect(item(layers('mesh'))).toBeUndefined();
    expect(item(layers('set'), ctx({ pkg: true }))?.disabled).toBe(t('actions.reason.package'));
    expect(item(layers('set'), ctx({ canEdit: false }))?.disabled).toBe(
      t('actions.reason.readOnly'),
    );
  });

  it('dry runs, confirms (saying processing refined them), re-reads and reloads', async () => {
    call.mockResolvedValueOnce(done({ refined: true })).mockResolvedValueOnce(done());
    const confirm = vi.fn(() => Promise.resolve(true));
    await rereadPhotos('set', { confirm, pickFolder: () => Promise.resolve(null) });
    expect(call.mock.calls.map((c) => c[1] as unknown)).toEqual([
      { projectId: 'p1', layerId: 'set', dryRun: true },
      { projectId: 'p1', layerId: 'set' },
    ]);
    expect(confirm).toHaveBeenCalledWith(
      `${t('position.reread.confirm')} ${t('position.reread.refined')}`,
    );
    expect(workspace.getState().project?.manifest).toEqual(after);
    expect(loadOrientation).toHaveBeenCalled();
    expect(lastToast()).toMatchObject({
      state: 'done',
      message: rereadSummary({ reread: 3, kept: 1, twins: 1, notFound: 0 }),
    });
  });

  it('asks for the originals folder when the review copies carry no metadata', async () => {
    call
      .mockResolvedValueOnce({ ok: true, value: { ok: false, needsFolder: true, missing: 2 } })
      .mockResolvedValueOnce(done())
      .mockResolvedValueOnce(done({ notFound: 1 }));
    const pickFolder = vi.fn(() => Promise.resolve('D:/orig'));
    await rereadPhotos('set', { confirm: () => Promise.resolve(true), pickFolder });
    expect(pickFolder).toHaveBeenCalledWith(t('position.reread.pickFolder', { count: 2 }));
    expect(call.mock.calls.map((c) => c[1] as unknown)).toEqual([
      { projectId: 'p1', layerId: 'set', dryRun: true },
      { projectId: 'p1', layerId: 'set', folder: 'D:/orig', dryRun: true },
      { projectId: 'p1', layerId: 'set', folder: 'D:/orig' },
    ]);
    expect(lastToast()?.message).toContain(t('position.say.rereadMissing', { count: 1 }));
  });

  it('writes nothing when the person cancels the folder or the confirm', async () => {
    call.mockResolvedValue({ ok: true, value: { ok: false, needsFolder: true, missing: 1 } });
    await rereadPhotos('set', {
      confirm: () => Promise.resolve(true),
      pickFolder: () => Promise.resolve(null),
    });
    expect(call).toHaveBeenCalledTimes(1);
    call.mockReset();
    call.mockResolvedValue(done());
    await rereadPhotos('set', {
      confirm: () => Promise.resolve(false),
      pickFolder: () => Promise.resolve(null),
    });
    expect(call).toHaveBeenCalledTimes(1);
    expect(workspace.getState().project?.manifest).toEqual(manifest);
  });

  it('asks in the window confirm box and goes on when the person agrees', async () => {
    call.mockResolvedValueOnce(done()).mockResolvedValueOnce(done());
    const run = rereadPhotos('set');
    await vi.waitFor(() => {
      expect(document.querySelector('[data-testid="reread-confirm"]')).not.toBeNull();
    });
    expect(document.querySelector('#reread-text')?.textContent).toBe(t('position.reread.confirm'));
    document.querySelector<HTMLButtonElement>('[data-testid="reread-yes"]')?.click();
    await run;
    expect(call).toHaveBeenCalledTimes(2);
    expect(document.querySelector('[data-testid="reread-confirm"]')).toBeNull();
  });

  it('shows a refusal as an error toast', async () => {
    call.mockResolvedValue({ ok: true, value: { ok: false, error: 'No such layer' } });
    await rereadPhotos('set', {
      confirm: () => Promise.resolve(true),
      pickFolder: () => Promise.resolve(null),
    });
    expect(lastToast()).toMatchObject({ state: 'error', message: 'No such layer' });
  });

  it('says how many thermal photos took their twin', () => {
    expect(twinCount({ twins: 2 })).toBe(2);
    expect(rereadSummary({ reread: 2, kept: 0, twins: 2, notFound: 0 })).toBe(
      `${t('position.say.reread', { count: 2 })} ${t('position.say.twins', { count: 2 })}`,
    );
  });
});
