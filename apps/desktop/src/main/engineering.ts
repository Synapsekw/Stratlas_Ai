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
import {
  componentRegister,
  exportBundle,
  validateGlb,
  type KhronosValidator,
} from '@aio/modelling';
import {
  DETAIL_BUDGETS,
  EngineerProposal,
  EngineerRun,
  RunId,
  EvidencePack,
  PROCMODEL_DIR,
  type GlbCheckReport,
  type ProjectManifest,
} from '@aio/schema';
import { mkdir, open, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { z } from 'zod';
import { isChangedOnDisk, readBytesSeen, writeJsonSeen } from './fsutil';
import {
  acceptPlacement,
  buildModelLayer,
  modelFile,
  modelGlb,
  modelLayerId,
  parseModel,
  readModelFile,
  writeBytesAtomic,
  type ModelProjects,
} from './modelBuilder';
import type { Handle } from './notYet';
import { engineeringSourceStamp } from './evidencePolicy';

/** The builder library loads on first use (see modelBuilder.ts). */
const lib = () => import('@aio/project/builder');

export const ENGINEERING_DIR = 'engineering';
/** The long side of an evidence image sent to a model or shown in the send preview. */
export const EVIDENCE_IMAGE_MAX_PX = 1568;
/** An evidence image file larger than this is not read at all. */
const EVIDENCE_IMAGE_MAX_BYTES = 32 * 1024 * 1024;
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
  /** The Khronos glTF validator (default: `gltf-validator`, loaded on first use). */
  khronos?: KhronosValidator;
  /** The clock of a build (tests). */
  now?: () => Date;
}

const SEVERITY = ['error', 'warning', 'information', 'hint'];

/** The Khronos glTF validator as `validateGlb` takes it, loaded the first time a file is checked. */
export const khronosValidator: KhronosValidator = async (glb) => {
  const { validateBytes } = await import('gltf-validator');
  const r = await validateBytes(glb, { format: 'glb', maxIssues: 50, writeTimestamp: false });
  return {
    errors: r.issues.numErrors,
    warnings: r.issues.numWarnings,
    messages: r.issues.messages
      .filter((m) => m.severity <= 1)
      .map(
        (m) =>
          `${SEVERITY[m.severity] ?? 'issue'} ${m.code}: ${m.message}${m.pointer ? ` (${m.pointer})` : ''}`,
      ),
  };
};

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

export { acceptPlacement, type AcceptPlacement } from './modelBuilder';

