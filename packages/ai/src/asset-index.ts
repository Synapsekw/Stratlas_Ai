/**
 * Which asset and area each finding sits on. The tagged assets are mesh nodes; their bounding
 * boxes come from the live 3D scene, which is not mounted on Media or Issues, so the boxes are
 * remembered per project. A project whose boxes were never measured is "loading", never "empty":
 * the agent says the model is still loading instead of answering that an asset has no findings.
 */
import type { Issue, Vec3 } from '@aio/schema';
import {
  boxCentre,
  boxOfPoints,
  issuePoints,
  placeIndex,
  resolveName,
  type PlaceBox,
} from './places';
import { issueRow, project, round1, ToolError, type RendererToolContext } from './tool-kit';

export interface AssetBox {
  tag: string;
  area?: string;
  box: PlaceBox;
}

export interface AssetLink {
  asset: string;
  area?: string;
  how: 'inside' | 'near';
  distanceM: number;
}

export interface AssetIndex {
  /** none: the project has no tagged assets. loading: it has, but their bounds are not known yet. */
  status: 'ready' | 'loading' | 'none';
  boxes: readonly AssetBox[];
  /** Issue id to its asset. An issue that is absent has no asset. */
  links: ReadonlyMap<string, AssetLink>;
  /** Ids of issues with no 3D point (marked on a photo or a map only). */
  unplaced: readonly string[];
}

/** A point this close to a box on every axis counts as inside it (survey and model noise). */
export const ASSET_SLACK_M = 0.5;
/** A point farther than this from every box belongs to no asset. */
export const ASSET_NEAR_M = 5;

const volume = ({ min, max }: PlaceBox) =>
  Math.max(0, max[0] - min[0]) * Math.max(0, max[1] - min[1]) * Math.max(0, max[2] - min[2]);

/** Euclidean distance from a point to a box, 0 when the point is inside it. */
function distanceToBox(p: Vec3, { min, max }: PlaceBox): number {
  let sum = 0;
  for (let i = 0; i < 3; i++) {
    const v = p[i] ?? 0;
    const d = Math.max((min[i] ?? 0) - v, 0, v - (max[i] ?? 0));
    sum += d * d;
  }
  return Math.sqrt(sum);
}

function linkOf(b: AssetBox, how: AssetLink['how'], distanceM: number): AssetLink {
  return { asset: b.tag, ...(b.area ? { area: b.area } : {}), how, distanceM };
}

/** Pure: the smallest box that contains p (with slack), else the nearest within nearM, else null. */
export function assetOfPoint(p: Vec3, boxes: readonly AssetBox[]): AssetLink | null {
  let inside: AssetBox | null = null;
  let insideVolume = Infinity;
  let near: AssetBox | null = null;
  let nearDistance = Infinity;
  for (const b of boxes) {
    const containing = [0, 1, 2].every(
      (i) =>
        (p[i] ?? 0) >= (b.box.min[i] ?? 0) - ASSET_SLACK_M &&
        (p[i] ?? 0) <= (b.box.max[i] ?? 0) + ASSET_SLACK_M,
    );
    if (containing) {
      const v = volume(b.box);
      // strictly smaller: a tie keeps the earlier tag
      if (v < insideVolume) {
        inside = b;
        insideVolume = v;
      }
      continue;
    }
    const d = distanceToBox(p, b.box);
    if (d <= ASSET_NEAR_M && d < nearDistance) {
      near = b;
      nearDistance = d;
    }
  }
  if (inside) return linkOf(inside, 'inside', 0);
  if (near) return linkOf(near, 'near', round1(nearDistance));
  return null;
}

// The cache ----------------------------------------------------------------------------------

interface Remembered {
  /**
   * The tag names the project had when the boxes were measured; other names drop them. The names
   * and not their number: a tag that is renamed would otherwise stay behind as an asset.
   */
  tags: string;
  boxes: AssetBox[];
}

const remembered = new Map<string, Remembered>();

/** Forget remembered bounds (tests, and a project that changed its tags). */
export function clearAssetCache(): void {
  remembered.clear();
}

/** The tag names of the open project, every model's. */
function tagNames(ctx: RendererToolContext): string[] {
  return project(ctx).manifest.layers.flatMap((l) =>
    l.kind === 'mesh' ? (l.tags ?? []).map((t) => t.tag) : [],
  );
}

/** The point an issue sits at: the centre of the box around its 3D sightings. */
function pointOf(issue: Issue): Vec3 | null {
  const box = boxOfPoints(issuePoints(issue));
  return box ? boxCentre(box) : null;
}

