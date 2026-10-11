/**
 * What a file import saves when it ends: what it added, on the manifest as it is by then.
 *
 * An import reads the manifest when it starts and works on its own copy for as long as the files
 * take (minutes). Saving that copy put the project back to how it was at the start: a survey date
 * renamed meanwhile, a dataset moved to another date, the layer a conversion job had filed. So
 * the import keeps the manifest as it read it, and at its end only its own additions are put onto
 * a fresh read. Pure: no file access.
 */
import type { AssetRef, Layer, ProjectManifest, VerticalDatum } from '@aio/schema';
import { byDate, uniqueId } from './create';

export interface ImportMerge {
  /** The manifest to save. */
  manifest: ProjectManifest;
  /** Layers saved under another id than the import gave them: the import's id, the saved id. */
  renamed: ReadonlyMap<string, string>;
}

const sameDatum = (a: VerticalDatum | undefined, b: VerticalDatum | undefined) =>
  (a === undefined) === (b === undefined) &&
  a?.absAltOffsetM === b?.absAltOffsetM &&
  a?.note === b?.note;

const sameRef = (a: AssetRef, b: AssetRef) =>
  'path' in a ? 'path' in b && a.path === b.path : 'hash' in b && a.hash === b.hash;

/** Two layers of one kind that show the same file. */
const sameFile = (a: Layer, b: Layer) =>
  a.kind === b.kind && 'src' in a && 'src' in b && sameRef(a.src, b.src);

/**
 * The manifest an import saves: `fresh` (the manifest read in the turn of the save) with what the
 * import added between `base` (the manifest as the import read it at its start, untouched) and
 * `mine` (the import's copy at its end). An import only adds (layers, photos to the photos layer,
 * survey dates) and may set the vertical datum; whatever else `fresh` holds is answered as it is.
 * With nothing saved meanwhile (`fresh` equal to `base`) the answer is `mine`.
 *
 * Layers:
 * - A layer the import added (its id is not in `base`) that `fresh` does not have is appended
 *   after the layers of `fresh`, in the import's order.
 * - A layer the import added whose id `fresh` has by now. The import's ids (`photos`, `mesh-`,
 *   `clip-`, `raster-` and the file name) are ones only an import chooses: the processing tools
 *   file their layers as `cloud-`, `plan-`, `drawing-`, `ortho-`, `dsm-` and `photos-<run>`, so
 *   the import's own conversion jobs never take one. What does is a second import into the same
 *   project at the same time (the import panel runs one at a time, so it takes another caller)
 *   that brought a file of the same name: it chose the same id and, since the path in the
 *   project comes from the id, wrote the same file.
 *   - Both are photos layers: the import's photos are appended to the one in `fresh`, as below.
 *   - Same kind and same file: the layer in `fresh` stays as it is and the import's is not filed;
 *     it would show the one file on disk a second time.
 *   - Anything else (another kind, another file): both are kept, the import's under the first
 *     free id (`uniqueId`), told in `renamed` so the import's report names the layer it saved.
 * - Photos the import appended to a photos layer that was in `base` (the ones whose id `base`'s
 *   copy of the layer does not have) are appended to that layer as `fresh` has it: its name, its
 *   survey date and its photos now, also ones added or removed meanwhile. A photo `fresh` has
 *   under the same id is not listed twice (it names the same file).
 *   When `fresh` no longer has that layer, the new photos are filed in a photos layer of their
 *   own, like a new layer: their files are in the project, and the photos removed with the old
 *   layer stay removed.
 * - A layer of `base` that `fresh` no longer has stays removed, and a layer of `base` is never put
 *   back to how the import knew it.
 *
 * Survey dates:
 * - A date the import added is added when `fresh` has none with that id. One with that id stays
 *   as `fresh` has it (it may have been renamed).
 * - It is not added either when `fresh` has a date for that day under another id (a job that
 *   ended meanwhile wrote its own): the import adds a date for a day that has none
 *   (`captureForDate`), and the day is not listed twice.
 * - A date one of the layers the import filed names is always there afterwards: added from `mine`
 *   by its id (also for a day that has a date by now, and also a date of `base` that was removed
 *   meanwhile). Should `mine` not have it either, the layer is filed without the date.
 * - When the import added a date, the merged list is put in date order as `captureForDate` does
 *   (same comparison, stable: dates of one day stay in the order they had). Otherwise the order
 *   is left alone, as an import that adds no date leaves it.
 *
 * The vertical datum is `mine`'s only when the import set one (it differs from `base`'s) and
 * `fresh` has none or still the one of `base`. A datum saved meanwhile stands: the import's files
 * were placed with the one it set, which its report shows.
 *
 * Every other field of `fresh`, top-level or inside a layer or a date, is answered as it is, also
 * keys this build does not know.
 */
