/**
 * Procedural models (M8 stream C5, BLD-11): `model:list|read|write|build` and the project policy
 * `ai:setCloudDrawings` (founder decision 5). Models live in `<project>/models/<id>.procmodel.json`
 * (data-conventions section 15). Folders are written atomically with a `.bak`; packages are read
 * only. `model:build` meshes the accepted parts (or, for the draft preview, every part but the
 * rejected ones) with `@aio/modelling` and adds or updates the model's mesh layer
 * (`derived: { kind: 'model', source: [id] }`), tagged by part so a click on a tank selects it.
 */
import { checkProcModel, meshProcModel, summarise } from '@aio/modelling';
import { readManifestFile, writeManifestFile } from '@aio/project/builder';
import {
  PROCMODEL_DIR,
  ProcModel,
  type Layer,
  type ProcModelSummary,
  type ProjectManifest,
} from '@aio/schema';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writeJsonAtomic } from './fsutil';
import type { Handle } from './notYet';

type MeshLayer = Extract<Layer, { kind: 'mesh' }>;

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
function parseModel(
  text: string,
  rel: string,
): { ok: true; model: ProcModel } | { ok: false; error: string } {
  let json: unknown;
  try {
    json = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text) as unknown;
  } catch {
    return { ok: false, error: `${rel} is not valid JSON.` };
  }
  const r = ProcModel.safeParse(json);
  if (r.success) return { ok: true, model: r.data };
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

async function writeBytesAtomic(file: string, data: Uint8Array): Promise<void> {
  const tmp = `${file}.${String(process.pid)}.${String(Date.now())}.tmp`;
  await writeFile(tmp, data);
  try {
    await rename(tmp, file);
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
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
      read: (rel: string) => readFile(join(root, ...rel.split('/')), 'utf8').catch(() => null),
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
    await writeJsonAtomic(join(root, PROCMODEL_DIR, `${model.id}${SUFFIX}`), model, {
      backup: true,
    });
    return { ok: true };
  });

  handle('model:build', async ({ projectId, id, draft = false }) => {
    if (projects.package(projectId)) return READ_ONLY;
    const root = projects.root(projectId);
    if (root === undefined) return notOpen(projectId);
    const rel = modelFile(id);
    const text = await readFile(join(root, PROCMODEL_DIR, `${id}${SUFFIX}`), 'utf8').catch(
      () => null,
    );
    if (text === null) return { ok: false, error: `There is no model "${id}" in this project.` };
    const parsed = parseModel(text, rel);
    if (!parsed.ok) return parsed;
    const model = parsed.model;
    const problem = checkProcModel(model)
      .filter((p) => {
        const part = model.parts.find((q) => q.id === p.partId);
        return !part || (draft ? part.status !== 'rejected' : part.status === 'accepted');
      })
      .find((p) => p.partId !== undefined);
    if (problem) return { ok: false, error: problem.message };
    const meshed = meshProcModel(model, { parts: draft ? 'all' : 'accepted' });
    if (!draft && meshed.nodes.length === 0) {
      return { ok: false, error: 'Accept at least one part, then build the model.' };
    }
    const glbRel = modelGlb(id, draft);
    await mkdir(join(root, PROCMODEL_DIR), { recursive: true });
    await writeBytesAtomic(join(root, ...glbRel.split('/')), meshed.glb);

    const tags: NonNullable<MeshLayer['tags']> = [];
    meshed.nodes.forEach((node, i) => {
      const part = model.parts.find((p) => p.id === meshed.partIds[i]);
      if (!part?.tag) return;
      tags.push({
        node,
        tag: part.tag,
        ...(part.class ? { area: part.class } : {}),
      });
    });
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
        runId: stamp(now()),
        ...(draft ? { draft: true } : {}),
      },
    };
    const manifest = await readManifestFile(root);
    const draftId = modelLayerId(id, true);
    let placed = false;
    const layers: Layer[] = [];
    for (const l of manifest.layers) {
      if (l.id === layerId) {
        layers.push({ ...layer, visible: l.visible });
        placed = true;
      } else if (!draft && l.id === draftId) {
        // the real build replaces the preview
        continue;
      } else {
        layers.push(l);
      }
    }
    if (!placed) layers.push(layer);
    await writeManifestFile(root, { ...manifest, layers });
    if (!draft) await rm(join(root, ...modelGlb(id, true).split('/')), { force: true });
    return { ok: true, layer: layerId, glb: glbRel };
  });

  handle('ai:setCloudDrawings', async ({ projectId, allow }) => {
    if (projects.package(projectId)) return READ_ONLY;
    const root = projects.root(projectId);
    if (root === undefined) return notOpen(projectId);
    const manifest = await readManifestFile(root);
    const next: ProjectManifest = { ...manifest };
    if (allow) next.aiCloudDrawings = true;
    else delete next.aiCloudDrawings;
    await writeManifestFile(root, next);
    return { ok: true };
  });
}
