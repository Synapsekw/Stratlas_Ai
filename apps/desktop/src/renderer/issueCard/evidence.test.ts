// @vitest-environment jsdom
import type { Issue, ProjectManifest } from '@aio/schema';
import { workspace } from '@aio/workspace';
import { afterEach, describe, expect, it, vi } from 'vitest';
(window as unknown as { aio: object }).aio = { on: () => () => undefined };
const { openEvidence } = await import('./evidence');

const manifest = {
  schema: 'aio.project/1',
  id: 'p',
  name: 'P',
  crs: { epsg: 32639 },
  origin: [0, 0, 0],
  captures: [
    {
      id: 'd1',
      label: 'd1',
      date: '2025-01-01',
      lineUp: { eastM: 2, northM: 1, with: 'd0', at: '2026-01-01T00:00:00Z' },
    },
  ],
  layers: [
    {
      kind: 'mesh',
      id: 'm',
      name: 'M',
      visible: true,
      capture: 'd1',
      src: { path: 'm.glb' },
      transform: [],
    },
    {
      kind: 'photos',
      id: 'ph',
      name: 'P',
      visible: true,
      items: [{ id: 'a', src: { path: 'a.jpg' } }],
    },
  ],
  severityModels: [],
  classCatalogues: [],
} as unknown as ProjectManifest;

const issue = {
  id: 'i1',
  code: 'D1',
  title: 't',
  severity: 1,
  status: 'open',
  sightings: [
    { on: 'mesh', layer: 'm', geom: { type: 'spoint', p: [10, 4, 20] } },
    { on: 'image', layer: 'ph', photo: 'a', geom: { type: 'point', x: 1, y: 1 } },
  ],
} as unknown as Issue;

describe('openEvidence', () => {
  afterEach(() => vi.restoreAllMocks());

  it('flies to the pin where its lined-up date is drawn', () => {
    workspace.getState().openProject({ id: 'p', root: 'C:/p', manifest }, [issue]);
    const flyTo = vi.spyOn(workspace.getState(), 'flyTo');
    expect(openEvidence('i1')).toBe(true);
    expect(flyTo).toHaveBeenCalledWith({ kind: 'point', p: [12, 4, 19], distance: 4 });
  });
});
