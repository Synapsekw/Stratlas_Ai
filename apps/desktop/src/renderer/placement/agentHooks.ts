/**
 * The assistant's placement tools (`place_on_model`, `add_sighting`, executors in @aio/ai
 * placement-tools.ts) act through these hooks, behind the panel's Approve: the same store, the
 * same detection acceptance and the same issue editor as the person's own clicks.
 */
import { ToolError, type AppHooks, type PlaceOutcome } from '@aio/ai';
import type { IssueEditor } from '@aio/annotate';
import type { Issue, Layer, Sighting } from '@aio/schema';
import type { Workspace } from '@aio/workspace';
import type { StoreApi } from 'zustand/vanilla';
import type { acceptByIds } from '../detections/store';
import type { PlaceOutcome as Placed, PlaceSummary } from './store';

export interface PlacementHookDeps {
  workspace: StoreApi<Workspace>;
  placeIds(ids: readonly string[], layerId: string): Promise<PlaceSummary | null>;
  acceptByIds: typeof acceptByIds;
  editor: Pick<IssueEditor, 'addSighting' | 'undo' | 'state'>;
}

const NOT_RUN = 'placing did not run (another project opened, or it failed)';

/** Why one issue was not placed, for the assistant to say. */
function reasonOf(o: Placed): string {
  if (o.changed) return 'the issue changed while placing';
  switch (o.reason) {
    case 'layer-not-loaded':
      return 'the layer is not loaded';
    case 'no-photo-shape':
      return 'the issue has no photo shape to project';
    default:
      return 'missed the model';
  }
}

type ModelLayer = Extract<Layer, { kind: 'mesh' | 'pointcloud' }>;

const placedOf = (sightings: readonly Sighting[] | undefined) =>
  (sightings ?? []).flatMap((s) =>
    s.on === 'mesh' || s.on === 'pointcloud' ? [{ on: s.on, type: s.geom.type }] : [],
  );

export function createPlacementHooks(
  deps: PlacementHookDeps,
): Required<Pick<AppHooks, 'placeOnModel' | 'addSighting'>> {
  const manifest = () => {
    const p = deps.workspace.getState().project;
    if (!p) throw new ToolError('Open a project first.');
    return p.manifest;
  };
  const layerOf = (ref: string): ModelLayer => {
    const models = manifest().layers.filter(
      (l): l is ModelLayer => l.kind === 'mesh' || l.kind === 'pointcloud',
    );
    const want = ref.trim().toLowerCase();
    const l = models.find((x) => x.id === ref || x.name.toLowerCase() === want);
    if (!l)
      throw new ToolError(
        `There is no mesh or point cloud layer "${ref}". The layers: ${models.map((x) => x.name).join(', ')}.`,
      );
    return l;
  };
  const issueOf = (ref: string): Issue | undefined =>
    deps.workspace.getState().issues.find((i) => i.id === ref || i.code === ref);
  const undoIf = (label: string | undefined) => {
    if (label && deps.editor.state.undoLabel === label) deps.editor.undo();
  };

  return {
    async placeOnModel(req) {
      const layer = layerOf(req.layer);
      const issueIds = new Map<string, string>();
      const rest: string[] = [];
      for (const id of req.ids) {
        const i = issueOf(id);
        if (i) issueIds.set(id, i.id);
        else rest.push(id);
      }
      const early = new Map<string, PlaceOutcome>();
      if (rest.length) {
        const a = deps.acceptByIds(rest);
        if ('error' in a) throw new ToolError(a.error);
        for (const x of a.accepted) issueIds.set(x.id, x.issueId);
        for (const x of a.skipped) early.set(x.id, { id: x.id, reason: x.problem });
      }
      const summary = await deps.placeIds([...new Set(issueIds.values())], layer.id);
      const byIssue = new Map((summary?.outcomes ?? []).map((o) => [o.id, o]));
      const outcomes: PlaceOutcome[] = req.ids.map((id) => {
        const issueId = issueIds.get(id);
        const o = issueId ? byIssue.get(issueId) : undefined;
        if (o?.ok) return { id, code: o.code, placed: placedOf(o.sightings) };
        if (o) return { id, code: o.code, reason: o.changed ? 'changed' : (o.reason ?? 'missed') };
        if (issueId) {
          const code = issueOf(issueId)?.code;
          return { id, ...(code ? { code } : {}), reason: NOT_RUN };
        }
        return early.get(id) ?? { id, reason: 'unknown' };
      });
      const label = summary && summary.placed > 0 ? summary.label : undefined;
      return {
        layer: { id: layer.id, name: layer.name },
        outcomes,
        ...(label
          ? {
              undo: () => {
                undoIf(label);
              },
            }
          : {}),
      };
    },

    async addSighting(req) {
      const layer = layerOf(req.layer);
      const issue = issueOf(req.issue);
      if (!issue) throw new ToolError(`No issue "${req.issue}". Use list_issues for the codes.`);
      if (req.at.kind === 'point') {
        const p = req.at.p;
        const s: Sighting =
          layer.kind === 'pointcloud'
            ? { on: 'pointcloud', layer: layer.id, geom: { type: 'point3', p } }
            : { on: 'mesh', layer: layer.id, geom: { type: 'spoint', p, n: [0, 1, 0] } };
        const r = deps.editor.addSighting(issue.id, s);
        if (!r.ok) throw new ToolError(r.error);
        const label = deps.editor.state.undoLabel ?? undefined;
        return {
          code: issue.code,
          placed: placedOf([s]),
          undo: () => {
            undoIf(label);
          },
        };
      }
      const photo = req.at.photo;
      const photos = manifest().layers.find(
        (l) => l.kind === 'photos' && l.items.some((x) => x.id === photo),
      );
      if (!photos) throw new ToolError(`No photo "${photo}" in this project.`);
      const [x, y, w, h] = req.at.box;
      const image: Sighting = {
        on: 'image',
        layer: photos.id,
        photo,
        geom: { type: 'box', x, y, w, h },
      };
      const added = deps.editor.addSighting(issue.id, image);
      if (!added.ok) throw new ToolError(added.error);
      const first = deps.editor.state.undoLabel ?? undefined;
      const summary = await deps.placeIds([issue.id], layer.id);
      const o = summary?.outcomes.find((x) => x.id === issue.id);
      const reason = o?.ok ? undefined : o ? `the photo box: ${reasonOf(o)}` : NOT_RUN;
      const second = summary && summary.placed > 0 ? summary.label : undefined;
      return {
        code: issue.code,
        placed: o?.ok ? placedOf(o.sightings) : [],
        ...(reason ? { reason } : {}),
        undo: () => {
          undoIf(second);
          undoIf(first);
        },
      };
    },
  };
}
