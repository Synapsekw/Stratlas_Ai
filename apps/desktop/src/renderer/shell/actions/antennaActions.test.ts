// @vitest-environment jsdom
import type { AntennasFile, AntennaUnit, ProjectManifest } from '@aio/schema';
import { actionsFor, makeActionCtx, type MenuTarget } from '@aio/ui';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const ask = vi.hoisted(() => vi.fn());
const reveal = vi.hoisted(() => vi.fn());
vi.mock('../../telecom/antennaDelete', () => ({ askDeleteAntennas: ask }));
vi.mock('../../workspace/workbench/project/projectListStore', () => ({ revealInList: reveal }));
vi.mock('../../shell', () => ({
  bridge: { call: () => Promise.resolve({ ok: false, error: 'Not configured' }) },
  jobs: { subscribe: () => () => undefined, getState: () => ({ jobs: [] }) },
}));

const { registerAntennaActions } = await import('./antennaActions');
const { antennaStore } = await import('../../telecom/antennaStore');

const unit = (id: string, over: Partial<AntennaUnit> = {}): AntennaUnit =>
  ({
    id,
    name: `Unit ${id}`,
    kind: 'panel',
    kindBasis: 'detected',
    status: 'draft',
    ...over,
  }) as unknown as AntennaUnit;

const manifest = { captures: [], layers: [] } as unknown as ProjectManifest;
const ctx = () => makeActionCtx({ manifest });
const one = (id: string): MenuTarget => ({ kind: 'antennas', ids: [id], clicked: id });
const two: MenuTarget = { kind: 'antennas', ids: ['a', 'b'], clicked: 'a' };
const ids = (t: MenuTarget) => actionsFor(t, ctx()).map((i) => i.id);
const item = (t: MenuTarget, id: string) => actionsFor(t, ctx()).find((i) => i.id === id);

beforeEach(() => {
  ask.mockClear();
  reveal.mockClear();
  registerAntennaActions();
  antennaStore.setState({
    root: 'E:/p',
    readOnly: false,
    running: false,
    flagStarting: false,
    flagJob: null,
    flagging: null,
    flyRequest: null,
    hidden: {},
    solo: null,
    selected: null,
    focusField: null,
    file: { units: [unit('a'), unit('b'), unit('d', { kind: 'dish' })] } as unknown as AntennasFile,
  });
});

describe('antenna actions', () => {
  it('lists the actions of one unit in section order', () => {
    expect(ids(one('a'))).toEqual([
      'antenna.flyTo',
      'antenna.hide',
      'antenna.soloKind',
      'antenna.editAzimuth',
      'antenna.editDowntilt',
      'antenna.accept',
      'antenna.reject',
      'antenna.redraw',
      'antenna.delete',
    ]);
    antennaStore.setState({ hidden: { a: true } });
    expect(ids(one('a'))).toContain('antenna.show');
    expect(ids(one('a'))).not.toContain('antenna.hide');
  });

  it('leaves the downtilt out for a dish', () => {
    expect(ids(one('d'))).not.toContain('antenna.editDowntilt');
    expect(ids(one('d'))).toContain('antenna.editAzimuth');
  });

  it('offers only the multi actions on several units', () => {
    expect(ids(two)).toEqual([
      'antenna.flyTo',
      'antenna.hide',
      'antenna.accept',
      'antenna.reject',
      'antenna.delete',
    ]);
  });

  it('delete asks for every id', () => {
    item(two, 'antenna.delete')?.run();
    expect(ask).toHaveBeenCalledWith(['a', 'b']);
  });

  it('edit azimuth selects, reveals and asks the row to focus the field', () => {
    item(one('b'), 'antenna.editAzimuth')?.run();
    expect(antennaStore.getState().selected).toBe('b');
    expect(reveal).toHaveBeenCalledWith('antennas', 'b');
    expect(antennaStore.getState().focusField).toMatchObject({ id: 'b', key: 'azimuthGridDeg' });
    const seq = antennaStore.getState().focusField?.seq ?? 0;
    item(one('b'), 'antenna.editDowntilt')?.run();
    expect(antennaStore.getState().focusField).toMatchObject({ key: 'downtiltDeg' });
    expect(antennaStore.getState().focusField?.seq).toBeGreaterThan(seq);
  });

  it('fly to asks the 3D view for the units', () => {
    item(two, 'antenna.flyTo')?.run();
    expect(antennaStore.getState().flyRequest?.ids).toEqual(['a', 'b']);
  });

  it('hide changes the hidden map, solo sets the kind and again clears it', () => {
    item(two, 'antenna.hide')?.run();
    expect(antennaStore.getState().hidden).toEqual({ a: true, b: true });
    item(one('d'), 'antenna.soloKind')?.run();
    expect(antennaStore.getState().solo).toBe('dish');
    item(one('d'), 'antenna.soloKind')?.run();
    expect(antennaStore.getState().solo).toBeNull();
  });

  it('greys the edits for a read-only inventory', () => {
    antennaStore.setState({ readOnly: true });
    for (const id of [
      'antenna.editAzimuth',
      'antenna.accept',
      'antenna.reject',
      'antenna.redraw',
      'antenna.delete',
    ])
      expect(item(one('a'), id)?.disabled).toBeTruthy();
    expect(item(one('a'), 'antenna.flyTo')?.disabled).toBe(false);
  });

  it('redraw is greyed while detection or a flag job runs, and starts the flag tool otherwise', () => {
    antennaStore.setState({ running: true });
    expect(item(one('a'), 'antenna.redraw')?.disabled).toBeTruthy();
    expect(item(one('a'), 'antenna.accept')?.disabled).toBe(false);
    antennaStore.setState({ running: false, flagJob: { id: 'j', unit: 'a' } });
    expect(item(one('a'), 'antenna.redraw')?.disabled).toBeTruthy();
    antennaStore.setState({ flagJob: null });
    item(one('a'), 'antenna.redraw')?.run();
    expect(antennaStore.getState().flagging).toEqual({ unit: 'a' });
  });
});
