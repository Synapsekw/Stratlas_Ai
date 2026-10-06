/**
 * Detector model registry (data-conventions section 16): models a person imported into
 * `<userData>/models/detect/<id>/` (or `Settings.inference.modelsDir`) and any a pipeline pack
 * carries in `<pack>/models/detect/<id>/`. Each folder holds `model.onnx` and its `model.json`
 * card (`aio.detector/1`).
 *
 * Import refuses, with an exact message: a file that is not there, a model without a card, an
 * invalid card, a licence the gate does not allow, an unconfirmed licence, an oversized file, a
 * SHA-256 that does not match the card, and a model the runtime cannot load or whose outputs do
 * not fit the card's layout (one dummy inference). Then it copies both files in atomically.
 */
import { DetectorModelCard, DetectorModelId, type DetectorModelInfo } from '@aio/schema';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, readdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import { licenceProblem } from './licence';

export const MODEL_FILE = 'model.onnx';
export const CARD_FILE = 'model.json';
/** Largest model accepted (onnxruntime cannot load protobufs over 2 GB anyway). */
export const MAX_MODEL_BYTES = 1024 * 1024 * 1024;

export interface ModelDirs {
  user: string;
  pack: string | null;
}

export interface FoundModel {
  info: DetectorModelInfo;
  onnx: string;
}

const isFile = (p: string) =>
  stat(p).then(
    (s) => s.isFile(),
    () => false,
  );

/** SHA-256 of a file, streamed. */
export function fileSha256(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    createReadStream(path)
      .on('data', (c) => h.update(c))
      .on('error', reject)
      .on('end', () => {
        resolve(h.digest('hex'));
      });
  });
}

/** The card's first problem as one sentence, or the card. */
export function parseCard(
  raw: unknown,
): { ok: true; card: DetectorModelCard } | { ok: false; error: string } {
  const r = DetectorModelCard.safeParse(raw);
  if (r.success) return { ok: true, card: r.data };
  const first = r.error.issues[0];
  const where = first?.path.length ? ` (${first.path.join('.')})` : '';
  return {
    ok: false,
    error: `The model card is not valid${where}: ${first?.message ?? 'unknown problem'}`,
  };
}

async function readCard(
  path: string,
): Promise<{ ok: true; card: DetectorModelCard } | { ok: false; error: string }> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, 'utf8'));
  } catch (e) {
    return {
      ok: false,
      error: `The model card ${basename(path)} is not JSON: ${String(e).slice(0, 200)}`,
    };
  }
  return parseCard(raw);
}

