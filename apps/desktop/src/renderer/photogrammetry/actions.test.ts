import { beforeEach, describe, expect, it, vi } from 'vitest';

const call = vi.fn();
const replaceManifest = vi.fn();
interface OpenProject {
  id: string;
  root: string;
  manifest: { layers: { id: string; capture?: string }[] };
}
const open: { project: OpenProject | null } = {
  project: { id: 'p1', root: 'D:\\Projects\\site', manifest: { layers: [] } },
};
const otherProject: OpenProject = {
  id: 'p2',
  root: 'D:\\Projects\\other',
  manifest: { layers: [] },
};

vi.mock('../shell', () => ({
  bridge: { call: (...a: unknown[]) => call(...a) as unknown },
  jobs: { getState: () => ({ refresh: () => Promise.resolve() }) },
}));
vi.mock('@aio/workspace', () => ({
  workspace: { getState: () => ({ project: open.project, replaceManifest }) },
}));

import { fileUnderDate, startProducts } from './actions';
import { photoUi, type PendingProducts } from './store';

const base = { root: 'D:/Projects/site/', preset: 'standard', products: ['ortho'] } as const;
const started = { ok: true, value: { ok: true } };
const paramsOfStart = () =>
  (call.mock.calls.find((c) => c[0] === 'jobs:start')?.[1] as { params: Record<string, unknown> })
    .params;

beforeEach(() => {
  call.mockReset();
  replaceManifest.mockReset();
  open.project = { id: 'p1', root: 'D:\\Projects\\site', manifest: { layers: [] } };
});

describe('startProducts and the survey date', () => {
  it('adds the date of a new day first, then starts the maps under its id', async () => {
    call.mockImplementation((channel: string) =>
      Promise.resolve(
        channel === 'builder:ensureCapture'
          ? {
              ok: true,
              value: { ok: true, manifest: { captures: [] }, captureId: 'capture-2026-04-02' },
            }
          : started,
      ),
    );
    photoUi.getState().setDate('r1', { captureDate: '2026-04-02' });
    const err = await startProducts('r1', {
      ...base,
      products: ['ortho'],
      captureDate: '2026-04-02',
    });
    expect(err).toBeNull();
    expect(call.mock.calls.map((c) => c[0] as string)).toEqual([
      'builder:ensureCapture',
      'jobs:start',
    ]);
    expect(call).toHaveBeenNthCalledWith(1, 'builder:ensureCapture', {
      projectId: 'p1',
      date: '2026-04-02',
    });
    expect(paramsOfStart()).toMatchObject({ run: 'r1', capture: 'capture-2026-04-02' });
    expect(paramsOfStart()).not.toHaveProperty('captureDate');
    expect(replaceManifest).toHaveBeenCalledTimes(1);
    expect(photoUi.getState().dates.r1).toBeUndefined();
  });

  it('a date that exists is used as it is', async () => {
    call.mockResolvedValue(started);
    await startProducts('r2', { ...base, products: ['ortho'], capture: 'c2' });
    expect(call.mock.calls.map((c) => c[0] as string)).toEqual(['jobs:start']);
    expect(paramsOfStart()).toMatchObject({ capture: 'c2' });
  });

  it('builds the maps without a date when the date cannot be added', async () => {
    call.mockImplementation((channel: string) =>
      Promise.resolve(
        channel === 'builder:ensureCapture'
          ? { ok: true, value: { ok: false, error: 'no' } }
          : started,
      ),
    );
    const err = await startProducts('r3', {
      ...base,
      products: ['ortho'],
      captureDate: '2026-04-02',
    });
    expect(err).toBeNull();
    expect(call.mock.calls.map((c) => c[0] as string)).toEqual([
      'builder:ensureCapture',
      'jobs:start',
    ]);
    expect(paramsOfStart()).not.toHaveProperty('capture');
  });

  it('builds the maps without a date when adding the date throws', async () => {
    call.mockImplementation((channel: string) =>
      channel === 'builder:ensureCapture'
        ? Promise.reject(new Error('gone'))
        : Promise.resolve(started),
    );
    const err = await startProducts('r5', {
      ...base,
      products: ['ortho'],
      captureDate: '2026-04-02',
    });
    expect(err).toBeNull();
    expect(call).toHaveBeenCalledWith('jobs:start', expect.anything());
    expect(paramsOfStart()).not.toHaveProperty('capture');
  });

  it('adds no date to another project that happens to be open', async () => {
    open.project = otherProject;
    call.mockResolvedValue(started);
    await startProducts('r4', { ...base, products: ['ortho'], captureDate: '2026-04-02' });
    expect(call.mock.calls.map((c) => c[0] as string)).toEqual(['jobs:start']);
    expect(paramsOfStart()).not.toHaveProperty('capture');
  });
});