/** Why an accepted GLB is refused (validator errors, broken positions or indices), or null. */
export function acceptRefusal(r: GlbCheckReport): string | null {
  const reasons = [
    r.validatorErrors ? `${String(r.validatorErrors)} glTF validator errors` : '',
    r.finite ? '' : 'positions that are not finite numbers',
    r.indicesValid ? '' : 'indices outside their vertices',
  ].filter(Boolean);
  if (!reasons.length) return null;
  return `The model was not accepted: its GLB has ${reasons.join(', ')}. ${r.messages.slice(0, 3).join(' ')}`.trim();
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
  khronos,
  now = () => new Date(),
}: EngineeringIpcDeps): void {
  const notOpen = (id: string) => ({ ok: false as const, error: `Project "${id}" is not open.` });
  const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

  handle('engineer:sourceStamp', async ({ projectId, setup }) => {
    const root = projects.root(projectId);
    if (!root) return { ok: false, error: 'The project is not open.' };
    try {
      return { ok: true, signature: await engineeringSourceStamp(root, setup) };
    } catch {
      return {
        ok: false,
        error: 'A selected source is missing or unreadable. Re-select the modelling inputs.',
      };
    }
  });
  handle('model:exportEngineering', async ({ projectId, modelId, folder, detail, replace }) => {
    // the contract refuses a relative folder; main checks again with the platform's own rule
    if (!isAbsolute(folder))
      return { ok: false, error: 'The export folder must be an absolute path.' };
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
      // Where the model is: its built layer in the project, else the model's own record as it
      // is. With neither there is no placement to export.
      const georef = mesh
        ? layerTransformToGeoref(
            mesh.transform,
            { crs: manifest.crs, origin: manifest.origin },
            mesh.georef ?? model.georef ?? null,
            'engineer',
          )
        : (model.georef ?? null);
      if (!georef)
        return {
          ok: false,
          error: 'Build the model first, then export it: it has no place in the project yet.',
        };
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

  handle('engineer:runList', async ({ projectId }) => {
    if (projects.package(projectId)) return { ok: true, runs: [] };
    const root = projects.root(projectId);
    if (root === undefined) return notOpen(projectId);
    const dirs = await readdir(join(root, ENGINEERING_DIR), { withFileTypes: true }).catch(
      () => [],
    );
    const runs = [];
    for (const d of dirs) {
      if (!d.isDirectory() || !RunId.safeParse(d.name).success) continue;
      const rel = `${ENGINEERING_DIR}/${d.name}/run.json`;
      const r = await readRunFile(join(root, rel), rel, EngineerRun, true);
      if (r.ok && r.value)
        runs.push({ id: r.value.id, modelId: r.value.modelId, createdAt: r.value.createdAt });
    }
    return {
      ok: true,
      runs: runs.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 100),
    };
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

  handle('engineer:runWrite', async ({ projectId, run, proposal }) => {
    if (projects.package(projectId)) return READ_ONLY;
    const root = projects.root(projectId);
    if (root === undefined) return notOpen(projectId);
    const dir = join(root, ENGINEERING_DIR, run.id);
    await mkdir(dir, { recursive: true });
    try {
      // the proposal first: a run.json that says identify is done always has its proposal
      if (proposal)
        await writeJsonSeen(join(dir, 'proposal.json'), proposal, {
          backup: true,
          name: `${ENGINEERING_DIR}/${run.id}/proposal.json`,
        });
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

  handle('engineer:validate', async ({ projectId, modelId, draft, detail }) => {
    const pkg = projects.package(projectId);
    const root = pkg ? undefined : projects.root(projectId);
    if (!pkg && root === undefined) return notOpen(projectId);
    const rel = modelGlb(modelId, draft);
    let glb: Uint8Array | null;
    if (pkg)
      glb = pkg.archive.entries.has(rel) ? new Uint8Array(await pkg.archive.read(rel)) : null;
    else
      glb = await readFile(join(root ?? '', ...rel.split('/')))
        .then((b) => new Uint8Array(b))
        .catch(() => null);
    if (!glb) return { ok: false, error: `${rel} is not there: build the model first.` };
    try {
      const report = await validateGlb(glb, {
        budget: DETAIL_BUDGETS[detail].triangles,
        khronos: khronos ?? khronosValidator,
      });
      return { ok: true, report: { ...report, messages: report.messages.slice(0, 200) } };
    } catch (e) {
      return { ok: false, error: `${rel} could not be checked: ${errText(e)}` };
    }
  });

  handle('engineer:accept', async ({ projectId, modelId }) => {
    if (projects.package(projectId)) return READ_ONLY;
    const root = projects.root(projectId);
    if (root === undefined) return notOpen(projectId);
    const read = await readModelFile(root, modelId);
    if (!read.ok) return read;
    const manifest = await (await lib()).readManifestFile(root);
    const placement = acceptPlacement(
      read.model.georef,
      manifest.layers.find((l) => l.id === modelLayerId(modelId, false)),
      { crs: manifest.crs, origin: manifest.origin },
    );
    const checked: { report: GlbCheckReport | null } = { report: null };
    const built = await buildModelLayer(root, modelId, {
      draft: false,
      now: now(),
      placement,
      // the accepted GLB is checked as it will be written, before anything changes
      check: async (glb) => {
        const r = await validateGlb(glb, {
          budget: Number.MAX_SAFE_INTEGER,
          khronos: khronos ?? khronosValidator,
        });
        checked.report = { ...r, messages: r.messages.slice(0, 200) };
        return acceptRefusal(r);
      },
    });
    if (!built.ok) return built;
    const files: string[] = [];
    const register = `${JSON.stringify(componentRegister(built.model), null, 2)}\n`;
    const write = async (rel: string, text: string) => {
      await writeBytesAtomic(join(root, ...rel.split('/')), new TextEncoder().encode(text));
      files.push(rel);
    };
    const sidecar = `${PROCMODEL_DIR}/${modelId}.georeference.json`;
    if (placement.georef) await write(sidecar, `${JSON.stringify(placement.georef, null, 2)}\n`);
    // no georeference: one left from an earlier accept would no longer say where the model is
    else await rm(join(root, ...sidecar.split('/')), { force: true });
    await write(`${PROCMODEL_DIR}/${modelId}.components.json`, register);
    const check = checked.report;
    if (!check) return { ok: false, error: 'The accepted model was not checked.' };
    return {
      ok: true,
      layer: built.layer,
      files,
      ...(built.report ? { report: built.report } : {}),
      check,
    };
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
    // one open, read with a bound: the file cannot grow between a size check and the read
    let bytes: Uint8Array;
    const fh = await open(real, 'r');
    try {
      const buf = new Uint8Array(EVIDENCE_IMAGE_MAX_BYTES + 1);
      let n = 0;
      for (;;) {
        const { bytesRead } = await fh.read(buf, n, buf.length - n, n);
        if (bytesRead === 0) break;
        n += bytesRead;
        if (n > EVIDENCE_IMAGE_MAX_BYTES) return refused;
      }
      bytes = buf.slice(0, n);
    } finally {
      await fh.close();
    }
    let type = mime;
    const size = imageSize(bytes);
    // a size the header does not tell (WebP) is never taken on trust: it is always scaled
    if (!size || Math.max(size.w, size.h) > EVIDENCE_IMAGE_MAX_PX) {
      if (!images)
        return {
          ok: false,
          error: `The evidence image "${image.file}" is larger than ${String(EVIDENCE_IMAGE_MAX_PX)} px or its size cannot be read.`,
        };
      const small = await images.downscale(bytes, EVIDENCE_IMAGE_MAX_PX);
      bytes = small.bytes;
      type = small.mime;
    }
    return { ok: true, dataUrl: `data:${type};base64,${Buffer.from(bytes).toString('base64')}` };
  });
}