async function listIn(dir: string | null, where: 'user' | 'pack'): Promise<FoundModel[]> {
  if (!dir) return [];
  let names: string[];
  try {
    names = (await readdir(dir, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
  const out: FoundModel[] = [];
  for (const id of names.sort()) {
    if (!DetectorModelId.safeParse(id).success) continue;
    const onnx = join(dir, id, MODEL_FILE);
    const s = await stat(onnx).catch(() => null);
    if (!s?.isFile()) continue;
    const card = await readCard(join(dir, id, CARD_FILE));
    if (!card.ok) continue;
    out.push({ info: { id, card: card.card, where, sizeBytes: s.size }, onnx });
  }
  return out;
}

/** Installed models: the person's first, then the pipeline pack's (an id in both is the person's). */
export async function listModels(dirs: ModelDirs): Promise<FoundModel[]> {
  const user = await listIn(dirs.user, 'user');
  const pack = (await listIn(dirs.pack, 'pack')).filter(
    (p) => !user.some((u) => u.info.id === p.info.id),
  );
  return [...user, ...pack];
}

export async function findModel(dirs: ModelDirs, id: string): Promise<FoundModel | null> {
  return (await listModels(dirs)).find((m) => m.info.id === id) ?? null;
}

/** `model.onnx` and `model.json` from a folder, either file, or a `.onnx` with a `.json` beside it. */
export async function locateModelFiles(
  path: string,
): Promise<{ ok: true; onnx: string; card: string } | { ok: false; error: string }> {
  const s = await stat(path).catch(() => null);
  if (!s) return { ok: false, error: `${path} does not exist.` };
  if (s.isDirectory()) {
    const onnx = join(path, MODEL_FILE);
    if (!(await isFile(onnx))) {
      const any = (await readdir(path)).find((n) => n.toLowerCase().endsWith('.onnx'));
      if (!any) return { ok: false, error: `There is no .onnx model in ${path}.` };
      return locateModelFiles(join(path, any));
    }
    return (await isFile(join(path, CARD_FILE)))
      ? { ok: true, onnx, card: join(path, CARD_FILE) }
      : { ok: false, error: noCard(path) };
  }
  const ext = extname(path).toLowerCase();
  const dir = dirname(path);
  if (ext === '.json') {
    const onnx = join(dir, MODEL_FILE);
    const sibling = path.slice(0, -ext.length) + '.onnx';
    for (const o of [onnx, sibling]) if (await isFile(o)) return { ok: true, onnx: o, card: path };
    return { ok: false, error: `There is no model.onnx next to ${basename(path)}.` };
  }
  if (ext !== '.onnx')
    return { ok: false, error: `${basename(path)} is not an ONNX model (.onnx).` };
  for (const c of [path.slice(0, -ext.length) + '.json', join(dir, CARD_FILE)])
    if (await isFile(c)) return { ok: true, onnx: path, card: c };
  return { ok: false, error: noCard(basename(path)) };
}

const noCard = (what: string) =>
  `${what} has no model card (model.json, aio.detector/1). A card with the model's licence is required to import it.`;

/** A folder name for the card: name and version, lower case, unique in the folder. */
export function modelIdFor(card: DetectorModelCard, taken: ReadonlySet<string>): string {
  const slug = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^[^a-z0-9]+|-+$/g, '');
  const base = (`${slug(card.name)}-${slug(card.version)}`.replace(/^-+/, '') || 'model').slice(
    0,
    56,
  );
  let id = base;
  for (let i = 2; taken.has(id); i++) id = `${base}-${i}`;
  return id;
}

/** One dummy inference: null when the outputs fit the card's layout, else why not. */
export type ProbeModel = (onnx: string, card: DetectorModelCard) => Promise<string | null>;

export async function importModel(
  req: { path: string; acceptLicence: boolean },
  dirs: ModelDirs,
  probe: ProbeModel,
): Promise<{ ok: true; model: DetectorModelInfo } | { ok: false; error: string }> {
  const files = await locateModelFiles(req.path);
  if (!files.ok) return files;
  const card = await readCard(files.card);
  if (!card.ok) return card;
  const c = card.card;
  const licence = licenceProblem(c.licence);
  if (licence) return { ok: false, error: licence };
  if (!req.acceptLicence)
    return {
      ok: false,
      error: `Confirm that you may use "${c.name}" under its licence (${c.licence}) to import it.`,
    };
  const size = (await stat(files.onnx)).size;
  if (size > MAX_MODEL_BYTES)
    return {
      ok: false,
      error: `${basename(files.onnx)} is ${Math.round(size / 1024 / 1024)} MB. Models up to 1024 MB can be imported.`,
    };
  const sha = await fileSha256(files.onnx);
  if (sha !== c.sha256)
    return {
      ok: false,
      error: `${basename(files.onnx)} does not match its card: SHA-256 ${sha.slice(0, 12)}... on disk, ${c.sha256.slice(0, 12)}... on the card. The file may be damaged or replaced.`,
    };
  const existing = await listIn(dirs.user, 'user');
  const same = existing.find((m) => m.info.card.sha256 === sha);
  if (same) return { ok: true, model: same.info };
  const problem = await probe(files.onnx, c);
  if (problem) return { ok: false, error: problem };
  const id = modelIdFor(c, new Set(existing.map((m) => m.info.id)));
  const staging = join(dirs.user, `.import-${randomUUID().slice(0, 8)}`);
  try {
    await mkdir(staging, { recursive: true });
    await copyFile(files.onnx, join(staging, MODEL_FILE));
    await copyFile(files.card, join(staging, CARD_FILE));
    await rename(staging, join(dirs.user, id));
  } catch (e) {
    await rm(staging, { recursive: true, force: true });
    return {
      ok: false,
      error: `The model could not be copied into ${dirs.user}: ${String(e).slice(0, 200)}`,
    };
  }
  return { ok: true, model: { id, card: c, where: 'user', sizeBytes: size } };
}

export async function removeModel(
  dirs: ModelDirs,
  id: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const user = await listIn(dirs.user, 'user');
  if (!user.some((m) => m.info.id === id)) {
    const pack = await listIn(dirs.pack, 'pack');
    return pack.some((m) => m.info.id === id)
      ? { ok: false, error: `"${id}" comes with the pipeline pack and cannot be removed here.` }
      : { ok: false, error: `There is no detector model "${id}".` };
  }
  try {
    await rm(join(dirs.user, id), { recursive: true, force: true });
  } catch (e) {
    return { ok: false, error: `The model could not be removed: ${String(e).slice(0, 200)}` };
  }
  return { ok: true };
}
