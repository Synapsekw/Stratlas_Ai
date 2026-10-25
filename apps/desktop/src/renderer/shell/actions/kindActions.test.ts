// @vitest-environment jsdom
import type { ProjectManifest } from '@aio/schema';
import { actionsFor, formatDate, makeActionCtx, type MenuTarget } from '@aio/ui';
import { workspace } from '@aio/workspace';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { align, start } = vi.hoisted(() => ({
  align: vi.fn(() => Promise.resolve()),
  start: vi.fn(() => Promise.resolve()),
}));
vi.mock('../../builder/alignSession', () => ({
  alignTo: { getState: () => ({ alignTo: align }) },
  alignCamera: { getState: () => ({ start: vi.fn() }) },
}));

const { drop } = vi.hoisted(() => ({ drop: vi.fn(() => Promise.resolve()) }));
vi.mock('../../builder/dropSession', () => ({
  dropToGround: { getState: () => ({ drop }) },
}));

const { startCompare } = vi.hoisted(() => ({ startCompare: vi.fn() }));
vi.mock('../../walks/walkCompare', () => ({ startWalkCompare: startCompare }));

const { alignTargets, registerKindActions } = await import('./kindActions');
const { pinDisplay } = await import('@aio/annotate');
const { jobs } = await import('../../shell');
const { engineerUi } = await import('../../engineer/ui');

const L = (o: Record<string, unknown>) => ({ visible: true, ...o });
const manifest = {
  captures: [
    { id: 'c1', label: '2026-09-01', date: '2026-09-01' },
    { id: 'c2', label: 'After rain', date: '2026-10-01' },
  ],
  layers: [
    L({ kind: 'pointcloud', id: 'cloud', name: 'Cloud', format: 'png-packed', capture: 'c2' }),
    L({ kind: 'mesh', id: 'mesh', name: 'Model', capture: 'c1' }),
    L({
      kind: 'photos',
      id: 'setA',
      name: 'Set A',
      capture: 'c1',
      items: [
        { id: 'a1', pos: [1, 2, 3] },
        { id: 'a2' },
        { id: 'a3', pos: [4, 1.6, 6], pin: { ground: [4, 0, 6], eyeM: 1.6 } },
      ],
    }),
    L({ kind: 'photos', id: 'setB', name: 'Set B', items: [{ id: 'b1' }] }),
    L({
      kind: 'video',
      id: 'clip',
      name: 'Clip',
      offsetMs: 0,
      flight: { src: { path: 'f.json' }, startUtcMs: 1 },
    }),
    L({
      kind: 'walk',
      id: 'walk',
      name: 'Walk',
      record: { path: 'walks/w/walk.json' },
      place: { pins: [{}, {}], quality: 'good' },
    }),
    L({
      kind: 'panoramas',
      id: 'panos',
      name: 'Panos',
      items: [
        { id: 'p1', pos: [0, 0, 0] },
        { id: 'p2', pos: [0, 0, 0], stitch: { status: 'queued' } },
      ],
    }),
  ],
} as unknown as ProjectManifest;

const ctx = makeActionCtx({ manifest });
const on = (...layerIds: string[]): MenuTarget => ({ kind: 'layers', layerIds });
const ids = (t: MenuTarget, c = ctx) => actionsFor(t, c).map((i) => i.id);
const item = (t: MenuTarget, id: string, c = ctx) => actionsFor(t, c).find((i) => i.id === id);

let off: () => void;
beforeEach(() => {
  off = registerKindActions();
  align.mockClear();
  drop.mockClear();
  start.mockClear();
  jobs.setState({ start } as never);
  workspace.setState({
    project: { id: 'p', root: 'C:/p', manifest },
  });
});
afterEach(() => {
  off();
  engineerUi.setState({ open: false, preselect: [] });
});

