import { Issue, ProjectManifest } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import {
  activeSpaceOf,
  inSpace,
  issuesInSpace,
  mapAvailable,
  offSpaceLayers,
  scopeChange,
  switcherShown,
} from './spaceModel';

const photos = (id: string, space?: string) => ({
  kind: 'photos' as const,
  id,
  name: id,
  items: [],
  ...(space ? { space } : {}),
});

const base = {
  schema: 'aio.project/1' as const,
  id: 'p1',
  name: 'Tank survey',
  crs: { epsg: 32640 },
  origin: [10, 20, 30] as [number, number, number],
  captures: [],
  severityModels: [],
  classCatalogues: [],
};

const one = ProjectManifest.parse({ ...base, layers: [photos('l1')] });
const two = ProjectManifest.parse({
  ...base,
  layers: [photos('lm'), photos('la', 's-a'), photos('lb', 's-a')],
  spaces: [{ id: 's-a', name: 'Inside', crs: { local: 'flyability' }, origin: [0, 0, 0] }],
});

const issue = (id: string, layer: string): Issue =>
  Issue.parse({
    id,
    code: 'F01',
    classId: 'c',
    severityModelId: 'm',
    severity: 'uncertain',
    status: 'draft',
    title: id,
    note: '',
    author: 'a',
    createdAt: '2026-10-31T00:00:00Z',
    updatedAt: '2026-10-31T00:00:00Z',
    sightings: [{ on: 'mesh', layer, geom: { type: 'spoint', p: [0, 0, 0], n: [0, 1, 0] } }],
    source: 'human',
  });

describe('space model', () => {
  it('one space hides the switcher', () => {
    expect(switcherShown(one)).toBe(false);
    expect(switcherShown(two)).toBe(true);
  });

  it('an older project is one main space', () => {
    expect(activeSpaceOf(one, undefined)).toBe('main');
    expect(activeSpaceOf(one, 's-gone')).toBe('main');
  });

  it('a pref naming a gone space falls back to the first', () => {
    expect(activeSpaceOf(two, 's-a')).toBe('s-a');
    expect(activeSpaceOf(two, 'gone')).toBe('main');
  });

  it('a local space has no map view', () => {
    expect(mapAvailable(two, 's-a')).toBe(false);
    expect(mapAvailable(two, 'main')).toBe(true);
    expect(mapAvailable(two, 'missing')).toBe(false);
  });

  it('a project crs the map cannot project still has the map view', () => {
    const plane = ProjectManifest.parse({ ...base, crs: { epsg: 2229 }, layers: [photos('l1')] });
    const wkt = ProjectManifest.parse({
      ...base,
      crs: { wkt: 'PROJCS["Custom grid",GEOGCS["WGS 84"]]' },
      layers: [photos('l1')],
    });
    expect(mapAvailable(plane, 'main')).toBe(true);
    expect(mapAvailable(wkt, 'main')).toBe(true);
  });

  it('a project whose own crs is local has no map, with spaces listed or not', () => {
    const implicit = ProjectManifest.parse({
      ...base,
      crs: { local: 'flyability' },
      layers: [photos('l1')],
    });
    expect(mapAvailable(implicit, 'main')).toBe(false);
    const state = ProjectManifest.parse({ ...base, crs: { epsg: 2229 }, layers: [photos('l1')] });
    expect(mapAvailable(state, 'main')).toBe(true);
  });

  it('lists the layers outside a space', () => {
    expect(offSpaceLayers(two, 's-a')).toEqual(['lm']);
    expect(offSpaceLayers(two, 'main')).toEqual(['la', 'lb']);
  });

  it('switching space hides the other space and restores what was shown', () => {
    const toA = scopeChange(two, 'main', 's-a', {}, {});
    expect(toA.hide).toEqual(['lm']);
    expect(toA.show).toEqual(['la', 'lb']);
    // the user hid lb inside s-a, then goes back to main
    const back = scopeChange(two, 's-a', 'main', { lb: true, lm: true }, toA.memory);
    expect(back.memory['s-a']).toEqual(['lb']);
    expect(back.hide).toEqual(['la', 'lb']);
    expect(back.show).toEqual(['lm']);
    // returning to s-a keeps lb hidden
    const again = scopeChange(two, 'main', 's-a', { la: true, lb: true }, back.memory);
    expect(again.show).toEqual(['la']);
    expect(again.hide).toEqual(['lb', 'lm']);
  });

  it('first entry keeps what is hidden now hidden', () => {
    // lb is hidden (manifest visible:false or a timeline date); first entry must not show it
    const first = scopeChange(two, 'main', 's-a', { lb: true }, {});
    expect(first.show).toEqual(['la']);
    expect(first.hide).toEqual(['lb', 'lm']);
    expect(first.memory['s-a']).toEqual(['lb']);
  });

  it('issues follow the space of their first sighting', () => {
    const all = [issue('i1', 'lm'), issue('i2', 'la'), issue('i3', 'nowhere')];
    expect(issuesInSpace(two, all, 's-a').map((i) => i.id)).toEqual(['i2']);
    expect(issuesInSpace(two, all, 'main').map((i) => i.id)).toEqual(['i1', 'i3']);
    expect(all.filter(inSpace(two, 's-a')).map((i) => i.id)).toEqual(['i2']);
  });
});