export function mergeImport(
  base: ProjectManifest,
  mine: ProjectManifest,
  fresh: ProjectManifest,
): ImportMerge {
  const before = new Map(base.layers.map((l) => [l.id, l]));
  const layers = [...fresh.layers];
  const renamed = new Map<string, string>();
  /** Ids (as saved) of the layers appended here: the ones whose survey date must exist. */
  const filed = new Set<string>();
  const taken = (id: string) =>
    layers.some((l) => l.id === id) || mine.layers.some((l) => l.id === id);

  const file = (l: Layer): void => {
    const at = layers.findIndex((x) => x.id === l.id);
    const there = layers[at];
    if (there === undefined) {
      layers.push(l);
      filed.add(l.id);
      return;
    }
    if (l.kind === 'photos' && there.kind === 'photos') {
      const has = new Set(there.items.map((p) => p.id));
      const more = l.items.filter((p) => !has.has(p.id));
      if (more.length > 0) layers[at] = { ...there, items: [...there.items, ...more] };
      return;
    }
    if (sameFile(l, there)) return;
    const id = uniqueId(l.id, taken);
    renamed.set(l.id, id);
    layers.push({ ...l, id });
    filed.add(id);
  };

  for (const l of mine.layers) {
    const was = before.get(l.id);
    if (was === undefined) file(l);
    else if (l.kind === 'photos' && was.kind === 'photos') {
      const had = new Set(was.items.map((p) => p.id));
      const added = l.items.filter((p) => !had.has(p.id));
      if (added.length > 0) file({ ...l, items: added });
    }
  }

  const captures = [...fresh.captures];
  const hasDate = (id: string) => captures.some((c) => c.id === id);
  const named = new Set<string>();
  for (const l of layers) if (filed.has(l.id) && l.capture !== undefined) named.add(l.capture);
  const known = new Set(base.captures.map((c) => c.id));
  const added = mine.captures.filter((c) => !known.has(c.id));
  let sort = added.length > 0;
  for (const c of added) {
    if (hasDate(c.id)) continue;
    if (!named.has(c.id) && captures.some((k) => k.date === c.date)) continue;
    captures.push(c);
  }
  for (const id of named) {
    if (hasDate(id)) continue;
    const c = mine.captures.find((k) => k.id === id);
    if (c === undefined) continue;
    captures.push(c);
    sort = true;
  }
  if (sort) captures.sort(byDate);
  layers.forEach((l, i) => {
    if (!filed.has(l.id) || l.capture === undefined || hasDate(l.capture)) return;
    const next = { ...l };
    delete next.capture;
    layers[i] = next;
  });

  const datum = mine.verticalDatum;
  const setHere =
    datum !== undefined &&
    !sameDatum(datum, base.verticalDatum) &&
    (fresh.verticalDatum === undefined || sameDatum(fresh.verticalDatum, base.verticalDatum));
  return {
    manifest: { ...fresh, captures, layers, ...(setHere ? { verticalDatum: datum } : {}) },
    renamed,
  };
}