describe('startProducts says when the survey date could not be saved', () => {
  const dated: PendingProducts = { ...base, products: ['ortho'], captureDate: '2026-04-02' };
  const ensure = (reply: () => Promise<unknown>) => {
    call.mockImplementation((channel: string) =>
      channel === 'builder:ensureCapture' ? reply() : Promise.resolve(started),
    );
  };
  const warned = (run: string) => photoUi.getState().dateWarnings[run];
  // the warning keeps the day that failed and the folder of the project it was meant for
  const warning = { date: '2026-04-02', root: 'D:/Projects/site/' };

  it('starts the maps without a date and warns the run when the save is refused', async () => {
    ensure(() => Promise.resolve({ ok: true, value: { ok: false, error: 'no' } }));
    expect(await startProducts('d1', dated)).toBeNull();
    expect(paramsOfStart()).not.toHaveProperty('capture');
    expect(warned('d1')).toEqual(warning);
  });

  it('warns the run when the reply is not ok at all', async () => {
    ensure(() => Promise.resolve({ ok: false, error: 'busy' }));
    expect(await startProducts('d2', dated)).toBeNull();
    expect(paramsOfStart()).not.toHaveProperty('capture');
    expect(warned('d2')).toEqual(warning);
  });

  it('starts the maps without a date and warns the run when the save throws', async () => {
    ensure(() => Promise.reject(new Error('gone')));
    expect(await startProducts('d3', dated)).toBeNull();
    expect(paramsOfStart()).not.toHaveProperty('capture');
    expect(warned('d3')).toEqual(warning);
  });

  it('warns the run when the open project is no longer the run project', async () => {
    open.project = otherProject;
    call.mockResolvedValue(started);
    expect(await startProducts('d4', dated)).toBeNull();
    expect(paramsOfStart()).not.toHaveProperty('capture');
    expect(warned('d4')).toEqual(warning);
  });

  it('starts the maps under the date and does not warn when the save works', async () => {
    ensure(() =>
      Promise.resolve({
        ok: true,
        value: { ok: true, manifest: { captures: [] }, captureId: 'capture-2026-04-02' },
      }),
    );
    expect(await startProducts('d5', dated)).toBeNull();
    expect(paramsOfStart()).toMatchObject({ capture: 'capture-2026-04-02' });
    expect(warned('d5')).toBeUndefined();
  });

  it('does not warn when a date that exists is used or none was wanted', async () => {
    call.mockResolvedValue(started);
    await startProducts('d6', { ...base, products: ['ortho'], capture: 'c2' });
    expect(warned('d6')).toBeUndefined();
    await startProducts('d7', { ...base, products: ['ortho'] });
    expect(call.mock.calls.map((c) => c[0] as string)).toEqual(['jobs:start', 'jobs:start']);
    expect(warned('d7')).toBeUndefined();
  });

  it('a start that works with a date clears the warning of an earlier try', async () => {
    ensure(() => Promise.resolve({ ok: true, value: { ok: false, error: 'no' } }));
    await startProducts('d8', dated);
    expect(warned('d8')).toEqual(warning);
    call.mockReset();
    call.mockResolvedValue(started);
    await startProducts('d8', { ...base, products: ['ortho'], capture: 'c2' });
    expect(warned('d8')).toBeUndefined();
  });

  it('a start with no date wanted clears the warning of an earlier try', async () => {
    photoUi.getState().setDateWarning('d9', warning);
    call.mockResolvedValue(started);
    await startProducts('d9', { ...base, products: ['ortho'] });
    expect(warned('d9')).toBeUndefined();
  });

  it('a refused start leaves the warning as it was', async () => {
    const refused = { ok: true, value: { ok: false, error: 'No pipeline pack is installed.' } };
    photoUi.getState().setDateWarning('d10', warning);
    call.mockResolvedValue(refused);
    expect(await startProducts('d10', { ...base, products: ['ortho'], capture: 'c2' })).toBe(
      'No pipeline pack is installed.',
    );
    expect(warned('d10')).toEqual(warning);
    photoUi.getState().setDateWarning('d11', null);
    call.mockImplementation((channel: string) =>
      Promise.resolve(
        channel === 'builder:ensureCapture'
          ? { ok: true, value: { ok: false, error: 'no' } }
          : refused,
      ),
    );
    await startProducts('d11', dated);
    expect(warned('d11')).toBeUndefined();
  });
});

