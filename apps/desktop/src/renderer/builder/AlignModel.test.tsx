// @vitest-environment jsdom
import type { Georef, Layer, LayerPatch, ProjectManifest } from '@aio/schema';
import { workspace } from '@aio/workspace';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AlignModel } from './AlignModel';
import { builder } from './state';

vi.mock('@aio/maps', () => ({ LocationPicker: () => null }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mesh: Layer = {
  kind: 'mesh',
  id: 'tower',
  name: 'Tower',
  visible: true,
  src: { path: 'models/tower.glb' },
  transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
};

const manifest = (origin: [number, number, number]): ProjectManifest => ({
  schema: 'aio.project/1',
  id: 'p',
  name: 'P',
  crs: { epsg: 32639 },
  origin,
  captures: [],
  layers: [mesh],
  severityModels: [],
  classCatalogues: [],
});

let host: HTMLDivElement;
let root: Root | undefined;
const saveLayers = builder.getState().saveLayers;

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  builder.setState({ saveLayers: () => Promise.resolve(null) });
  workspace.getState().openProject({ id: 'p', root: 'E:/p', manifest: manifest([500000, 0, 0]) });
});

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
  builder.setState({ saveLayers });
  workspace.getState().closeProject();
});

const button = (name: string) =>
  [...host.querySelectorAll('button')].find((b) => b.textContent.trim() === name) ?? null;

describe('Georeference model', () => {
  it('forgets its Undo when the project origin moves (a re-centre)', async () => {
    act(() => {
      root = createRoot(host);
      root.render(<AlignModel layerId="tower" />);
    });
    await act(async () => {
      button('Z up')?.click();
      await Promise.resolve();
    });
    expect(button('Undo')).not.toBeNull();

    // the same project reopened in a new frame: the old transform means something else now
    act(() => {
      workspace
        .getState()
        .openProject({ id: 'p', root: 'E:/p', manifest: manifest([530000, 0, 0]) });
    });
    expect(button('Undo')).toBeNull();
  });

  it('saves a georeferenced model with its georeference and placement in one patch', async () => {
    const georef: Georef = {
      schema: 'aio.georef/1',
      crs: { epsg: 32639 },
      anchor: [500000, 0, 0],
      axes: 'x-east,y-up,z-south',
      units: 'm',
      modelToCrs: [1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 500000, 0, 0, 1],
      heading: { deg: 0, status: 'assumed-grid' },
      scale: { factor: 1, status: 'assumed' },
      horizontal: { status: 'unplaced' },
      vertical: { datum: 'unknown', status: 'unknown' },
      provenance: { by: 'engineer', runId: 'r1' },
    };
    const placed: Layer = { ...mesh, georef, placement: 'provisional' };
    workspace.getState().openProject({
      id: 'p',
      root: 'E:/p',
      manifest: { ...manifest([500000, 0, 0]), layers: [placed] },
    });
    const patches: LayerPatch[] = [];
    builder.setState({
      saveLayers: (_ids: readonly string[], patch: LayerPatch) => {
        patches.push(patch);
        return Promise.resolve(null);
      },
    });
    act(() => {
      root = createRoot(host);
      root.render(<AlignModel layerId="tower" />);
    });
    await act(async () => {
      button('Z up')?.click();
      await Promise.resolve();
    });
    const saved = patches[0] as
      { transform?: number[]; georef?: Georef; placement?: string } | undefined;
    expect(saved?.placement).toBe('placed');
    expect(saved?.transform).toBeDefined();
    expect(saved?.georef?.provenance.by).toBe('place-model');
    // the record follows the new transform: Z up turns the model's up axis onto the grid's up
    expect(saved?.georef?.modelToCrs).not.toEqual(georef.modelToCrs);
    // Undo puts back all of it, in one write
    await act(async () => {
      button('Undo')?.click();
      await Promise.resolve();
    });
    expect(patches[1]).toEqual({
      transform: mesh.transform,
      georef,
      placement: 'provisional',
    });
  });
});
