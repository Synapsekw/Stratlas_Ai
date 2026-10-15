/**
 * Procedural models (M8 stream C5, BLD-11): `model:list|read|write|build` and the project policy
 * `ai:setCloudDrawings` (founder decision 5). Models live in `<project>/models/<id>.procmodel.json`
 * (data-conventions section 15). Folders are written atomically with a `.bak`; packages are read
 * only. `model:build` meshes the accepted parts (or, for the draft preview, every part but the
 * rejected ones) with `@aio/modelling` and adds or updates the model's mesh layer
 * (`derived: { kind: 'model', source: [id] }`), tagged by part so a click on a tank selects it.
 * Files are `aio.procmodel/2`: an older `/1` file is read through the migrator and written back as
 * `/2` on its next save (the `.bak` keeps the `/1` text); a newer one is refused untouched. A model
 * with engineering assemblies is built with `buildEngineeringGlb` (one node per accepted assembly,
 * then its parts).
 */
import { brand } from '@aio/brand';
import {
  buildEngineeringGlb,
  checkProcModel,
  meshProcModel,
  readGlb,
  readProcModel,
  summarise,
} from '@aio/modelling';
import {
  PROCMODEL_DIR,
  type GlbBuildReport,
  type Georef,
  type Layer,
  type ProcModel,
  type ProcModelSummary,
  type ProjectManifest,
} from '@aio/schema';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isChangedOnDisk, readBytesSeen, writeJsonSeen } from './fsutil';
import type { Handle } from './notYet';

type MeshLayer = Extract<Layer, { kind: 'mesh' }>;

/**
 * The builder library loads on first use, as in builder.ts: a static import of it makes the main
 * bundle come out empty (rolldown, vite 8).
 */
const lib = () => import('@aio/project/builder');
const readManifestFile = async (root: string) => (await lib()).readManifestFile(root);
/**
 * Change a project's manifest and save it: read and written in one turn among the saves of the
 * project, so a save made at the same moment (a survey date, another layer) is not replaced.
 */
const updateManifest = async (root: string, change: (m: ProjectManifest) => ProjectManifest) =>
  (await lib()).updateManifestFile(root, (m) => ({ manifest: change(m) }));

/** The projects main has open: a folder (writable) or a package (read only). */
export interface ModelProjects {
  root(id: string): string | undefined;
  package(id: string):
    | {
        manifest: ProjectManifest;
        archive: {
          entries: ReadonlyMap<string, unknown>;
          read(name: string): Promise<Buffer>;
        };
      }
    | undefined;
}

export interface ModelBuilderIpcDeps {
  handle: Handle;
  projects: ModelProjects;
  now?: () => Date;
}

const SUFFIX = '.procmodel.json';
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

const READ_ONLY = {
  ok: false as const,
  error: 'This project is a read-only package. Models are not saved into it.',
  code: 'read-only' as const,
};

export const modelFile = (id: string) => `${PROCMODEL_DIR}/${id}${SUFFIX}`;
export const modelGlb = (id: string, draft: boolean) =>
  `${PROCMODEL_DIR}/${draft ? 'draft-' : ''}${id}.glb`;
export const modelLayerId = (id: string, draft: boolean) => `model-${draft ? 'draft-' : ''}${id}`;

/** Read and check a model file's JSON; the error names the file. */
export function parseModel(
  text: string,
  rel: string,
): { ok: true; model: ProcModel } | { ok: false; error: string } {
  let json: unknown;
  try {
    json = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text) as unknown;
  } catch {
    return { ok: false, error: `${rel} is not valid JSON.` };
  }
  const r = readProcModel(json, { appName: brand.productName, what: rel });
  if (r.ok) return { ok: true, model: r.value };
  if (r.reason !== 'invalid') return { ok: false, error: r.error };
  const first = checkProcModel(json)[0]?.message ?? 'The model file is not valid.';
  return { ok: false, error: `${rel}: ${first}` };
}

/** The built (non-draft) layer of each model in a manifest. */
function builtLayers(m: ProjectManifest): Map<string, string> {
  const out = new Map<string, string>();
  for (const l of m.layers) {
    if (l.kind !== 'mesh' || l.derived?.kind !== 'model' || l.derived.draft) continue;
    for (const s of l.derived.source ?? []) out.set(s, l.id);
  }
  return out;
}

