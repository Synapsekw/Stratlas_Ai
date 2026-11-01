import { describe, expect, test } from 'vitest';
import {
  Crs,
  DEFAULT_SPACE_ID,
  Issue,
  Layer,
  ProjectManifest,
  layerFrame,
  layersOfSpace,
  spaceFrame,
  spaceOfIssue,
  spacesOf,
} from './index';

const photos = (id: string, space?: string) => ({
  kind: 'photos' as const,
  id,
  name: id,
  items: [],
  ...(space ? { space } : {}),
});

const baseManifest = {
  schema: 'aio.project/1' as const,
  id: 'p1',
  name: 'Tank survey',
  crs: { epsg: 32636 },
  origin: [10, 20, 30] as [number, number, number],
  captures: [],
  layers: [photos('l1'), photos('l2')],
  severityModels: [],
  classCatalogues: [],
};

const localSpace = (id: string) => ({
  id,
  name: `Space ${id}`,
  crs: { local: 'flyability' },
  origin: [0, 0, 0],
  source: { kind: 'flyability' as const, inspectionId: 'insp-1' },
});

const withSpaces = {
  ...baseManifest,
  layers: [photos('la', 's-a'), photos('lb', 's-b')],
  spaces: [localSpace('s-a'), localSpace('s-b')],
};
const withSpacesAndOneLooseLayer = { ...withSpaces, layers: [photos('lm'), ...withSpaces.layers] };

const issueOn = (layer: string) => ({
  id: 'i1',
  code: 'F01',
  classId: 'c',
  severityModelId: 's',
  severity: 1,
  status: 'draft',
  title: 't',
  note: '',
  author: 'a',
  createdAt: '2026-10-31T10:00:00Z',
  updatedAt: '2026-10-31T10:00:00Z',
  sightings: [
    {
      on: 'image',
      layer,
      photo: 'p',
      geom: { type: 'point', x: 0.5, y: 0.5 },
    },
  ],
  source: 'import',
});

describe('spaces', () => {
  test('an older project reads as one default space', () => {
    const m = ProjectManifest.parse(baseManifest);
    expect(spacesOf(m)).toEqual([{ id: 'main', name: m.name, crs: m.crs, origin: m.origin }]);
    expect(layersOfSpace(m, 'main')).toHaveLength(m.layers.length);
  });

  test('a project with spaces lists them and keeps layer.space on a round trip', () => {
    const m = ProjectManifest.parse(withSpaces);
    expect(spacesOf(m).map((s) => s.id)).toEqual(['s-a', 's-b']);
    expect(ProjectManifest.parse(JSON.parse(JSON.stringify(m))).layers[0]?.space).toBe('s-a');
  });

  test('main stays listed while a layer has no space', () => {
    const m = ProjectManifest.parse(withSpacesAndOneLooseLayer);
    expect(spacesOf(m).map((s) => s.id)).toEqual(['main', 's-a', 's-b']);
    expect(layersOfSpace(m, DEFAULT_SPACE_ID).map((l) => l.id)).toEqual(['lm']);
  });

  test('a local CRS parses and duplicate space ids are refused', () => {
    expect(Crs.parse({ local: 'inspection' })).toEqual({ local: 'inspection' });
    expect(Crs.safeParse({ local: '' }).success).toBe(false);
    const dup = { ...withSpaces, spaces: [localSpace('s-a'), localSpace('s-a')] };
    expect(ProjectManifest.safeParse(dup).success).toBe(false);
  });

  test('a listed space cannot take the id main', () => {
    const bad = { ...withSpaces, spaces: [localSpace('main')] };
    expect(ProjectManifest.safeParse(bad).success).toBe(false);
  });

  test('a flightline layer parses and an issue keeps external', () => {
    const fl = {
      kind: 'flightline',
      id: 'fl1',
      name: 'Flight 1',
      src: { path: 'imports/flyability/s-a/flight-1.pose.json' },
      flight: 'f-1',
      bootStartS: 12.5,
      space: 's-a',
    };
    expect(Layer.parse(fl).kind).toBe('flightline');
    const issue = {
      ...issueOn('la'),
      external: {
        source: 'flyability',
        poi: 'poi-1',
        snapshots: ['snap-1'],
        wallDistanceM: null,
        hitDistanceM: 0.4,
        locationCheck: 'no-hit',
      },
    };
    expect(Issue.parse(issue).external?.locationCheck).toBe('no-hit');
  });

  test('spaceOfIssue follows the first sighting layer, spaceFrame finds the frame', () => {
    const m = ProjectManifest.parse(withSpacesAndOneLooseLayer);
    expect(spaceOfIssue(m, Issue.parse(issueOn('lb')))).toBe('s-b');
    expect(spaceOfIssue(m, Issue.parse(issueOn('lm')))).toBe('main');
    expect(spaceOfIssue(m, Issue.parse(issueOn('gone')))).toBe('main');
    expect(spaceFrame(m, 's-a')).toEqual({ crs: { local: 'flyability' }, origin: [0, 0, 0] });
    expect(spaceFrame(m, 'main')).toEqual({ crs: m.crs, origin: m.origin });
    expect(spaceFrame(m, 'nope')).toBeNull();
    // main is not listed when every layer names a space
    expect(spaceFrame(ProjectManifest.parse(withSpaces), 'main')).toBeNull();
  });

  test("layerFrame is the frame of the layer's space, else the project's", () => {
    const m = ProjectManifest.parse(withSpacesAndOneLooseLayer);
    const layer = (id: string): Layer => {
      const l = m.layers.find((x) => x.id === id);
      if (!l) throw new Error(`no layer ${id}`);
      return l;
    };
    expect(layerFrame(m, layer('lb'))).toEqual({ crs: { local: 'flyability' }, origin: [0, 0, 0] });
    expect(layerFrame(m, layer('lm'))).toEqual({ crs: m.crs, origin: m.origin });
    // every layer in a listed space: there is no main, yet a stray layer still has a frame
    const all = ProjectManifest.parse(withSpaces);
    expect(layerFrame(all, { ...layer('lm') })).toEqual({ crs: all.crs, origin: all.origin });
  });
});
