/**
 * Engineering model files over IPC (engineering model spec sections 5.5 and 5.6):
 *
 * - `model:exportEngineering` writes the export bundle (GLB with `asset.extras.aioGeoref`, the
 *   model, the component register, the georeference sidecar) into `<folder>/<model id>/` through a
 *   staging folder renamed when complete. The georeference is that of the model's built layer in
 *   the project (its transform, in the project CRS), or of the model where it stands when it has no
 *   layer yet.
 * - `engineer:runRead` / `engineer:runWrite`: the run files under `engineering/<run>/` (`run.json`
 *   written atomically with a `.bak`; `evidence.json` and `proposal.json` read only). Packages
 *   leave run files out, so they read as absent there and are never written.
 * - `engineer:evidenceImage`: one image the run's `evidence.json` lists, from
 *   `engineering/<run>/img/` only, as a data URL at most 1568 px on its long side (the send
 *   preview). Nothing else on disk can be read through it, and never a cloud.
 *
 * `ai:setCloudEvidence` (the photo and scan consents) is the AI lane's handler, not this module's.
 */
import { brand } from '@aio/brand';
import { layerTransformToGeoref } from '@aio/geo';
import { exportBundle } from '@aio/modelling';
import {
  EngineerProposal,
  EngineerRun,
  EvidencePack,
  type Mat4,
  type ProjectManifest,
} from '@aio/schema';
import { readFile, realpath, stat } from 'node:fs/promises';
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { z } from 'zod';
import { isChangedOnDisk, readBytesSeen, writeJsonSeen } from './fsutil';
import { modelFile, modelLayerId, parseModel, type ModelProjects } from './modelBuilder';
import type { Handle } from './notYet';

/** The builder library loads on first use (see modelBuilder.ts). */
const lib = () => import('@aio/project/builder');

export const ENGINEERING_DIR = 'engineering';
/** The long side of an evidence image sent to a model or shown in the send preview. */
export const EVIDENCE_IMAGE_MAX_PX = 1568;
/** An evidence image file larger than this is not read at all. */
const EVIDENCE_IMAGE_MAX_BYTES = 32 * 1024 * 1024;
const IDENTITY: Mat4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};

const READ_ONLY = {
  ok: false as const,
  error: 'This project is a read-only package. Engineering runs are not saved into it.',
  code: 'read-only' as const,
};

export interface EngineeringIpcDeps {
  handle: Handle;
  projects: ModelProjects;
  /** Scales image bytes down so the long side is at most `maxPx` (main: Electron's codec). */
  images?: {
    downscale(bytes: Uint8Array, maxPx: number): Promise<{ bytes: Uint8Array; mime: string }>;
  };
  /** The export's file writer (tests inject a failure). */
  writeFile?: (path: string, data: Uint8Array | string) => Promise<void>;
  /** The GLB generator string. */
  generator?: string;
}

/** Width and height from a PNG or JPEG header, or null when it cannot tell. */
export function imageSize(b: Uint8Array): { w: number; h: number } | null {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (b.length >= 24 && dv.getUint32(0) === 0x89504e47 && dv.getUint32(12) === 0x49484452)
    return { w: dv.getUint32(16), h: dv.getUint32(20) };
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) return null;
      const marker = b[i + 1] ?? 0;
      const len = dv.getUint16(i + 2);
      // start of frame markers (not DHT C4, JPG C8, DAC CC)
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc)
        return { h: dv.getUint16(i + 5), w: dv.getUint16(i + 7) };
      i += 2 + len;
    }
  }
  return null;
}

type Read<T> = { ok: true; value: T | null } | { ok: false; error: string };

/** A run file: null when it is not there, an error naming it when it is there but not valid. */
async function readRunFile<S extends z.ZodType>(
  file: string,
  rel: string,
  schema: S,
  seen = false,
): Promise<Read<z.infer<S>>> {
  let bytes: Buffer | null;
  try {
    bytes = seen ? await readBytesSeen(file) : await readFile(file);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { ok: true, value: null };
    throw e;
  }
  if (bytes === null) return { ok: true, value: null };
  let json: unknown;
  try {
    const text = bytes.toString('utf8');
    json = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text) as unknown;
  } catch {
    return { ok: false, error: `${rel} is not valid JSON.` };
  }
  const r = schema.safeParse(json);
  if (r.success) return { ok: true, value: r.data };
  const issue = r.error.issues[0];
  return {
    ok: false,
    error: `${rel} is not valid: ${issue?.path.join('.') ?? ''} ${issue?.message ?? ''}`.trim(),
  };
}