function summaryOf(model: ProcModel, layers: Map<string, string>): ProcModelSummary {
  const layer = layers.get(model.id);
  return { ...summarise(model), ...(layer ? { layer } : {}) };
}

/** `build-20261006T100000Z`: when a layer was built, so a rebuild reloads it in the viewer. */
function stamp(d: Date): string {
  return `build-${d
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z')}`;
}

/** Whether a folder project allows plan images and drawings to go to a cloud model. */
export async function readCloudDrawings(root: string): Promise<boolean> {
  try {
    return (await readManifestFile(root)).aiCloudDrawings === true;
  } catch {
    return false;
  }
}

export async function writeBytesAtomic(file: string, data: Uint8Array): Promise<void> {
  const tmp = `${file}.${String(process.pid)}.${String(Date.now())}.tmp`;
  await writeFile(tmp, data);
  try {
    await rename(tmp, file);
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
}

/**
 * The GLB of a model and the layer tags of its nodes: a plain parts model with the parts mesher
 * (as before `/2`), a model with assemblies with the engineering builder at the model's run
 * detail (standard when it has none).
 */
function meshModel(
  model: ProcModel,
  draft: boolean,
): {
  glb: Uint8Array;
  nodes: string[];
  tags: NonNullable<MeshLayer['tags']>;
  triangles: number;
  report?: GlbBuildReport;
} {
  if (model.assemblies.length > 0) {
    const built = buildEngineeringGlb(model, {
      detail: model.run?.detail ?? 'standard',
      drafts: draft,
      generator: `${brand.productName} model builder`,
    });
    const assemblies = new Map(model.assemblies.map((a) => [a.id, a]));
    // the part each part node was made from, by node name (its `extras.part`)
    const partOfNode = new Map<string, string>();
    const glbNodes = readGlb(built.glb).json.nodes;
    for (const n of Array.isArray(glbNodes) ? (glbNodes as unknown[]) : []) {
      if (typeof n !== 'object' || n === null) continue;
      const { name, extras } = n as { name?: unknown; extras?: { part?: unknown } };
      if (typeof name === 'string' && typeof extras?.part === 'string')
        partOfNode.set(name, extras.part);
    }
    const tags: NonNullable<MeshLayer['tags']> = [];
    for (const n of built.nodes) {
      const a = assemblies.get(n.node);
      if (a) {
        if (a.tag) tags.push({ node: n.node, tag: a.tag, area: a.kind });
        continue;
      }
      // a part node is tagged as the parts mesher tags it: only a part with a tag, by its class
      const id = partOfNode.get(n.node);
      const part = id === undefined ? undefined : model.parts.find((p) => p.id === id);
      if (part?.tag)
        tags.push({ node: n.node, tag: part.tag, ...(part.class ? { area: part.class } : {}) });
    }
    return {
      glb: built.glb,
      nodes: built.nodes.map((n) => n.node),
      tags,
      triangles: built.triangles,
      report: {
        triangles: built.triangles,
        overBudget: built.overBudget,
        detail: built.detail,
        simplified: built.simplified,
        failed: built.failed,
        notes: built.notes,
      },
    };
  }
  const meshed = meshProcModel(model, { parts: draft ? 'all' : 'accepted' });
  const tags: NonNullable<MeshLayer['tags']> = [];
  meshed.nodes.forEach((node, i) => {
    const part = model.parts.find((p) => p.id === meshed.partIds[i]);
    if (!part?.tag) return;
    tags.push({ node, tag: part.tag, ...(part.class ? { area: part.class } : {}) });
  });
  return { glb: meshed.glb, nodes: meshed.nodes, tags, triangles: trianglesIn(meshed.glb) };
}

/** Triangles of a GLB: index counts of its triangle primitives, a third each. */
function trianglesIn(glb: Uint8Array): number {
  const { json } = readGlb(glb);
  const accessors = (Array.isArray(json.accessors) ? json.accessors : []) as { count?: number }[];
  const meshes = (Array.isArray(json.meshes) ? json.meshes : []) as {
    primitives?: { indices?: number; mode?: number }[];
  }[];
  let n = 0;
  for (const m of meshes)
    for (const p of m.primitives ?? [])
      if ((p.mode ?? 4) === 4 && p.indices !== undefined)
        n += Math.floor((accessors[p.indices]?.count ?? 0) / 3);
  return n;
}

/** A model's file read and checked from a project folder, or the reason it cannot be. */
export async function readModelFile(
  root: string,
  id: string,
): Promise<{ ok: true; model: ProcModel } | { ok: false; error: string }> {
  const text = await readFile(join(root, PROCMODEL_DIR, `${id}${SUFFIX}`), 'utf8').catch(
    () => null,
  );
  if (text === null) return { ok: false, error: `There is no model "${id}" in this project.` };
  return parseModel(text, modelFile(id));
}

export type BuildResult =
  | {
      ok: true;
      layer: string;
      glb: string;
      triangles: number;
      report?: GlbBuildReport;
      model: ProcModel;
    }
  | { ok: false; error: string };

/**
 * Mesh a model into `models/<id>.glb` (or the draft) and add or replace its one layer. A rebuilt
 * layer keeps its visibility and, unless `placement` gives new ones, its `georef` and
 * `placement`. The real build replaces the draft preview.
 */
export async function buildModelLayer(
  root: string,
  id: string,
  o: {
    draft: boolean;
    now: Date;
    placement?: { georef?: Georef; placement: NonNullable<MeshLayer['placement']> };
  },
): Promise<BuildResult> {
  const draft = o.draft;
  const parsed = await readModelFile(root, id);
  if (!parsed.ok) return parsed;
  const model = parsed.model;
  const problem = checkProcModel(model)
    .filter((p) => {
      const part = model.parts.find((q) => q.id === p.partId);
      return !part || (draft ? part.status !== 'rejected' : part.status === 'accepted');
    })
    .find((p) => p.partId !== undefined);
  if (problem) return { ok: false, error: problem.message };
  const meshed = meshModel(model, draft);
  if (!draft && meshed.nodes.length === 0) {
    return {
      ok: false,
      error:
        model.assemblies.length > 0
          ? 'Accept at least one part or component, then build the model.'
          : 'Accept at least one part, then build the model.',
    };
  }
  const glbRel = modelGlb(id, draft);
  await mkdir(join(root, PROCMODEL_DIR), { recursive: true });
  await writeBytesAtomic(join(root, ...glbRel.split('/')), meshed.glb);

  const tags: NonNullable<MeshLayer['tags']> = meshed.tags;
  const layerId = modelLayerId(id, draft);
  const layer: MeshLayer = {
    kind: 'mesh',
    id: layerId,
    name: draft ? `${model.name} (draft)` : model.name,
    visible: true,
    src: { path: glbRel },
    transform: IDENTITY,
    ...(tags.length ? { tags } : {}),
    ...(model.capture ? { capture: model.capture } : {}),
    derived: {
      kind: 'model',
      source: [id],
      runId: stamp(o.now),
      ...(draft ? { draft: true } : {}),
    },
  };
  const draftId = modelLayerId(id, true);
  await updateManifest(root, (manifest) => {
    let placed = false;
    const layers: Layer[] = [];
    for (const l of manifest.layers) {
      if (l.id === layerId) {
        const keep = o.placement
          ? {
              ...(o.placement.georef ? { georef: o.placement.georef } : {}),
              placement: o.placement.placement,
            }
          : l.kind === 'mesh'
            ? {
                ...(l.georef ? { georef: l.georef } : {}),
                ...(l.placement ? { placement: l.placement } : {}),
              }
            : {};
        layers.push({ ...layer, ...keep, visible: l.visible });
        placed = true;
      } else if (!draft && l.id === draftId) {
        // the real build replaces the preview
        continue;
      } else {
        layers.push(l);
      }
    }
    if (!placed)
      layers.push({
        ...layer,
        ...(o.placement?.georef ? { georef: o.placement.georef } : {}),
        ...(o.placement ? { placement: o.placement.placement } : {}),
      });
    return { ...manifest, layers };
  });
  if (!draft) await rm(join(root, ...modelGlb(id, true).split('/')), { force: true });
  return {
    ok: true,
    layer: layerId,
    glb: glbRel,
    triangles: meshed.triangles,
    ...(meshed.report ? { report: meshed.report } : {}),
    model,
  };
}

export function registerModelBuilderIpc({
  handle,
  projects,
  now = () => new Date(),
}: ModelBuilderIpcDeps): void {
  const notOpen = (id: string) => ({ ok: false as const, error: `Project "${id}" is not open.` });

  /** Model files of a folder or a package: names, and the text of one. */
  function source(projectId: string) {
    const pkg = projects.package(projectId);
    if (pkg) {
      return {
        readOnly: true,
        manifest: () => Promise.resolve(pkg.manifest),
        names: () =>
          Promise.resolve(
            [...pkg.archive.entries.keys()]
              .filter((n) => n.startsWith(`${PROCMODEL_DIR}/`) && n.endsWith(SUFFIX))
              .map((n) => n.slice(PROCMODEL_DIR.length + 1))
              .filter((n) => !n.includes('/')),
          ),
        read: async (rel: string) =>
          pkg.archive.entries.has(rel) ? (await pkg.archive.read(rel)).toString('utf8') : null,
      };
    }
    const root = projects.root(projectId);
    if (root === undefined) return null;
    return {
      readOnly: false,
      manifest: () => readManifestFile(root),
      names: async () => {
        try {
          const list = await readdir(join(root, PROCMODEL_DIR), { withFileTypes: true });
          return list.filter((e) => e.isFile() && e.name.endsWith(SUFFIX)).map((e) => e.name);
        } catch {
          return [];
        }
      },
      // remembered, so a save compares with the model the person saw first (shared folders)
      read: async (rel: string) =>
        (await readBytesSeen(join(root, ...rel.split('/'))).catch(() => null))?.toString('utf8') ??
        null,
    };
  }

  handle('model:list', async ({ projectId }) => {
    const src = source(projectId);
    if (!src) return notOpen(projectId);
    const layers = builtLayers(await src.manifest());
    const models: ProcModelSummary[] = [];
    for (const name of (await src.names()).sort()) {
      const rel = `${PROCMODEL_DIR}/${name}`;
      const text = await src.read(rel);
      const r = text === null ? null : parseModel(text, rel);
      if (r?.ok) models.push(summaryOf(r.model, layers));
      else if (r) console.warn(`model:list skipped ${r.error}`);
    }
    return { ok: true, models, readOnly: src.readOnly };
  });

  handle('model:read', async ({ projectId, id }) => {
    const src = source(projectId);
    if (!src) return notOpen(projectId);
    const rel = modelFile(id);
    const text = await src.read(rel);
    if (text === null) return { ok: false, error: `There is no model "${id}" in this project.` };
    const r = parseModel(text, rel);
    return r.ok ? { ok: true, model: r.model, readOnly: src.readOnly } : r;
  });

  handle('model:write', async ({ projectId, model }) => {
    if (projects.package(projectId)) return READ_ONLY;
    const root = projects.root(projectId);
    if (root === undefined) return notOpen(projectId);
    await mkdir(join(root, PROCMODEL_DIR), { recursive: true });
    try {
      await writeJsonSeen(join(root, PROCMODEL_DIR, `${model.id}${SUFFIX}`), model, {
        backup: true,
        name: modelFile(model.id),
      });
    } catch (e) {
      if (isChangedOnDisk(e)) return { ok: false, error: e.message };
      throw e;
    }
    return { ok: true };
  });

  handle('model:build', async ({ projectId, id, draft = false }) => {
    if (projects.package(projectId)) return READ_ONLY;
    const root = projects.root(projectId);
    if (root === undefined) return notOpen(projectId);
    const r = await buildModelLayer(root, id, { draft, now: now() });
    if (!r.ok) return r;
    return {
      ok: true,
      layer: r.layer,
      glb: r.glb,
      triangles: r.triangles,
      ...(r.report ? { report: r.report } : {}),
    };
  });

  handle('ai:setCloudDrawings', async ({ projectId, allow }) => {
    if (projects.package(projectId)) return READ_ONLY;
    const root = projects.root(projectId);
    if (root === undefined) return notOpen(projectId);
    await updateManifest(root, (manifest) => {
      const next: ProjectManifest = { ...manifest };
      if (allow) next.aiCloudDrawings = true;
      else delete next.aiCloudDrawings;
      return next;
    });
    return { ok: true };
  });
}
