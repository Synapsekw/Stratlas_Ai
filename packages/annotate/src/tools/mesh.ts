import type { SceneHandle } from '@aio/engine';
import type { Issue, SeverityModel, Sighting, Vec3 } from '@aio/schema';
import { Vector3, type Intersection } from 'three';
import { layerOf } from '../crossview/backproject';
import { pinPasses, sevRank, type PinFilter } from './declutter';

/** Mesh annotation (ANN-1): point, polyline and polygon placed on surfaces with the scene ray. */
export type MeshSighting = Extract<Sighting, { on: 'mesh' }>;

const centroid = (pts: readonly Vec3[]): Vec3 => {
  const s = pts.reduce<Vec3>((a, p) => [a[0] + p[0], a[1] + p[1], a[2] + p[2]], [0, 0, 0]);
  const n = pts.length || 1;
  return [s[0] / n, s[1] / n, s[2] / n];
};

/** A 3D point that stands for a sighting (pin position, fly-to target); null for 2D sightings. */
export function sightingAnchor(s: Sighting): Vec3 | null {
  if (s.on === 'mesh') {
    switch (s.geom.type) {
      case 'spoint':
        return s.geom.p;
      case 'spolyline':
      case 'spolygon':
        return centroid(s.geom.points);
      case 'spatch':
        return s.geom.center ?? null;
    }
  }
  if (s.on === 'pointcloud') {
    switch (s.geom.type) {
      case 'point3':
        return s.geom.p;
      case 'box3':
        return centroid([s.geom.min, s.geom.max]);
      case 'polygon3':
        return centroid(s.geom.points);
      case 'selection':
        return null;
    }
  }
  return null;
}

/** The issue's best 3D anchor: mesh sightings first, then point clouds. */
export function bestAnchor(issue: Issue): Vec3 | null {
  for (const kind of ['mesh', 'pointcloud'] as const) {
    for (const s of issue.sightings) {
      if (s.on !== kind) continue;
      const a = sightingAnchor(s);
      if (a) return a;
    }
  }
  return null;
}

const NEUTRAL = '#8a94a6';

/** Colour of a severity in its model (uncertain uses the model's uncertain colour). */
export function severityColor(model: SeverityModel | undefined, sev: Issue['severity']): string {
  if (!model) return NEUTRAL;
  if (sev === 'uncertain') return model.uncertain?.color ?? NEUTRAL;
  return model.levels.find((l) => l.value === sev)?.color ?? NEUTRAL;
}

export interface IssuePin {
  issueId: string;
  code: string;
  p: Vec3;
  color: string;
  selected: boolean;
  draft: boolean;
  /** Severity for ordering and clustering (`sevRank`: uncertain lowest). */
  rank: number;
}

/** Pins of the issues with a 3D anchor that pass `filter`; the selected issue always shows. */
export function issuePins(
  issues: readonly Issue[],
  models: readonly SeverityModel[],
  selectedId: string | null,
  filter: PinFilter = 'all',
): IssuePin[] {
  const out: IssuePin[] = [];
  for (const i of issues) {
    if (i.id !== selectedId && !pinPasses(i.severity, filter)) continue;
    const p = bestAnchor(i);
    if (!p) continue;
    out.push({
      issueId: i.id,
      code: i.code,
      p,
      color: severityColor(
        models.find((m) => m.id === i.severityModelId),
        i.severity,
      ),
      selected: i.id === selectedId,
      draft: i.status === 'draft',
      rank: sevRank(i.severity),
    });
  }
  return out;
}

export function surfacePointFromHit(hit: Intersection): { layer: string; p: Vec3; n: Vec3 } {
  const n = hit.face
    ? hit.face.normal.clone().transformDirection(hit.object.matrixWorld)
    : new Vector3(0, 1, 0);
  return {
    layer: layerOf(hit.object),
    p: [hit.point.x, hit.point.y, hit.point.z],
    n: [n.x, n.y, n.z],
  };
}

/** Surface under the cursor in normalised device coordinates, via the scene's raycast. */
export function pickSurface(
  handle: Pick<SceneHandle, 'raycast'>,
  ndcX: number,
  ndcY: number,
): { layer: string; p: Vec3; n: Vec3 } | null {
  const hit = handle.raycast(ndcX, ndcY);
  return hit ? surfacePointFromHit(hit) : null;
}

export type MeshDrawMode = 'point' | 'polyline' | 'polygon';

export interface MeshDrawState {
  mode: MeshDrawMode;
  layer: string | null;
  points: Vec3[];
  normals: Vec3[];
  done: boolean;
}

export type MeshDrawEvent =
  | { type: 'pick'; layer: string; p: Vec3; n: Vec3 }
  | { type: 'finish' }
  | { type: 'undo' }
  | { type: 'cancel' };

export function initialMeshDraw(mode: MeshDrawMode): MeshDrawState {
  return { mode, layer: null, points: [], normals: [], done: false };
}

const minPoints = (m: MeshDrawMode) => (m === 'point' ? 1 : m === 'polyline' ? 2 : 3);

export function meshDrawReducer(s: MeshDrawState, e: MeshDrawEvent): MeshDrawState {
  switch (e.type) {
    case 'pick': {
      const fresh = s.done ? initialMeshDraw(s.mode) : s;
      return {
        ...fresh,
        layer: fresh.layer ?? e.layer,
        points: [...fresh.points, e.p],
        normals: [...fresh.normals, e.n],
        done: s.mode === 'point',
      };
    }
    case 'finish':
      return s.points.length >= minPoints(s.mode) ? { ...s, done: true } : s;
    case 'undo':
      return { ...s, points: s.points.slice(0, -1), normals: s.normals.slice(0, -1), done: false };
    case 'cancel':
      return initialMeshDraw(s.mode);
  }
}

export function meshSightingFromDraw(s: MeshDrawState): MeshSighting | null {
  const first = s.points[0];
  if (!s.done || !s.layer || !first) return null;
  if (s.mode === 'point') {
    return {
      on: 'mesh',
      layer: s.layer,
      geom: { type: 'spoint', p: first, n: s.normals[0] ?? [0, 1, 0] },
    };
  }
  if (s.mode === 'polyline') {
    return { on: 'mesh', layer: s.layer, geom: { type: 'spolyline', points: s.points } };
  }
  return { on: 'mesh', layer: s.layer, geom: { type: 'spolygon', points: s.points } };
}
