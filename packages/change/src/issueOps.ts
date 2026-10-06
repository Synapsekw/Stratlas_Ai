import type {
  ChangeItem,
  ChangeSet,
  ImageGeom,
  Issue,
  ProjectManifest,
  Sighting,
} from '@aio/schema';

/**
 * What a person's decision on a change item does to issues. Nothing here runs on its own: the
 * Changes panel calls these only when a person confirms (founder decision 3).
 */

/** "Resolved" confirmed by a person: the issue is closed on the later date. */
export function closeResolved(issue: Issue, to: string, now: string): Issue {
  return { ...issue, status: 'closed', resolvedIn: to, updatedAt: now };
}

/**
 * A confirmed match: both issues share one `track` (the earlier one's, else the later one's, else
 * a new one) and carry their dates.
 */
export function trackPair(
  earlier: Issue | undefined,
  later: Issue | undefined,
  dates: { from: string; to: string },
  now: string,
  newTrack: () => string,
): { earlier?: Issue; later?: Issue; track: string } {
  const track = earlier?.track ?? later?.track ?? newTrack();
  const set = (i: Issue, capture: string): Issue =>
    i.track === track && i.capture === capture
      ? i
      : { ...i, track, capture: i.capture ?? capture, updatedAt: now };
  return {
    track,
    ...(earlier ? { earlier: set(earlier, dates.from) } : {}),
    ...(later ? { later: set(later, dates.to) } : {}),
  };
}

/** Whether "Make issue" applies: the item shows something on the later date and has no issue. */
export function canMakeIssue(item: ChangeItem): boolean {
  if (item.review?.issueId) return false;
  if (item.kind === 'issue') return false; // the later date's issue is already there
  return !['removed', 'resolved', 'not-seen', 'unchanged'].includes(item.verdict);
}

export interface DraftContext {
  set: Pick<ChangeSet, 'from' | 'to'>;
  manifest: Pick<ProjectManifest, 'layers' | 'classCatalogues' | 'severityModels'>;
  existingCodes: readonly string[];
  author: string;
  now: string;
  id: string;
  /** Vector items: the feature's geometry on the later date (GeoJSON, lon/lat). */
  geometry?: Record<string, unknown> | null;
  /** Detection items: one of the later date's detections as an image sighting. */
  detection?: { layer: string; photo: string; geom: ImageGeom } | null;
  /** Layer for 3D sightings (the later date's model), when the item names none. */
  meshLayer?: string | null;
}

function nextCode(codes: readonly string[], prefix = 'F'): string {
  let max = 0;
  for (const c of codes) {
    if (!c.startsWith(prefix)) continue;
    const n = Number(c.slice(prefix.length));
    if (Number.isInteger(n) && n > max) max = n;
  }
  return `${prefix}${String(max + 1).padStart(2, '0')}`;
}

function sightingFor(item: ChangeItem, ctx: DraftContext): Sighting | null {
  if (item.kind === 'vector' && ctx.geometry) {
    const layer = item.layerTo ?? item.layerFrom;
    if (layer) return { on: 'map', layer, geojson: ctx.geometry };
  }
  if (item.kind === 'detection' && ctx.detection)
    return {
      on: 'image',
      layer: ctx.detection.layer,
      photo: ctx.detection.photo,
      geom: ctx.detection.geom,
    };
  if (item.kind === 'region') {
    if (item.outline && item.layer)
      return {
        on: 'map',
        layer: item.layer,
        geojson: { type: 'Polygon', coordinates: [item.outline] },
      };
    const layer = ctx.meshLayer;
    if (item.outlineLocal && layer)
      return { on: 'mesh', layer, geom: { type: 'spolygon', points: item.outlineLocal } };
  }
  const layer = (item.kind === 'component' ? item.layerTo : undefined) ?? ctx.meshLayer;
  if (item.at && layer)
    return { on: 'mesh', layer, geom: { type: 'spoint', p: item.at, n: [0, 1, 0] } };
  return null;
}

/**
 * A draft issue made from a change item: its sighting on the later date, the later capture and a
 * track of its own. Errors say what is missing.
 */
export function draftFromChange(
  item: ChangeItem,
  ctx: DraftContext,
): { ok: true; issue: Issue } | { ok: false; error: string } {
  const sighting = sightingFor(item, ctx);
  if (!sighting)
    return { ok: false, error: 'This change has no place on the later date to put an issue.' };
  const classes = ctx.manifest.classCatalogues.flatMap((c) => c.classes);
  const wanted = 'classId' in item ? item.classId : undefined;
  const cls = classes.find((c) => c.id === wanted) ?? classes[0];
  if (!cls) return { ok: false, error: 'This project has no issue classes yet.' };
  const model = ctx.manifest.severityModels.find((m) => m.id === cls.severityModel);
  const level = model?.levels[0]?.value;
  if (level === undefined)
    return { ok: false, error: `The class ${cls.label} has no severity levels.` };
  const title = item.label ?? `${item.kind} ${item.verdict}`;
  return {
    ok: true,
    issue: {
      id: ctx.id,
      code: nextCode(ctx.existingCodes),
      classId: cls.id,
      severityModelId: cls.severityModel,
      severity: level,
      status: 'draft',
      title: title.slice(0, 200),
      note: `Made from a change between two surveys (${item.verdict}).`,
      author: ctx.author,
      createdAt: ctx.now,
      updatedAt: ctx.now,
      sightings: [sighting],
      source: 'human',
      capture: ctx.set.to,
      track: ctx.id,
    },
  };
}
