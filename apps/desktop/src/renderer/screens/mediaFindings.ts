/**
 * Findings per photo for the Media screen: the issues marked on each photo (photo sightings) and
 * the detections of the review passes on it (accepted or waiting, never rejected). Built once per
 * change of the issues, the detections or the manifest, then read per tile: a count, the worst
 * severity and its colour, and the shapes to draw on the thumbnail.
 */
import type { Detection } from '@aio/annotate/detections';
import type { Issue, ProjectManifest, SeverityModel } from '@aio/schema';
import type { MarkGeom } from '../issueCard/model';

const NEUTRAL = '#8a94a6';

export interface FindingShape {
  geom: MarkGeom;
  /** Pixel grid of `geom` ([1, 1] normalized); null: the photo file's pixels. */
  grid: [number, number] | null;
  color: string;
  draft: boolean;
}

export interface PhotoFindings {
  /** Issues marked on the photo. */
  issues: number;
  /** Detections on the photo that are not already one of those issues. */
  detections: number;
  /** Detections still waiting for review. */
  drafts: number;
  /** Issues plus detections. */
  count: number;
  /** Worst severity rank: a level's value; uncertain 0.5; a detection without a grade 0.25. */
  rank: number;
  /** Colour of the worst finding. */
  color: string;
  /** Severity label of the worst finding (empty when not graded). */
  label: string;
  /** Issue ids on the photo, worst first. */
  issueIds: string[];
  /** Boxes, outlines and points to draw (masks are not drawn on thumbnails). */
  shapes: FindingShape[];
}

export const photoKey = (layer: string, photo: string) => `${layer}/${photo}`;

function rankOf(sev: number | 'uncertain' | null): number {
  if (sev === null) return 0.25;
  return sev === 'uncertain' ? 0.5 : sev;
}

function levelOf(model: SeverityModel | undefined, sev: number | 'uncertain' | null) {
  if (!model || sev === null) return null;
  if (sev === 'uncertain')
    return model.uncertain ? { color: model.uncertain.color, label: model.uncertain.label } : null;
  const l = model.levels.find((x) => x.value === sev);
  return l ? { color: l.color, label: l.label } : null;
}

/** Findings per photo, keyed `<layer>/<photo>`; photos without findings are absent. */
export function findingsIndex(
  manifest: Pick<ProjectManifest, 'severityModels' | 'classCatalogues'>,
  issues: readonly Issue[],
  detections: readonly Detection[] = [],
): Map<string, PhotoFindings> {
  const models = new Map(manifest.severityModels.map((m) => [m.id, m]));
  const classes = new Map(
    manifest.classCatalogues.flatMap((c) => c.classes).map((k) => [k.id, k] as const),
  );
  const out = new Map<string, PhotoFindings & { ranked: { id: string; rank: number }[] }>();
  const entry = (key: string) => {
    let e = out.get(key);
    if (!e) {
      e = {
        issues: 0,
        detections: 0,
        drafts: 0,
        count: 0,
        rank: -1,
        color: NEUTRAL,
        label: '',
        issueIds: [],
        shapes: [],
        ranked: [],
      };
      out.set(key, e);
    }
    return e;
  };
  const worse = (
    e: PhotoFindings,
    rank: number,
    lv: { color: string; label: string } | null,
    fallback: string,
  ) => {
    if (rank <= e.rank) return;
    e.rank = rank;
    e.color = lv?.color ?? fallback;
    e.label = lv?.label ?? '';
  };
  /** Photos each issue is on, so a detection already made into that issue is not counted twice. */
  const onPhoto = new Set<string>();

  for (const issue of issues) {
    const lv = levelOf(models.get(issue.severityModelId), issue.severity);
    const color = lv?.color ?? NEUTRAL;
    const seen = new Set<string>();
    for (const s of issue.sightings) {
      if (s.on !== 'image') continue;
      const key = photoKey(s.layer, s.photo);
      const e = entry(key);
      if (!seen.has(key)) {
        seen.add(key);
        onPhoto.add(`${issue.id}@${key}`);
        e.issues += 1;
        e.ranked.push({ id: issue.id, rank: rankOf(issue.severity) });
        worse(e, rankOf(issue.severity), lv, color);
      }
      if (s.geom.type !== 'mask')
        e.shapes.push({ geom: s.geom, grid: null, color, draft: issue.status === 'draft' });
    }
  }

  for (const d of detections) {
    if (d.status === 'rejected' || d.source.kind !== 'photo') continue;
    const key = photoKey(d.source.layer, d.source.photo);
    if (d.issueId && onPhoto.has(`${d.issueId}@${key}`)) continue;
    const cls = classes.get(d.classId);
    const model = cls ? models.get(cls.severityModel) : undefined;
    const sev = d.uncertain ? 'uncertain' : d.severity;
    const lv = levelOf(model, sev);
    const color = lv?.color ?? cls?.color ?? NEUTRAL;
    const e = entry(key);
    e.detections += 1;
    if (d.status === 'draft') e.drafts += 1;
    worse(e, rankOf(sev), lv, color);
    e.shapes.push({ geom: d.geom, grid: d.size, color, draft: d.status === 'draft' });
  }

  const done = new Map<string, PhotoFindings>();
  for (const [key, { ranked, ...e }] of out) {
    done.set(key, {
      ...e,
      count: e.issues + e.detections,
      issueIds: ranked.sort((a, b) => b.rank - a.rank).map((r) => r.id),
    });
  }
  return done;
}

export type PhotoOrder = 'file' | 'count' | 'severity';

/**
 * Photos of a set filtered to those with findings (`only`) and ordered: as in the set, most
 * findings first, or worst severity first. Ties keep the set's order.
 */
export function orderPhotos<T extends { id: string }>(
  items: readonly T[],
  layer: string,
  index: ReadonlyMap<string, PhotoFindings>,
  only: boolean,
  order: PhotoOrder,
): T[] {
  const f = (p: T) => index.get(photoKey(layer, p.id));
  const kept = only ? items.filter((p) => f(p) !== undefined) : [...items];
  if (order === 'file') return kept;
  const score = (p: T): [number, number] => {
    const x = f(p);
    if (!x) return [-1, -1];
    return order === 'count' ? [x.count, x.rank] : [x.rank, x.count];
  };
  return kept
    .map((p, i) => ({ p, i, s: score(p) }))
    .sort((a, b) => b.s[0] - a.s[0] || b.s[1] - a.s[1] || a.i - b.i)
    .map((x) => x.p);
}

/** Shapes scaled to the photo's pixels (detections come in their own grid). */
export function shapesInPhoto(
  shapes: readonly FindingShape[],
  size: readonly [number, number],
): FindingShape[] {
  return shapes.map((s) => {
    if (!s.grid || (s.grid[0] === size[0] && s.grid[1] === size[1])) return s;
    const kx = size[0] / s.grid[0];
    const ky = size[1] / s.grid[1];
    const g = s.geom;
    let geom: MarkGeom;
    switch (g.type) {
      case 'box':
        geom = { ...g, x: g.x * kx, y: g.y * ky, w: g.w * kx, h: g.h * ky };
        break;
      case 'rotbox':
        geom = { ...g, x: g.x * kx, y: g.y * ky, w: g.w * kx, h: g.h * ky };
        break;
      case 'polygon':
        geom = { ...g, points: g.points.map(([x, y]) => [x * kx, y * ky] as [number, number]) };
        break;
      case 'point':
        geom = { ...g, x: g.x * kx, y: g.y * ky };
        break;
    }
    return { ...s, geom, grid: null };
  });
}
