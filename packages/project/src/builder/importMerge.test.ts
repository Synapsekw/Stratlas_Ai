import { parseManifest, type Capture, type Layer, type ProjectManifest } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { mergeImport } from './importMerge';

type Photos = Extract<Layer, { kind: 'photos' }>;

const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const T = [2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 5, 6, 7, 1];

const manifest = (over: Partial<ProjectManifest> = {}): ProjectManifest => ({
  schema: 'aio.project/1',
  id: 'synthetic-site',
  name: 'Synthetic site',
  crs: { epsg: 32639 },
  origin: [500000, 3200000, 30],
  captures: [],
  layers: [],
  severityModels: [],
  classCatalogues: [],
  ...over,
});

const mesh = (id: string, over: Partial<Extract<Layer, { kind: 'mesh' }>> = {}): Layer => ({
  kind: 'mesh',
  id,
  name: id.slice(5),
  visible: true,
  src: { path: `models/${id.slice(5)}.glb` },
  transform: I,
  ...over,
});

const raster = (id: string, path = `rasters/${id.slice(7)}.png`): Layer => ({
  kind: 'raster',
  id,
  name: id.slice(7),
  visible: true,
  src: { path },
  role: 'ortho',
  format: 'image',
});

const cloud = (id: string): Layer => ({
  kind: 'pointcloud',
  id,
  name: `${id.slice(6)}.laz`,
  visible: true,
  src: { path: `clouds/${id.slice(6)}.copc.laz` },
  format: 'copc',
});

const photo = (id: string) => ({ id, src: { path: `photos/${id}.jpg` } });

const photos = (ids: readonly string[], over: Partial<Photos> = {}): Photos => ({
  kind: 'photos',
  id: 'photos',
  name: 'Photos',
  visible: true,
  items: ids.map(photo),
  ...over,
});

const c1: Capture = { id: 'c1', label: 'First survey', date: '2026-01-10' };
const c2: Capture = { id: 'c2', label: 'Second survey', date: '2026-03-10' };
const feb: Capture = { id: 'capture-2026-02-01', label: 'Survey', date: '2026-02-01' };

/** The merge, checked for what every case must hold: a valid manifest, and inputs left alone. */
function merged(base: ProjectManifest, mine: ProjectManifest, fresh: ProjectManifest) {
  const before = structuredClone([base, mine, fresh]);
  const r = mergeImport(base, mine, fresh);
  expect([base, mine, fresh]).toEqual(before);
  const parsed = parseManifest(structuredClone(r.manifest));
  if (!parsed.ok) throw new Error(parsed.error);
  const known = new Set(r.manifest.captures.map((c) => c.id));
  for (const l of r.manifest.layers)
    if (l.capture !== undefined) expect(known).toContain(l.capture);
  return r;
}

const ids = (m: ProjectManifest) => m.layers.map((l) => l.id);
const itemIds = (m: ProjectManifest, id = 'photos') => {
  const l = m.layers.find((x) => x.id === id);
  return l?.kind === 'photos' ? l.items.map((p) => p.id) : null;
};