describe('actions per kind', () => {
  it('offers Drop to ground on a placed walk, with a cloud too, and runs it on both', () => {
    const both = item(on('walk', 'cloud'), 'layer.dropToGround');
    expect(both).toBeDefined();
    both?.run();
    expect(drop).toHaveBeenCalledWith(['walk', 'cloud']);
    const unplaced = makeActionCtx({
      manifest: {
        ...manifest,
        layers: manifest.layers.map((l) =>
          l.id === 'walk' ? ({ ...l, place: undefined } as unknown as typeof l) : l,
        ),
      },
    });
    expect(ids(on('walk'), unplaced)).not.toContain('layer.dropToGround');
  });

  it('offers Drop to ground on clouds and models, also marked together', () => {
    expect(ids(on('cloud'))).toContain('layer.dropToGround');
    expect(ids(on('mesh'))).toContain('layer.dropToGround');
    const both = item(on('cloud', 'mesh'), 'layer.dropToGround');
    expect(both?.disabled).toBe(false);
    expect(both?.testId).toBe('menu-drop-to-ground');
  });

  it('greys Drop to ground for a kit-packed cloud with its reason', () => {
    const kit = {
      ...manifest,
      layers: [
        L({ kind: 'pointcloud', id: 'kit', name: 'Kit', format: 'kit-packed' }),
        ...manifest.layers,
      ],
    } as unknown as ProjectManifest;
    const c = makeActionCtx({ manifest: kit });
    expect(item(on('kit'), 'layer.dropToGround', c)?.disabled).toBe(
      'This cloud format cannot be moved.',
    );
    expect(item(on('kit', 'mesh'), 'layer.dropToGround', c)?.disabled).toBe(
      'This cloud format cannot be moved.',
    );
  });

  it('leaves Drop to ground off photos and change results', () => {
    const m = {
      ...manifest,
      layers: [
        L({
          kind: 'mesh',
          id: 'chg',
          name: 'Change',
          derived: { kind: 'change' },
        }),
        ...manifest.layers,
      ],
    } as unknown as ProjectManifest;
    const c = makeActionCtx({ manifest: m });
    expect(ids(on('setA'), c)).not.toContain('layer.dropToGround');
    expect(ids(on('chg'), c)).not.toContain('layer.dropToGround');
    expect(ids(on('cloud', 'setA'), c)).not.toContain('layer.dropToGround');
  });

  it('drops the marked set', () => {
    item(on('cloud', 'mesh'), 'layer.dropToGround')?.run();
    expect(drop).toHaveBeenCalledWith(['cloud', 'mesh']);
  });

  it('Drop to ground is greyed in a package', () => {
    const c = makeActionCtx({ manifest, pkg: true, canEdit: false });
    expect(item(on('cloud'), 'layer.dropToGround', c)?.disabled).toBe(
      'This is a package: its files stay inside it.',
    );
  });

  it('each kind lists its extras', () => {
    expect(ids(on('cloud'))).toEqual(expect.arrayContaining(['cloud.settings', 'cloud.colourBy']));
    expect(ids(on('mesh'))).toEqual(
      expect.arrayContaining(['mesh.georef', 'mesh.place', 'engineering.create']),
    );
    expect(ids(on('setA'))).toEqual(
      expect.arrayContaining(['photos.alignTo', 'photos.createMaps', 'photos.openFirst']),
    );
    expect(ids(on('clip'))).toEqual(
      expect.arrayContaining(['video.calibrate', 'video.alignCamera', 'video.flightPath']),
    );
    expect(ids(on('walk'))).toEqual(
      expect.arrayContaining([
        'walk.open',
        'walk.place',
        'walk.removePlacement',
        'layer.dropToGround',
      ]),
    );
    expect(ids(on('panos'))).toEqual(expect.arrayContaining(['pano.open', 'pano.stitch']));
    expect(ids({ kind: 'annotations', row: 'issues' })).toEqual([
      'annotations.open',
      'annotations.pins',
    ]);
  });

  it('Create engineering model is offered for one source layer, not a vector layer or two layers', () => {
    const plain = {
      ...manifest,
      layers: [
        ...manifest.layers,
        L({
          kind: 'vector',
          id: 'plan',
          name: 'Plan',
          src: { path: 'p.geojson' },
          format: 'geojson',
        }),
      ],
    } as unknown as ProjectManifest;
    const c = makeActionCtx({ manifest: plain });
    expect(ids(on('cloud'), c)).toContain('engineering.create');
    expect(ids(on('setA'), c)).toContain('engineering.create');
    expect(ids(on('plan'), c)).not.toContain('engineering.create');
    expect(ids(on('cloud', 'mesh'), c)).not.toContain('engineering.create');
  });

  it('Create engineering model opens the setup with that layer chosen and starts nothing', () => {
    item(on('cloud'), 'engineering.create')?.run();
    expect(engineerUi.getState()).toMatchObject({ open: true, preselect: ['cloud'] });
  });

  it('offers Colour by RGB only for a png-packed cloud', () => {
    expect(item(on('cloud'), 'cloud.colourBy')?.sub.map((s) => s.id)).toContain('rgb');
    const plain = {
      ...manifest,
      layers: [{ kind: 'pointcloud', id: 'cloud', name: 'Cloud', format: 'copc', visible: true }],
    } as unknown as ProjectManifest;
    const c = makeActionCtx({ manifest: plain });
    expect(item(on('cloud'), 'cloud.colourBy', c)?.sub.map((s) => s.id)).not.toContain('rgb');
  });

  it('Align to lists positioned datasets under their dates, not the set itself', () => {
    const a = item(on('setA'), 'photos.alignTo');
    expect(a?.disabled).toBe(false);
    expect(a?.present).toBe('submenu');
    expect(a?.sub.map((s) => [s.id, s.group])).toEqual([
      ['cloud', `${formatDate('2026-10-01')} · After rain`],
      ['mesh', formatDate('2026-09-01')],
      // the walk has pins but no fitted path: where it lies is not known yet
      ['panos', 'No date'],
    ]);
    expect(a?.sub.map((s) => s.id)).not.toContain('setA');
    a?.run('mesh');
    expect(align).toHaveBeenCalledWith({ layerIds: ['setA'] }, 'mesh');
  });

  it('Align to is greyed for a set with no positions', () => {
    expect(item(on('setB'), 'photos.alignTo')?.disabled).toBe(
      'None of these photos has a position.',
    );
  });

  it('Align to is greyed when the project only can be viewed', () => {
    const c = makeActionCtx({ manifest, canEdit: false });
    expect(item(on('setA'), 'photos.alignTo', c)?.disabled).toBe(
      'This project can only be viewed.',
    );
  });

  it('Align to is offered for several photo sets, not for a set and a model', () => {
    expect(ids(on('setA', 'setB'))).toContain('photos.alignTo');
    expect(ids(on('setA', 'mesh'))).not.toContain('photos.alignTo');
  });

  it('Align to on picked photos moves the picks', () => {
    const t: MenuTarget = { kind: 'photos', picks: [{ layerId: 'setA', photoId: 'a1' }] };
    item(t, 'photos.alignTo')?.run('mesh');
    expect(align).toHaveBeenCalledWith({ picks: [{ layerId: 'setA', photoId: 'a1' }] }, 'mesh');
  });

  it('Align to is not offered on pinned photos only (a pin is their hand placement)', () => {
    const pick = (photoId: string) => ({ layerId: 'setA', photoId });
    expect(ids({ kind: 'photos', picks: [pick('a3')] })).not.toContain('photos.alignTo');
    expect(ids({ kind: 'photos', picks: [pick('a3'), pick('a1')] })).toContain('photos.alignTo');
  });

  it('only actions that suit every marked layer are offered on several', () => {
    expect(ids(on('cloud', 'mesh'))).not.toContain('cloud.colourBy');
    expect(ids(on('cloud', 'cloud'))).toContain('cloud.colourBy');
    expect(ids(on('panos', 'mesh'))).not.toContain('pano.stitch');
    expect(ids(on('clip', 'mesh'))).not.toContain('video.flightPath');
  });

  it('Compare with walk lists the other walks under their dates and starts the compare', () => {
    const two = {
      ...manifest,
      layers: [
        ...manifest.layers,
        L({ kind: 'walk', id: 'walk2', name: 'Walk 2', capture: 'c2', record: { path: 'w2' } }),
        L({ kind: 'walk', id: 'walk3', name: 'Walk 3', record: { path: 'w3' } }),
      ],
    } as unknown as ProjectManifest;
    const c = makeActionCtx({ manifest: two });
    const a = item(on('walk'), 'walk.compareWith', c);
    expect(a?.disabled).toBe(false);
    expect(a?.present).toBe('submenu');
    expect(a?.sub.map((s) => [s.id, s.group])).toEqual([
      ['walk2', `${formatDate('2026-10-01')} · After rain`],
      ['walk3', 'No date'],
    ]);
    a?.run('walk2');
    expect(startCompare).toHaveBeenCalledWith('walk', 'walk2');
  });

  it('Compare with walk is greyed when there is no other walk', () => {
    expect(item(on('walk'), 'walk.compareWith')?.disabled).toBe(
      'There is no other walk to compare with',
    );
  });

  it('Remove placement asks the surface', () => {
    const askUnplace = vi.fn();
    const c = makeActionCtx({ manifest, host: { ...ctx.host, askUnplace } });
    item(on('walk'), 'walk.removePlacement', c)?.run();
    expect(askUnplace).toHaveBeenCalledWith('walk');
  });

  it('greys an edit action in a package and says why', () => {
    const c = makeActionCtx({ manifest, pkg: true, canEdit: false });
    expect(item(on('mesh'), 'mesh.georef', c)?.disabled).toBe(
      'This is a package: its files stay inside it.',
    );
  });

  it('Stitch starts the queued spheres', () => {
    item(on('panos'), 'pano.stitch')?.run();
    expect(start).toHaveBeenCalledWith({
      pipeline: 'pano.stitch',
      project: 'C:/p',
      params: { layer: 'panos', pano: 'p2', quality: 'standard', shape: 'sphere' },
    });
  });

  it('Show and Hide pins toggle the pins', () => {
    const t: MenuTarget = { kind: 'annotations', row: 'issues' };
    const before = pinDisplay.getState().filter;
    item(t, 'annotations.pins')?.run();
    expect(pinDisplay.getState().filter).not.toBe(before);
    item(t, 'annotations.pins')?.run();
    expect(pinDisplay.getState().filter).toBe(before);
  });

  it('alignTargets leaves out what is excluded', () => {
    expect(alignTargets(ctx, new Set(['mesh'])).map((s) => s.id)).not.toContain('mesh');
  });
});
