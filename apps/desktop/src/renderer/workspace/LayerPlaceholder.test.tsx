// @vitest-environment jsdom
import { setAnnotateReadOnly } from '@aio/annotate';
import { ProjectManifest, SCHEMA_VERSION } from '@aio/schema';
import { workspace } from '@aio/workspace';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { photoUi } from '../photogrammetry/store';
import { LayerPlaceholder, photosWithoutMaps } from './LayerPlaceholder';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// the files card asks main about missing files: nothing is missing here
vi.mock('../team/Files', () => ({
  useLayerFiles: () => ({ layers: [] }),
  Files: () => null,
  LayerFileRow: () => null,
}));

const manifest = ProjectManifest.parse({
  schema: SCHEMA_VERSION,
  id: 'photo-only',
  name: 'Photo only',
  crs: { epsg: 32639 },
  origin: [500000, 3200000, 0],
  captures: [{ id: 'c1', label: 'Survey', date: '2026-01-01' }],
  layers: [
    {
      kind: 'photos',
      id: 'photos-a',
      name: 'Flight A',
      capture: 'c1',
      items: [{ id: 'p1', src: { path: 'photos/p1.jpg' } }],
    },
  ],
  severityModels: [],
  classCatalogues: [],
});

const open = () => {
  act(() => {
    workspace.getState().openProject({ id: manifest.id, root: 'D:\\p\\photo-only', manifest });
  });
};
const offer = () => document.querySelector('[data-testid="photos-maps-offer"]');

describe('photosWithoutMaps', () => {
  it('is photos and no model, cloud or raster', () => {
    expect(photosWithoutMaps({ photos: 1 })).toBe(true);
    expect(photosWithoutMaps({ photos: 1, video: 2 })).toBe(true);
    expect(photosWithoutMaps({ photos: 1, raster: 1 })).toBe(false);
    expect(photosWithoutMaps({ mesh: 1 })).toBe(false);
  });
});

describe('the Create maps offer over a photo-only scene', () => {
  let host: HTMLDivElement;
  let root: Root | undefined;
  beforeEach(() => {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    open();
    act(() => root?.render(<LayerPlaceholder />));
  });
  afterEach(() => {
    act(() => root?.unmount());
    root = undefined;
    host.remove();
    act(() => {
      setAnnotateReadOnly(false);
      workspace.getState().closeProject();
    });
  });

  it('opens the wizard', () => {
    const wizard = vi.spyOn(photoUi.getState(), 'openWizard').mockImplementation(() => undefined);
    act(() => document.querySelector<HTMLElement>('[data-testid="photos-create-maps"]')?.click());
    expect(wizard).toHaveBeenCalledTimes(1);
    wizard.mockRestore();
  });

  it('Not now hides it until the project is opened again', () => {
    expect(offer()).not.toBeNull();
    const later = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Not now');
    act(() => later?.click());
    expect(offer()).toBeNull();
    // the same project, opened again
    open();
    expect(offer()).not.toBeNull();
  });

  it('is not offered to a reviewer who may only look', () => {
    act(() => {
      setAnnotateReadOnly(true);
    });
    expect(offer()).toBeNull();
  });
});