describe('startProducts when the start is refused', () => {
  const refused = { ok: true, value: { ok: false, error: 'No pipeline pack is installed.' } };
  const queued = { ...base, products: ['ortho'], capture: 'c2' } as const;

  it('drops the queued maps and keeps the reason and the survey date for the run', async () => {
    call.mockResolvedValue(refused);
    const ui = photoUi.getState();
    ui.setDate('q1', { capture: 'c2' });
    ui.setPending('q1', { ...queued, products: ['ortho'] });
    const err = await startProducts('q1', { ...queued, products: ['ortho'] });
    expect(err).toBe('No pipeline pack is installed.');
    const after = photoUi.getState();
    // nothing starts by itself any more: the run panel offers Create maps again
    expect(after.pending.q1).toBeUndefined();
    expect(after.startErrors.q1).toBe('No pipeline pack is installed.');
    // the next try still files the maps under the photos' survey date
    expect(after.dates.q1).toEqual({ capture: 'c2' });
  });

  it('keeps the reason when main cannot be reached at all', async () => {
    call.mockResolvedValue({ ok: false, error: 'The app is busy. Try again.' });
    photoUi.getState().setPending('q2', { ...queued, products: ['ortho'] });
    expect(await startProducts('q2', { ...queued, products: ['ortho'] })).toBe(
      'The app is busy. Try again.',
    );
    expect(photoUi.getState().pending.q2).toBeUndefined();
    expect(photoUi.getState().startErrors.q2).toBe('The app is busy. Try again.');
  });

  it('answers a reason instead of throwing when the call itself fails', async () => {
    call.mockRejectedValue(new Error('channel closed'));
    photoUi.getState().setPending('q3', { ...queued, products: ['ortho'] });
    expect(await startProducts('q3', { ...queued, products: ['ortho'] })).toBe('channel closed');
    expect(photoUi.getState().pending.q3).toBeUndefined();
    expect(photoUi.getState().startErrors.q3).toBe('channel closed');
  });

  it('a queue without outputs is dropped with its reason too', async () => {
    photoUi.getState().setPending('q4', { ...base, products: [] });
    expect(await startProducts('q4', { ...base, products: [] })).toBe(
      'Choose at least one product.',
    );
    expect(call).not.toHaveBeenCalled();
    expect(photoUi.getState().pending.q4).toBeUndefined();
    expect(photoUi.getState().startErrors.q4).toBe('Choose at least one product.');
  });

  it('the reason goes when the maps do start', async () => {
    call.mockResolvedValueOnce(refused).mockResolvedValue(started);
    photoUi.getState().setDate('q5', { capture: 'c2' });
    await startProducts('q5', { ...queued, products: ['ortho'] });
    expect(photoUi.getState().startErrors.q5).toBeDefined();
    expect(await startProducts('q5', { ...queued, products: ['ortho'] })).toBeNull();
    expect(photoUi.getState().startErrors.q5).toBeUndefined();
    expect(paramsOfStart()).toMatchObject({ run: 'q5', capture: 'c2' });
    expect(photoUi.getState().dates.q5).toBeUndefined();
  });
});