describe('mergeImport', () => {
  it('answers what the import ended with when nothing else was saved meanwhile', () => {
    // dates out of order, as kit projects have them: the import sorted them when it added one
    const base = manifest({
      captures: [c2, c1],
      layers: [mesh('mesh-m'), photos(['a'])],
      verticalDatum: { absAltOffsetM: 5 },
    });
    const mine = manifest({
      captures: [c1, feb, c2],
      layers: [mesh('mesh-m'), photos(['a', 'b', 'c']), raster('raster-o'), mesh('mesh-n')],
      verticalDatum: { absAltOffsetM: -18.5, note: 'Set at import.' },
    });
    const r = merged(base, mine, structuredClone(base));
    expect(r.manifest).toEqual(mine);
    expect([...r.renamed]).toEqual([]);
  });

  it('answers the project as it is now when the import added nothing', () => {
    const base = manifest({ captures: [c2, c1], layers: [mesh('mesh-m'), photos(['a'])] });
    const fresh = manifest({
      name: 'Renamed',
      captures: [c2, { ...c1, label: 'Baseline' }],
      layers: [mesh('mesh-m', { transform: T }), photos(['a'], { capture: 'c2' })],
    });
    expect(merged(base, structuredClone(base), fresh).manifest).toEqual(fresh);
  });

  it('files its new layers after the layers the project has now, in its own order', () => {
    const base = manifest({ layers: [mesh('mesh-m')] });
    const mine = manifest({ layers: [mesh('mesh-m'), raster('raster-o'), mesh('mesh-n')] });
    // meanwhile: the model was placed, and a conversion the import started filed its cloud
    const fresh = manifest({ layers: [mesh('mesh-m', { transform: T }), cloud('cloud-site')] });
    const r = merged(base, mine, fresh);
    expect(r.manifest.layers).toEqual([
      mesh('mesh-m', { transform: T }),
      cloud('cloud-site'),
      raster('raster-o'),
      mesh('mesh-n'),
    ]);
    expect([...r.renamed]).toEqual([]);
  });

  it('leaves a layer removed meanwhile removed', () => {
    const base = manifest({ layers: [mesh('mesh-m'), mesh('mesh-old')] });
    const mine = manifest({ layers: [mesh('mesh-m'), mesh('mesh-old'), mesh('mesh-n')] });
    const fresh = manifest({ layers: [mesh('mesh-m')] });
    expect(ids(merged(base, mine, fresh).manifest)).toEqual(['mesh-m', 'mesh-n']);
  });

  it('keeps the one layer the project has when its id and file are the ones the import filed', () => {
    // two imports of a file of the same name: both chose `mesh-n` and wrote `models/n.glb`
    const base = manifest({ layers: [mesh('mesh-m')] });
    const mine = manifest({ layers: [mesh('mesh-m'), mesh('mesh-n')] });
    const theirs = mesh('mesh-n', { name: 'Named by the other import', transform: T });
    const fresh = manifest({ layers: [mesh('mesh-m'), theirs] });
    const r = merged(base, mine, fresh);
    expect(r.manifest.layers).toEqual([mesh('mesh-m'), theirs]);
    expect([...r.renamed]).toEqual([]);
  });

  it('files a layer under a free id when its id was taken meanwhile by another file', () => {
    const base = manifest({ layers: [] });
    const mine = manifest({ layers: [raster('raster-o'), mesh('mesh-n')] });
    const theirs = raster('raster-o', 'rasters/o/tiles.json');
    const fresh = manifest({ layers: [theirs, cloud('raster-o-2')] });
    const r = merged(base, mine, fresh);
    expect(r.manifest.layers).toEqual([
      theirs,
      cloud('raster-o-2'),
      { ...raster('raster-o'), id: 'raster-o-3' },
      mesh('mesh-n'),
    ]);
    expect([...r.renamed]).toEqual([['raster-o', 'raster-o-3']]);
  });

  it('files a layer under a free id when a layer of another kind took its id meanwhile', () => {
    const base = manifest({ layers: [] });
    const mine = manifest({ layers: [photos(['a'])] });
    const fresh = manifest({ layers: [mesh('photos', { src: { path: 'models/photos.glb' } })] });
    const r = merged(base, mine, fresh);
    expect(ids(r.manifest)).toEqual(['photos', 'photos-2']);
    expect(itemIds(r.manifest, 'photos-2')).toEqual(['a']);
    expect([...r.renamed]).toEqual([['photos', 'photos-2']]);
  });

  it('appends its photos to the photos layer as the project has it now', () => {
    const base = manifest({ captures: [c1, c2], layers: [photos(['a']), mesh('mesh-m')] });
    const mine = manifest({
      captures: [c1, c2],
      layers: [photos(['a', 'b', 'c']), mesh('mesh-m')],
    });
    // meanwhile: the layer was moved to another date and renamed, and a second writer added `x`
    const fresh = manifest({
      captures: [c1, c2],
      layers: [photos(['a', 'x'], { capture: 'c2', name: 'Drone photos' }), mesh('mesh-m')],
    });
    const r = merged(base, mine, fresh);
    expect(r.manifest.layers).toEqual([
      photos(['a', 'x', 'b', 'c'], { capture: 'c2', name: 'Drone photos' }),
      mesh('mesh-m'),
    ]);
  });

  it('lists a photo once when the layer got one of the same id meanwhile', () => {
    const base = manifest({ layers: [photos(['a'])] });
    const mine = manifest({ layers: [photos(['a', 'b', 'c'])] });
    const theirs = { ...photo('b'), takenAt: '2026-02-01T09:00:00+00:00' };
    const fresh = manifest({ layers: [{ ...photos(['a']), items: [photo('a'), theirs] }] });
    const r = merged(base, mine, fresh);
    expect(r.manifest.layers).toEqual([{ ...photos([]), items: [photo('a'), theirs, photo('c')] }]);
  });

  it('leaves a photo removed from the layer meanwhile removed', () => {
    const base = manifest({ layers: [photos(['a', 'b'])] });
    const mine = manifest({ layers: [photos(['a', 'b', 'c'])] });
    const fresh = manifest({ layers: [photos(['b'])] });
    expect(itemIds(merged(base, mine, fresh).manifest)).toEqual(['b', 'c']);
  });

  it('joins the photos layer another writer made meanwhile, when it had none at its start', () => {
    const base = manifest({ layers: [mesh('mesh-m')] });
    const mine = manifest({ layers: [mesh('mesh-m'), photos(['a', 'b'])] });
    const fresh = manifest({
      captures: [c1],
      layers: [mesh('mesh-m'), photos(['x', 'a'], { capture: 'c1' })],
    });
    const r = merged(base, mine, fresh);
    expect(r.manifest.layers).toEqual([mesh('mesh-m'), photos(['x', 'a', 'b'], { capture: 'c1' })]);
    expect([...r.renamed]).toEqual([]);
  });

  it('lists its photos in a photos layer of their own when the layer was removed meanwhile', () => {
    const base = manifest({ layers: [photos(['a'], { name: 'Drone photos' }), mesh('mesh-m')] });
    const mine = manifest({
      layers: [photos(['a', 'b', 'c'], { name: 'Drone photos' }), mesh('mesh-m'), mesh('mesh-n')],
    });
    const fresh = manifest({ layers: [mesh('mesh-m')] });
    const r = merged(base, mine, fresh);
    // the photos that were removed stay removed; the files this import copied are listed
    expect(r.manifest.layers).toEqual([
      mesh('mesh-m'),
      photos(['b', 'c'], { name: 'Drone photos' }),
      mesh('mesh-n'),
    ]);
  });

  it('adds its survey dates and leaves a date renamed meanwhile as it is', () => {
    const base = manifest({ captures: [c1, c2] });
    const mine = manifest({ captures: [c1, feb, c2], layers: [mesh('mesh-n')] });
    const baseline = { ...c1, label: 'Baseline', colour: 3 };
    const fresh = manifest({ captures: [baseline, c2] });
    expect(merged(base, mine, fresh).manifest.captures).toEqual([baseline, feb, c2]);
  });

  it('keeps the date the project has when both added the same one', () => {
    const base = manifest({ captures: [c1, c2] });
    const mine = manifest({ captures: [c1, feb, c2] });
    const handover = { ...feb, label: 'Handover', icon: 'flag' };
    const fresh = manifest({ captures: [c1, handover, c2] });
    expect(merged(base, mine, fresh).manifest.captures).toEqual([c1, handover, c2]);
  });

  it('adds no second date for a day the project has a date for by now', () => {
    const base = manifest({ captures: [c1, c2] });
    const mine = manifest({ captures: [c1, feb, c2] });
    const theirs: Capture = { id: 'epoch-2', label: 'Drone survey', date: '2026-02-01' };
    const fresh = manifest({ captures: [c1, c2, theirs] });
    // sorted all the same: the import added a date, as it would have on this list
    expect(merged(base, mine, fresh).manifest.captures).toEqual([c1, theirs, c2]);
  });

  it('sorts the dates of the merged list by day, dates of one day in the order they had', () => {
    const late: Capture = { id: 'late', label: 'Late', date: '2026-03-10' };
    const early: Capture = { id: 'early', label: 'Early', date: '2026-01-10' };
    const base = manifest({ captures: [c2, c1] });
    const mine = manifest({ captures: [c1, feb, c2] });
    const fresh = manifest({ captures: [late, c2, c1, early] });
    expect(merged(base, mine, fresh).manifest.captures).toEqual([c1, early, feb, late, c2]);
  });

  it('leaves the order of the dates alone when the import added none', () => {
    const base = manifest({ captures: [c2, c1] });
    const mine = manifest({ captures: [c2, c1], layers: [mesh('mesh-n')] });
    const fresh = manifest({ captures: [c2, feb, c1] });
    expect(merged(base, mine, fresh).manifest.captures).toEqual([c2, feb, c1]);
  });

  it('has every survey date a layer of the import names', () => {
    // a new date named by a new layer is added by its id, also when the day has a date by now
    const theirs: Capture = { id: 'epoch-2', label: 'Drone survey', date: '2026-02-01' };
    const named = mesh('mesh-n', { capture: feb.id });
    const a = merged(
      manifest({ captures: [c1] }),
      manifest({ captures: [c1, feb], layers: [named] }),
      manifest({ captures: [c1, theirs] }),
    );
    expect(a.manifest.captures).toEqual([c1, theirs, feb]);
    expect(a.manifest.layers).toEqual([named]);

    // a date the photos layer had, removed meanwhile with the layer, comes back with the new photos
    const b = merged(
      manifest({ captures: [c1, c2], layers: [photos(['a'], { capture: 'c2' })] }),
      manifest({ captures: [c1, c2], layers: [photos(['a', 'b'], { capture: 'c2' })] }),
      manifest({ captures: [c1] }),
    );
    expect(b.manifest.captures).toEqual([c1, c2]);
    expect(b.manifest.layers).toEqual([photos(['b'], { capture: 'c2' })]);

    // a date nobody has: the layer is filed without it (its date is then worked out from names)
    const c = merged(
      manifest({ captures: [c1] }),
      manifest({ captures: [c1], layers: [mesh('mesh-n', { capture: 'gone' })] }),
      manifest({ captures: [c1] }),
    );
    expect(c.manifest.layers).toEqual([mesh('mesh-n')]);
  });

  describe('the vertical datum', () => {
    const set = { absAltOffsetM: -18.5, note: 'Set at import.' };
    const layers = [photos(['a'])];
    const datum = (
      base: ProjectManifest['verticalDatum'],
      mine: ProjectManifest['verticalDatum'],
      fresh: ProjectManifest['verticalDatum'],
    ) =>
      merged(
        manifest(base ? { verticalDatum: base } : {}),
        manifest({ layers, ...(mine ? { verticalDatum: mine } : {}) }),
        manifest(fresh ? { verticalDatum: fresh } : {}),
      ).manifest;

    it('is the one set at the import when the project has none', () => {
      expect(datum(undefined, set, undefined).verticalDatum).toEqual(set);
      expect(datum({ absAltOffsetM: 5 }, set, undefined).verticalDatum).toEqual(set);
    });

    it('is the one set at the import when the project still has the one the import started with', () => {
      expect(datum({ absAltOffsetM: 5 }, set, { absAltOffsetM: 5 }).verticalDatum).toEqual(set);
    });

    it('stays the same when the project got the same one meanwhile', () => {
      expect(datum(undefined, set, { ...set }).verticalDatum).toEqual(set);
    });

    it('is the one the project has when another one was saved meanwhile', () => {
      const other = { absAltOffsetM: 100, note: 'Plant level' };
      expect(datum(undefined, set, other).verticalDatum).toEqual(other);
      expect(datum({ absAltOffsetM: 5 }, set, other).verticalDatum).toEqual(other);
      // the same offset under another note is another datum
      const renoted = { absAltOffsetM: -18.5, note: 'Checked on site' };
      expect(datum(undefined, set, renoted).verticalDatum).toEqual(renoted);
    });

    it('is the one the project has when the import set none', () => {
      const five = { absAltOffsetM: 5 };
      const other = { absAltOffsetM: 100 };
      expect(datum(five, five, other).verticalDatum).toEqual(other);
      expect(datum(undefined, undefined, other).verticalDatum).toEqual(other);
      expect('verticalDatum' in datum(five, five, undefined)).toBe(false);
    });
  });

  it('answers every other field as the project has it now, also keys this build does not know', () => {
    const base = manifest({ captures: [c1], layers: [mesh('mesh-m')] });
    const mine = manifest({ captures: [c1, feb], layers: [mesh('mesh-m'), mesh('mesh-n')] });
    const fresh = {
      ...manifest({
        name: 'Renamed meanwhile',
        customer: 'Synthetic owner',
        origin: [500010, 3200020, 31],
        aiCloudDrawings: true,
        captures: [{ ...c1, later: { by: 'a newer build' } } as Capture],
        layers: [mesh('mesh-m', { visible: false, tags: [{ node: 'n1', tag: 'P-101' }] })],
      }),
      // written by a newer build
      review: { state: 'open', notes: [1, 'two'] },
    };
    const r = merged(base, mine, fresh);
    expect(r.manifest).toEqual({
      ...fresh,
      captures: [...fresh.captures, feb],
      layers: [...fresh.layers, mesh('mesh-n')],
    });
    expect(Object.keys(r.manifest)).toEqual(Object.keys(fresh));
  });
});
