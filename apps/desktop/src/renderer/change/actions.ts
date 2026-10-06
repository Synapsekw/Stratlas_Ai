/**
 * What a person's review of a change does in the app (founder decision 3): only these, and only
 * on a click, change issues. Confirming a match gives both issues one track; "Close as resolved"
 * closes the earlier issue with `resolvedIn`; "Make issue" drafts an issue on the later date.
 */
import { focusIssue, isAnnotateReadOnly, issueSaver } from '@aio/annotate';
import {
  canMakeIssue,
  changeStore,
  closeResolved,
  draftFromChange,
  trackPair,
  type ChangeRowActions,
  type RegisterRow,
} from '@aio/change';
import type {
  AioBridge,
  ChangeItem,
  ChangeSet,
  ImageGeom,
  Issue,
  ProjectManifest,
} from '@aio/schema';
import { assetUrl, workspace } from '@aio/workspace';
import { authorName } from '../author';

const READ_ONLY = 'This project is a read-only package. Issues cannot be changed.';

const newId = () => globalThis.crypto.randomUUID();
const nowIso = () => new Date().toISOString();

function saveIssues(changed: readonly Issue[]): void {
  const ws = workspace.getState();
  for (const i of changed) ws.upsertIssue(i);
  const project = ws.project;
  if (project) issueSaver.schedule(project.id, workspace.getState().issues);
}

function setOf(row: RegisterRow): ChangeSet | undefined {
  return changeStore.getState().sets[row.setId];
}

async function markReviewed(row: RegisterRow, issueId?: string): Promise<string | null> {
  const ok = await changeStore.getState().review(
    { setId: row.setId, itemId: row.item.id },
    {
      ...row.item.review,
      status: 'confirmed',
      by: authorName() || 'user',
      at: nowIso(),
      ...(issueId ? { issueId } : {}),
    },
  );
  return ok ? null : (changeStore.getState().error ?? 'The review was not saved.');
}

/** The later date's feature of a vector change, from its layer's GeoJSON. */
async function vectorGeometry(
  item: Extract<ChangeItem, { kind: 'vector' }>,
  manifest: ProjectManifest,
  projectId: string,
): Promise<Record<string, unknown> | null> {
  const layer = manifest.layers.find((l) => l.id === (item.layerTo ?? item.layerFrom));
  const ref = item.layerTo ? item.featureTo : item.featureFrom;
  if (layer?.kind !== 'vector' || ref === undefined) return null;
  try {
    const res = await fetch(assetUrl(projectId, layer.src));
    const fc = (await res.json()) as { features?: { id?: unknown; geometry?: unknown }[] };
    const list = fc.features ?? [];
    const f =
      typeof ref === 'number' && list[ref] && list[ref].id === undefined
        ? list[ref]
        : (list.find((x) => x.id === ref) ?? (typeof ref === 'number' ? list[ref] : undefined));
    const g = f?.geometry;
    return g && typeof g === 'object' ? (g as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** One of the later date's detections of a detection change, as an image sighting. */
async function laterDetection(
  item: Extract<ChangeItem, { kind: 'detection' }>,
  manifest: ProjectManifest,
  projectId: string,
): Promise<{ layer: string; photo: string; geom: ImageGeom } | null> {
  const ref = item.toIds?.[0];
  const aio = (globalThis as { aio?: AioBridge }).aio;
  if (!ref || !aio) return null;
  const [name, id] = ref.split('#');
  const r = await aio.invoke('detections:read', { projectId }).catch(() => null);
  if (!r?.ok) return null;
  const pass = r.files.find((f) => f.name === name);
  const d =
    pass?.file.detections.find((x) => x.id === id) ?? pass?.file.detections[Number(id) || 0];
  if (!pass || !d?.photo || (d.space ?? 'preview') !== 'preview') return null;
  const layer =
    pass.file.layer ??
    manifest.layers.find((l) => l.kind === 'photos' && l.items.some((p) => p.id === d.photo))?.id;
  if (!layer) return null;
  const [x0, y0, x1, y1] = d.bbox;
  return { layer, photo: d.photo, geom: { type: 'box', x: x0, y: y0, w: x1 - x0, h: y1 - y0 } };
}

export function createChangeActions(): ChangeRowActions {
  const issueById = (id: string | undefined) =>
    id ? workspace.getState().issues.find((i) => i.id === id) : undefined;
  return {
    author: () => authorName() || 'user',
    canMakeIssue,
    issueCode(id) {
      const i = issueById(id);
      return i ? { code: i.code, status: i.status } : null;
    },
    openIssue(id) {
      const i = issueById(id);
      if (i) focusIssue(i);
    },
    async confirm(row) {
      const set = setOf(row);
      const { item } = row;
      if (item.kind !== 'issue' || !set) return markReviewed(row);
      if (isAnnotateReadOnly()) return READ_ONLY;
      const a = issueById(item.from);
      const b = issueById(item.to);
      if (!a && !b) return markReviewed(row);
      if (item.verdict === 'not-seen') return markReviewed(row, a?.id);
      const r = trackPair(a, b, { from: set.from, to: set.to }, nowIso(), newId);
      saveIssues([r.earlier, r.later].filter((x): x is Issue => !!x));
      return markReviewed(row, (r.later ?? r.earlier)?.id);
    },
    async closeResolved(row) {
      const set = setOf(row);
      const { item } = row;
      if (item.kind !== 'issue' || item.verdict !== 'resolved' || !set) return null;
      if (isAnnotateReadOnly()) return READ_ONLY;
      const a = issueById(item.from);
      if (!a) return 'The issue of the earlier date is no longer in this project.';
      saveIssues([closeResolved(a, set.to, nowIso())]);
      return markReviewed(row, a.id);
    },
    async makeIssue(row) {
      const set = setOf(row);
      const project = workspace.getState().project;
      if (!set || !project) return 'Open the project first.';
      if (isAnnotateReadOnly()) return READ_ONLY;
      const { item } = row;
      const m = project.manifest;
      const laterModel =
        m.layers.find((l) => (l.kind === 'mesh' || l.kind === 'pointcloud') && l.capture === set.to)
          ?.id ?? m.layers.find((l) => l.kind === 'mesh' || l.kind === 'pointcloud')?.id;
      const id = newId();
      const r = draftFromChange(item, {
        set,
        manifest: m,
        existingCodes: workspace.getState().issues.map((i) => i.code),
        author: authorName() || 'user',
        now: nowIso(),
        id,
        meshLayer: laterModel ?? null,
        geometry: item.kind === 'vector' ? await vectorGeometry(item, m, project.id) : null,
        detection: item.kind === 'detection' ? await laterDetection(item, m, project.id) : null,
      });
      if (!r.ok) return r.error;
      saveIssues([r.issue]);
      return markReviewed(row, r.issue.id);
    },
  };
}