describe('a warned start keeps the run date for the next try', () => {
  const dated: PendingProducts = { ...base, products: ['ortho'], captureDate: '2026-04-02' };
  const refusedSave = { ok: true, value: { ok: false, error: 'no' } };
  const goodSave = {
    ok: true,
    value: { ok: true, manifest: { captures: [] }, captureId: 'capture-2026-04-02', created: true },
  };
  const channelsOf = () => call.mock.calls.map((c) => c[0] as string);

  it('keeps the date of the run and the day in the warning when the save is refused', async () => {
    call.mockImplementation((channel: string) =>
      Promise.resolve(channel === 'builder:ensureCapture' ? refusedSave : started),
    );
    photoUi.getState().setDate('k1', { captureDate: '2026-04-02' });
    expect(await startProducts('k1', dated)).toBeNull();
    expect(photoUi.getState().dates.k1).toEqual({ captureDate: '2026-04-02' });
    expect(photoUi.getState().dateWarnings.k1).toEqual({
      date: '2026-04-02',
      root: 'D:/Projects/site/',
    });
  });

  it('keeps it too when the open project is not the run project', async () => {
    open.project = otherProject;
    call.mockResolvedValue(started);
    await startProducts('k2', dated);
    expect(photoUi.getState().dates.k2).toEqual({ captureDate: '2026-04-02' });
    expect(photoUi.getState().dateWarnings.k2?.date).toBe('2026-04-02');
  });

  it('Create maps again asks for the date again and, when it is saved, starts under it', async () => {
    call.mockImplementation((channel: string) =>
      Promise.resolve(channel === 'builder:ensureCapture' ? refusedSave : started),
    );
    await startProducts('k3', dated);
    call.mockReset();
    call.mockImplementation((channel: string) =>
      Promise.resolve(channel === 'builder:ensureCapture' ? goodSave : started),
    );
    // what Create maps again passes: the run's kept date
    const again: PendingProducts = { ...base, products: ['ortho'], ...photoUi.getState().dates.k3 };
    expect(await startProducts('k3', again)).toBeNull();
    expect(channelsOf()).toEqual(['builder:ensureCapture', 'jobs:start']);
    expect(call).toHaveBeenNthCalledWith(1, 'builder:ensureCapture', {
      projectId: 'p1',
      date: '2026-04-02',
    });
    expect(paramsOfStart()).toMatchObject({ run: 'k3', capture: 'capture-2026-04-02' });
    expect(photoUi.getState().dateWarnings.k3).toBeUndefined();
    expect(photoUi.getState().dates.k3).toBeUndefined();
  });

  it('Create maps again whose save fails again keeps the date and the warning', async () => {
    call.mockImplementation((channel: string) =>
      Promise.resolve(channel === 'builder:ensureCapture' ? refusedSave : started),
    );
    await startProducts('k5', dated);
    const again: PendingProducts = { ...base, products: ['ortho'], ...photoUi.getState().dates.k5 };
    expect(await startProducts('k5', again)).toBeNull();
    expect(channelsOf().filter((c) => c === 'builder:ensureCapture')).toHaveLength(2);
    expect(photoUi.getState().dates.k5).toEqual({ captureDate: '2026-04-02' });
    expect(photoUi.getState().dateWarnings.k5).toEqual({
      date: '2026-04-02',
      root: 'D:/Projects/site/',
    });
  });

  it('a start that works with a date clears the kept date and the warning', async () => {
    photoUi.getState().setDate('k4', { captureDate: '2026-04-02' });
    photoUi.getState().setDateWarning('k4', { date: '2026-04-02', root: 'D:/Projects/site/' });
    call.mockImplementation((channel: string) =>
      Promise.resolve(channel === 'builder:ensureCapture' ? goodSave : started),
    );
    await startProducts('k4', dated);
    expect(photoUi.getState().dates.k4).toBeUndefined();
    expect(photoUi.getState().dateWarnings.k4).toBeUndefined();
  });
});