/** The index of the open project. Bounds are measured in the scene when it is there and remembered per project. */
export function assetIndex(ctx: RendererToolContext): AssetIndex {
  const { id } = project(ctx);
  const names = tagNames(ctx);
  // the same key whatever the order of the tags in the manifest
  const tags = JSON.stringify([...names].sort());
  const issues = ctx.workspace.getState().issues;
  const unplaced = issues.filter((i) => issuePoints(i).length === 0).map((i) => i.id);
  if (names.length === 0) {
    remembered.delete(id);
    return { status: 'none', boxes: [], links: new Map(), unplaced };
  }

  const measured: AssetBox[] = [];
  for (const place of placeIndex(ctx, { measure: true })) {
    if (place.kind !== 'asset' || !place.box) continue;
    measured.push({
      tag: place.name,
      ...(place.detail ? { area: place.detail } : {}),
      box: place.box,
    });
  }
  // a model still streaming in gives boxes for some nodes only: what was measured now wins, the
  // rest stays as remembered, so a node that has not arrived yet does not look like an empty asset
  const kept = remembered.get(id);
  if (kept && kept.tags !== tags) remembered.delete(id);
  const merged = new Map<string, AssetBox>();
  if (kept?.tags === tags) for (const b of kept.boxes) merged.set(b.tag, b);
  for (const b of measured) merged.set(b.tag, b);
  const boxes = [...merged.values()];
  if (boxes.length === 0) return { status: 'loading', boxes: [], links: new Map(), unplaced };
  remembered.set(id, { tags, boxes });

  const links = new Map<string, AssetLink>();
  for (const issue of issues) {
    const p = pointOf(issue);
    const link = p ? assetOfPoint(p, boxes) : null;
    if (link) links.set(issue.id, link);
  }
  return { status: 'ready', boxes, links, unplaced };
}

// Asking by name -----------------------------------------------------------------------------

const loadingError = () =>
  new ToolError(
    'The 3D model is still loading, so findings cannot be matched to assets yet. Open Scene and try again in a moment.',
  );

/** "selection", a tag or an area name to the issue ids on it. Throws ToolError when loading or unknown. */
export function issuesOn(
  ctx: RendererToolContext,
  where: string,
): { label: string; ids: string[]; unplaced: number } {
  const index = assetIndex(ctx);
  if (index.status === 'loading') throw loadingError();
  if (index.status === 'none') throw new ToolError('This project has no tagged assets.');

  let match: (link: AssetLink) => boolean;
  let label: string;
  if (where === 'selection') {
    const sel = ctx.workspace.getState().selection;
    if (sel?.kind !== 'asset') {
      throw new ToolError(
        'Nothing is selected that findings can sit on. Name an asset or an area.',
      );
    }
    // the selection carries the tag, or the model node the tag sits on
    const tags = project(ctx).manifest.layers.flatMap((l) =>
      l.kind === 'mesh' ? (l.tags ?? []) : [],
    );
    label = tags.find((t) => t.tag === sel.id || t.node === sel.id)?.tag ?? sel.id;
    if (!index.boxes.some((b) => b.tag === label)) throw loadingError();
    match = (link) => link.asset === label;
  } else {
    const place = resolveName(ctx, where, ['asset', 'group']);
    label = place.name;
    // a named part of the model that carries no tag is a place too, but findings are matched to
    // tagged assets only: its bounds are never measured, so "still loading" would never end
    if (place.kind === 'asset' && !tagNames(ctx).includes(place.name)) {
      throw new ToolError(
        `${place.name} is not a tagged asset, so findings are not matched to it.`,
      );
    }
    // never answer for bounds that are not known: no box is "not measured yet", not "no findings"
    const known =
      place.kind === 'group'
        ? index.boxes.some((b) => b.area === place.name)
        : index.boxes.some((b) => b.tag === place.name);
    if (!known) throw loadingError();
    match =
      place.kind === 'group' ? (link) => link.area === place.name : (link) => link.asset === label;
  }
  const ids = ctx.workspace
    .getState()
    .issues.filter((i) => {
      const link = index.links.get(i.id);
      return link !== undefined && match(link);
    })
    .map((i) => i.id);
  return { label, ids, unplaced: index.unplaced.length };
}

// One finding --------------------------------------------------------------------------------

export interface IssueDetail {
  id: string;
  code: string;
  title: string;
  classId: string;
  severity: Issue['severity'];
  severityLabel: string;
  status: string;
  source: string;
  layers: string[];
  asset?: string;
  area?: string;
  position?: Vec3;
  photos: number;
  photoOnly: boolean;
}

/** The label of an issue's severity in the issue's own severity model. */
export function severityLabel(ctx: RendererToolContext, issue: Issue): string {
  const model = project(ctx).manifest.severityModels.find((m) => m.id === issue.severityModelId);
  if (issue.severity === 'uncertain') return model?.uncertain?.label ?? 'Uncertain';
  return model?.levels.find((l) => l.value === issue.severity)?.label ?? `Level ${issue.severity}`;
}

export function describeIssue(
  ctx: RendererToolContext,
  issue: Issue,
  index: AssetIndex,
): IssueDetail {
  const link = index.links.get(issue.id);
  const p = pointOf(issue);
  const photos = new Set(issue.sightings.flatMap((s) => (s.on === 'image' ? [s.photo] : [])));
  return {
    ...issueRow(issue),
    severityLabel: severityLabel(ctx, issue),
    ...(link ? { asset: link.asset, ...(link.area ? { area: link.area } : {}) } : {}),
    ...(p ? { position: [round1(p[0]), round1(p[1]), round1(p[2])] satisfies Vec3 } : {}),
    photos: photos.size,
    photoOnly: photos.size > 0 && !p,
  };
}