export function registerEngineeringIpc({
  handle,
  projects,
  images,
  writeFile,
  generator = `${brand.productName} engineering model`,
}: EngineeringIpcDeps): void {
  const notOpen = (id: string) => ({ ok: false as const, error: `Project "${id}" is not open.` });

  handle('model:exportEngineering', async ({ projectId, modelId, folder, detail, replace }) => {
    const pkg = projects.package(projectId);
    const root = pkg ? undefined : projects.root(projectId);
    if (!pkg && root === undefined) return notOpen(projectId);
    const rel = modelFile(modelId);
    let text: string | null;
    let manifest: ProjectManifest;
    if (pkg) {
      text = pkg.archive.entries.has(rel) ? (await pkg.archive.read(rel)).toString('utf8') : null;
      manifest = pkg.manifest;
    } else {
      const dir = root ?? '';
      text = await readFile(join(dir, ...rel.split('/')), 'utf8').catch(() => null);
      manifest = await (await lib()).readManifestFile(dir);
    }
    if (text === null)
      return { ok: false, error: `There is no model "${modelId}" in this project.` };
    const parsed = parseModel(text, rel);
    if (!parsed.ok) return parsed;
    const model = parsed.model;
    if (
      !model.assemblies.some((a) => a.status === 'accepted') &&
      !model.parts.some((p) => p.status === 'accepted')
    )
      return { ok: false, error: 'Accept at least one component, then export the model.' };
    try {
      const layer = manifest.layers.find(
        (l) => l.kind === 'mesh' && l.id === modelLayerId(modelId, false),
      );
      const mesh = layer?.kind === 'mesh' ? layer : undefined;
      const georef = layerTransformToGeoref(
        mesh?.transform ?? IDENTITY,
        { crs: manifest.crs, origin: manifest.origin },
        mesh?.georef ?? model.georef ?? null,
        'engineer',
      );
      const bundle = exportBundle(model, { detail, generator, georef });
      const files: Record<string, Uint8Array | string> = {
        [`${modelId}.glb`]: bundle.glb,
        [`${modelId}.procmodel.json`]: bundle.procmodel,
        [`${modelId}.components.json`]: bundle.components,
        ...(bundle.georeference ? { [`${modelId}.georeference.json`]: bundle.georeference } : {}),
      };
      const target = join(folder, modelId);
      await (
        await lib()
      ).writeExportFolder(target, files, {
        ...(replace ? { replace: true } : {}),
        ...(writeFile ? { writeFile } : {}),
      });
      return {
        ok: true,
        files: Object.keys(files)
          .sort()
          .map((n) => join(target, n)),
        report: bundle.build,
      };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });

  handle('engineer:runRead', async ({ projectId, runId }) => {
    if (projects.package(projectId)) return { ok: true, run: null, evidence: null, proposal: null };
    const root = projects.root(projectId);
    if (root === undefined) return notOpen(projectId);
    const dir = join(root, ENGINEERING_DIR, runId);
    const rel = (f: string) => `${ENGINEERING_DIR}/${runId}/${f}`;
    const run = await readRunFile(join(dir, 'run.json'), rel('run.json'), EngineerRun, true);
    if (!run.ok) return run;
    const evidence = await readRunFile(
      join(dir, 'evidence.json'),
      rel('evidence.json'),
      EvidencePack,
    );
    if (!evidence.ok) return evidence;
    const proposal = await readRunFile(
      join(dir, 'proposal.json'),
      rel('proposal.json'),
      EngineerProposal,
    );
    if (!proposal.ok) return proposal;
    return { ok: true, run: run.value, evidence: evidence.value, proposal: proposal.value };
  });

  handle('engineer:runWrite', async ({ projectId, run }) => {
    if (projects.package(projectId)) return READ_ONLY;
    const root = projects.root(projectId);
    if (root === undefined) return notOpen(projectId);
    const { mkdir } = await import('node:fs/promises');
    const dir = join(root, ENGINEERING_DIR, run.id);
    await mkdir(dir, { recursive: true });
    try {
      await writeJsonSeen(join(dir, 'run.json'), run, {
        backup: true,
        name: `${ENGINEERING_DIR}/${run.id}/run.json`,
      });
    } catch (e) {
      if (isChangedOnDisk(e)) return { ok: false, error: e.message };
      throw e;
    }
    return { ok: true };
  });

  handle('engineer:evidenceImage', async ({ projectId, runId, imageId }) => {
    if (projects.package(projectId))
      return { ok: false, error: 'Evidence images are not kept in packages.' };
    const root = projects.root(projectId);
    if (root === undefined) return notOpen(projectId);
    const dir = join(root, ENGINEERING_DIR, runId);
    const ev = await readRunFile(
      join(dir, 'evidence.json'),
      `${ENGINEERING_DIR}/${runId}/evidence.json`,
      EvidencePack,
    );
    if (!ev.ok) return ev;
    const image = ev.value?.images.find((i) => i.id === imageId);
    if (!image) return { ok: false, error: `The run has no evidence image "${imageId}".` };
    const refused = {
      ok: false as const,
      error: `"${image.file}" is not one of the run's images.`,
    };
    // a plain path under img/ in the run folder, an image type, and still there once links resolve
    if (isAbsolute(image.file) || image.file.includes('\\')) return refused;
    const mime = MIME[extname(image.file).toLowerCase()];
    if (!mime) return refused;
    const imgDir = join(dir, 'img');
    const file = resolve(dir, image.file);
    const inside = (base: string, p: string) => {
      const r = relative(base, p);
      return r !== '' && !r.startsWith(`..${sep}`) && r !== '..' && !isAbsolute(r);
    };
    if (!inside(imgDir, file)) return refused;
    let real: string;
    try {
      real = await realpath(file);
      if (!inside(await realpath(imgDir), real)) return refused;
    } catch {
      return { ok: false, error: `The evidence image "${image.file}" is missing.` };
    }
    if ((await stat(real)).size > EVIDENCE_IMAGE_MAX_BYTES) return refused;
    let bytes: Uint8Array = new Uint8Array(await readFile(real));
    let type = mime;
    const size = imageSize(bytes) ?? { w: image.w, h: image.h };
    if (Math.max(size.w, size.h, image.w, image.h) > EVIDENCE_IMAGE_MAX_PX) {
      if (!images)
        return {
          ok: false,
          error: `The evidence image "${image.file}" is larger than ${String(EVIDENCE_IMAGE_MAX_PX)} px.`,
        };
      const small = await images.downscale(bytes, EVIDENCE_IMAGE_MAX_PX);
      bytes = small.bytes;
      type = small.mime;
    }
    return { ok: true, dataUrl: `data:${type};base64,${Buffer.from(bytes).toString('base64')}` };
  });
}