describe('fileUnderDate', () => {
  const root = 'D:/Projects/site/';
  const warn = (run: string) => {
    photoUi.getState().setDate(run, { captureDate: '2026-04-02' });
    photoUi.getState().setDateWarning(run, { date: '2026-04-02', root });
  };
  const manifestWith = (captures: string[]) => ({ captures, layers: [] });
  const goodSave = {
    ok: true,
    value: {
      ok: true,
      manifest: manifestWith(['saved']),
      captureId: 'capture-2026-04-02',
      created: true,
    },
  };
  const readRun = (layers: string[]) => ({
    ok: true,
    value: { ok: true, run: { outputs: { layers } }, accuracy: null },
  });
  const updated = { ok: true, value: { ok: true, manifest: manifestWith(['filed']), backup: 'b' } };
  const channelsOf = () => call.mock.calls.map((c) => c[0] as string);
  const answer = (replies: Record<string, unknown>) => {
    call.mockImplementation((channel: string) => {
      const r = replies[channel];
      return typeof r === 'function' ? (r as () => Promise<unknown>)() : Promise.resolve(r);
    });
  };
  const layersOpen = () => {
    open.project = {
      id: 'p1',
      root: 'D:\\Projects\\site',
      manifest: {
        layers: [
          { id: 'ortho-1' },
          { id: 'dsm-1' },
          { id: 'moved', capture: 'by-hand' },
          { id: 'other-run' },
        ],
      },
    };
  };

  it('saves the date, files the undated layers of the run under it and clears the warning', async () => {
    layersOpen();
    warn('f1');
    answer({
      'photo:readRun': readRun(['ortho-1', 'dsm-1', 'moved']),
      'builder:ensureCapture': goodSave,
      'builder:updateLayers': updated,
    });
    expect(await fileUnderDate('f1')).toBeNull();
    expect(call).toHaveBeenCalledWith('builder:ensureCapture', {
      projectId: 'p1',
      date: '2026-04-02',
    });
    expect(call).toHaveBeenCalledWith('builder:updateLayers', {
      projectId: 'p1',
      // a layer the person already moved to a date, and a layer of another run, are left alone
      layerIds: ['ortho-1', 'dsm-1'],
      patch: { capture: 'capture-2026-04-02' },
    });
    expect(replaceManifest).toHaveBeenCalledWith(manifestWith(['saved']));
    expect(replaceManifest).toHaveBeenLastCalledWith(manifestWith(['filed']));
    expect(photoUi.getState().dateWarnings.f1).toBeUndefined();
    expect(photoUi.getState().dates.f1).toBeUndefined();
  });

  it('touches no layer and keeps the warning and the date when the save is refused', async () => {
    layersOpen();
    warn('f2');
    answer({
      'photo:readRun': readRun(['ortho-1']),
      'builder:ensureCapture': {
        ok: true,
        value: { ok: false, error: 'The project is read-only.' },
      },
    });
    expect(await fileUnderDate('f2')).toBe('The project is read-only.');
    expect(channelsOf()).not.toContain('builder:updateLayers');
    expect(photoUi.getState().dateWarnings.f2).toEqual({ date: '2026-04-02', root });
    expect(photoUi.getState().dates.f2).toEqual({ captureDate: '2026-04-02' });
  });

  it('answers a reason when the save throws or the reply is not ok', async () => {
    layersOpen();
    warn('f3');
    answer({
      'photo:readRun': readRun(['ortho-1']),
      'builder:ensureCapture': () => Promise.reject(new Error('gone')),
    });
    expect(await fileUnderDate('f3')).toBe('gone');
    answer({
      'photo:readRun': readRun(['ortho-1']),
      'builder:ensureCapture': { ok: false, error: 'busy' },
    });
    expect(await fileUnderDate('f3')).toBe('busy');
    expect(channelsOf()).not.toContain('builder:updateLayers');
    expect(photoUi.getState().dateWarnings.f3).toBeDefined();
  });

  it('keeps the warning when the layers cannot be updated, and a second try can work', async () => {
    layersOpen();
    warn('f4');
    answer({
      'photo:readRun': readRun(['ortho-1']),
      'builder:ensureCapture': goodSave,
      'builder:updateLayers': { ok: true, value: { ok: false, error: 'Disk full.' } },
    });
    expect(await fileUnderDate('f4')).toBe('Disk full.');
    expect(photoUi.getState().dateWarnings.f4).toEqual({ date: '2026-04-02', root });
    expect(photoUi.getState().dates.f4).toEqual({ captureDate: '2026-04-02' });
    // the date exists now, so the second click finds it and files the layers
    answer({
      'photo:readRun': readRun(['ortho-1']),
      'builder:ensureCapture': { ...goodSave, value: { ...goodSave.value, created: false } },
      'builder:updateLayers': updated,
    });
    expect(await fileUnderDate('f4')).toBeNull();
    expect(photoUi.getState().dateWarnings.f4).toBeUndefined();
    expect(photoUi.getState().dates.f4).toBeUndefined();
  });

  it('calls nothing and says why when the open project is not the run project', async () => {
    open.project = otherProject;
    warn('f5');
    expect(await fileUnderDate('f5')).toMatch(/Open the project/);
    expect(call).not.toHaveBeenCalled();
    expect(photoUi.getState().dateWarnings.f5).toBeDefined();
  });

  it('calls nothing and says why when no project is open or the run has no warning', async () => {
    open.project = null;
    warn('f6');
    expect(await fileUnderDate('f6')).toMatch(/Open the project/);
    open.project = { id: 'p1', root: 'D:\\Projects\\site', manifest: { layers: [] } };
    expect(await fileUnderDate('nobody')).toMatch(/no survey date/i);
    expect(call).not.toHaveBeenCalled();
  });

  it('does not save the date while the maps have no layers yet', async () => {
    layersOpen();
    warn('f7');
    answer({ 'photo:readRun': readRun([]) });
    expect(await fileUnderDate('f7')).toMatch(/not ready/);
    expect(channelsOf()).toEqual(['photo:readRun']);
    expect(photoUi.getState().dateWarnings.f7).toBeDefined();
  });

  it('clears the warning without a call when every layer of the run already has a date', async () => {
    layersOpen();
    warn('f8');
    answer({ 'photo:readRun': readRun(['moved']) });
    expect(await fileUnderDate('f8')).toBeNull();
    expect(channelsOf()).toEqual(['photo:readRun']);
    expect(photoUi.getState().dateWarnings.f8).toBeUndefined();
  });

  it('answers the reason when the run cannot be read', async () => {
    layersOpen();
    warn('f9');
    answer({ 'photo:readRun': { ok: true, value: { ok: false, error: 'No such run.' } } });
    expect(await fileUnderDate('f9')).toBe('No such run.');
    expect(photoUi.getState().dateWarnings.f9).toBeDefined();
  });

  // the run file lists layers the project manifest has not been reloaded with yet
  it('waits, and sends nothing, when the layers of the run are not in the manifest yet', async () => {
    layersOpen();
    warn('g1');
    answer({ 'photo:readRun': readRun(['new-ortho', 'new-dsm']) });
    expect(await fileUnderDate('g1')).toBe('The maps are not loaded yet. Try again in a moment.');
    expect(channelsOf()).toEqual(['photo:readRun']);
    expect(replaceManifest).not.toHaveBeenCalled();
    expect(photoUi.getState().dateWarnings.g1).toEqual({ date: '2026-04-02', root });
    expect(photoUi.getState().dates.g1).toEqual({ captureDate: '2026-04-02' });
  });

  it('waits when only some layers of the run are in the manifest', async () => {
    layersOpen();
    warn('g2');
    answer({ 'photo:readRun': readRun(['ortho-1', 'new-dsm']) });
    expect(await fileUnderDate('g2')).toBe('The maps are not loaded yet. Try again in a moment.');
    expect(channelsOf()).toEqual(['photo:readRun']);
    expect(photoUi.getState().dateWarnings.g2).toBeDefined();
    expect(photoUi.getState().dates.g2).toBeDefined();
  });

  describe('when the open project changes during the call', () => {
    const switchTo = (reply: unknown) => () => {
      open.project = otherProject;
      return Promise.resolve(reply);
    };

    it('stops after the run is read and replaces no manifest', async () => {
      layersOpen();
      warn('h1');
      answer({ 'photo:readRun': switchTo(readRun(['ortho-1'])) });
      expect(await fileUnderDate('h1')).toMatch(/Open the project/);
      expect(channelsOf()).toEqual(['photo:readRun']);
      expect(replaceManifest).not.toHaveBeenCalled();
      expect(photoUi.getState().dateWarnings.h1).toEqual({ date: '2026-04-02', root });
      expect(photoUi.getState().dates.h1).toEqual({ captureDate: '2026-04-02' });
    });

    it('stops after the date is saved: no layer is written, no manifest replaced', async () => {
      layersOpen();
      warn('h2');
      answer({
        'photo:readRun': readRun(['ortho-1']),
        'builder:ensureCapture': switchTo(goodSave),
        'builder:updateLayers': updated,
      });
      expect(await fileUnderDate('h2')).toMatch(/Open the project/);
      expect(channelsOf()).toEqual(['photo:readRun', 'builder:ensureCapture']);
      expect(replaceManifest).not.toHaveBeenCalled();
      expect(photoUi.getState().dateWarnings.h2).toEqual({ date: '2026-04-02', root });
      expect(photoUi.getState().dates.h2).toEqual({ captureDate: '2026-04-02' });
    });

    it('replaces no manifest of the other project once the layers are filed', async () => {
      layersOpen();
      warn('h3');
      answer({
        'photo:readRun': readRun(['ortho-1']),
        'builder:ensureCapture': goodSave,
        'builder:updateLayers': switchTo(updated),
      });
      // the layers were filed in the run's project, so the warning goes
      expect(await fileUnderDate('h3')).toBeNull();
      expect(replaceManifest).toHaveBeenCalledTimes(1);
      expect(replaceManifest).not.toHaveBeenCalledWith(manifestWith(['filed']));
      expect(photoUi.getState().dateWarnings.h3).toBeUndefined();
    });
  });

  it('leaves a newer warning of the run alone when the call ends', async () => {
    layersOpen();
    warn('i1');
    const newer = { date: '2026-05-01', root };
    answer({
      'photo:readRun': readRun(['ortho-1']),
      'builder:ensureCapture': goodSave,
      'builder:updateLayers': () => {
        // a start for the same run, meanwhile, warned about another day
        photoUi.getState().setDate('i1', { captureDate: '2026-05-01' });
        photoUi.getState().setDateWarning('i1', newer);
        return Promise.resolve(updated);
      },
    });
    expect(await fileUnderDate('i1')).toBeNull();
    expect(photoUi.getState().dateWarnings.i1).toBe(newer);
    expect(photoUi.getState().dates.i1).toEqual({ captureDate: '2026-05-01' });
  });
});
