/**
 * Detection passes for the review (BLD-5): every `aio.detections/1` file in
 * `<project>/detections/` (data-conventions section 11), the pixel size of the photos whose boxes
 * are in preview space, and the inspection pipeline's issue map (so the review shows what the
 * pipeline already turned into issues). Read from folders and packages; a pass is written only
 * into a folder, atomically, with a `.bak`. Files the review cannot read (kit lists, COCO, YOLO,
 * invalid ones) are reported and never touched.
 */
import { DetectionsFile, type IpcResponse, type ProjectManifest } from '@aio/schema';
import { open, mkdir, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writeJsonAtomic } from './fsutil';
import { newerOnDisk, newerThanThisBuild } from './newer';
import { resolveInside } from './protocol/paths';

export const DETECTIONS_DIR = 'detections';
export const ISSUES_MAP = 'inspection/issues-map.json';
const HEAD_BYTES = 256 * 1024;

type ReadResult = IpcResponse<'detections:read'>;

/** Where a project's files come from: a folder or a package. */
export interface ProjectFiles {
  /** File names directly in `detections/`. */
  passNames(): Promise<string[]>;
  /** A project-relative file, or null when it is not there. */
  read(rel: string): Promise<Buffer | null>;
  /** The first bytes of a project-relative file (image headers), or null. */
  head(rel: string, bytes: number): Promise<Buffer | null>;
}

export function folderFiles(root: string): ProjectFiles {
  const inside = async (rel: string) => {
    const r = await resolveInside(root, rel);
    return r.ok ? r.path : null;
  };
  return {
    passNames: async () => {
      try {
        const list = await readdir(join(root, DETECTIONS_DIR), { withFileTypes: true });
        return list.filter((e) => e.isFile()).map((e) => e.name);
      } catch {
        return [];
      }
    },
    read: async (rel) => {
      const p = await inside(rel);
      return p ? readFile(p).catch(() => null) : null;
    },
    head: async (rel, bytes) => {
      const p = await inside(rel);
      if (!p) return null;
      try {
        const fh = await open(p, 'r');
        try {
          const buf = Buffer.alloc(bytes);
          const { bytesRead } = await fh.read(buf, 0, bytes, 0);
          return buf.subarray(0, bytesRead);
        } finally {
          await fh.close();
        }
      } catch {
        return null;
      }
    },
  };
}

export function packageFiles(archive: {
  entries: ReadonlyMap<string, unknown>;
  read(name: string): Promise<Buffer>;
}): ProjectFiles {
  const read = async (rel: string) =>
    archive.entries.has(rel) ? archive.read(rel).catch(() => null) : null;
  return {
    passNames: () =>
      Promise.resolve(
        [...archive.entries.keys()]
          .filter((n) => n.startsWith(`${DETECTIONS_DIR}/`))
          .map((n) => n.slice(DETECTIONS_DIR.length + 1))
          .filter((n) => n.length > 0 && !n.includes('/')),
      ),
    read,
    head: read,
  };
}

/** Width and height from a JPEG (SOF marker) or PNG (IHDR) header, or null. */
export function imageSize(b: Uint8Array): [number, number] | null {
  if (b.length > 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
    return [v.getUint32(16), v.getUint32(20)];
  }
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) {
      i++;
      continue;
    }
    const m = b[i + 1] ?? 0;
    if (m === 0xff) {
      i++;
      continue;
    }
    if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) {
      i += 2;
      continue;
    }
    const len = ((b[i + 2] ?? 0) << 8) | (b[i + 3] ?? 0);
    const sof = m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc;
    if (sof) {
      const h = ((b[i + 5] ?? 0) << 8) | (b[i + 6] ?? 0);
      const w = ((b[i + 7] ?? 0) << 8) | (b[i + 8] ?? 0);
      return w > 0 && h > 0 ? [w, h] : null;
    }
    i += 2 + len;
  }
  return null;
}

/** Issue id to the detection ids the inspection pipeline made it from. */
export function parseIssuesMap(raw: unknown): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  const issues = (raw as { issues?: unknown } | null)?.issues;
  if (typeof issues !== 'object' || issues === null) return out;
  for (const [id, e] of Object.entries(issues as Record<string, unknown>)) {
    const dets = (e as { detections?: unknown } | null)?.detections;
    if (Array.isArray(dets)) out[id] = dets.filter((d): d is string => typeof d === 'string');
  }
  return out;
}

const json = (b: Buffer) => JSON.parse(b.toString('utf8').replace(/^\uFEFF/, '')) as unknown;

/** Every pass, the photo sizes the review needs and the pipeline's issue map. */
export async function readDetectionPasses(
  files: ProjectFiles,
  manifest: ProjectManifest,
  readOnly: boolean,
): Promise<ReadResult> {
  const photos = manifest.layers.flatMap((l) =>
    l.kind === 'photos' ? l.items.map((p) => ({ layer: l.id, photo: p.id, src: p.src })) : [],
  );
  const layerOf = (photo: string, fileLayer: string | undefined) =>
    photos.find((p) => p.photo === photo && (fileLayer === undefined || p.layer === fileLayer));
  const passes: { name: string; file: DetectionsFile }[] = [];
  const problems: { name: string; error: string }[] = [];
  for (const name of (await files.passNames()).sort()) {
    if (!name.toLowerCase().endsWith('.json') || name.startsWith('.')) continue;
    const buf = await files.read(`${DETECTIONS_DIR}/${name}`);
    let raw: unknown;
    try {
      raw = buf ? json(buf) : undefined;
    } catch (e) {
      problems.push({ name, error: `not JSON: ${String(e).slice(0, 200)}` });
      continue;
    }
    const newer = newerThanThisBuild(raw, 'aio.detections', `${DETECTIONS_DIR}/${name}`);
    if (newer) {
      problems.push({ name, error: newer });
      continue;
    }
    if ((raw as { schema?: unknown } | null)?.schema !== 'aio.detections/1') {
      problems.push({
        name,
        error:
          'not aio.detections/1 (a kit list or COCO file); the pipeline reads it, the review does not',
      });
      continue;
    }
    const parsed = DetectionsFile.safeParse(raw);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      const where = first?.path.length ? ` at ${first.path.join('.')}` : '';
      problems.push({ name, error: `invalid${where}: ${first?.message ?? 'unknown error'}` });
      continue;
    }
    passes.push({ name, file: parsed.data });
  }
  // photo sizes for boxes in preview space
  const sizes: Record<string, [number, number]> = {};
  const wanted = new Map<string, { path: string }>();
  for (const { file } of passes) {
    for (const d of file.detections) {
      const space = d.space ?? 'preview';
      // preview boxes, and source boxes without their size, are in the photo file's pixels
      const needs = (space === 'preview' || space === 'source') && !(d.width && d.height);
      if (!needs || !d.photo) continue;
      const p = layerOf(d.photo, file.layer);
      if (p && 'path' in p.src) wanted.set(`${p.layer}/${p.photo}`, { path: p.src.path });
    }
  }
  for (const [key, { path }] of wanted) {
    const head = await files.head(path.replace(/\\/g, '/'), HEAD_BYTES);
    const size = head ? imageSize(head) : null;
    if (size) sizes[key] = size;
  }
  let issuesMap: Record<string, string[]> = {};
  const map = await files.read(ISSUES_MAP);
  if (map) {
    try {
      issuesMap = parseIssuesMap(json(map));
    } catch {
      problems.push({ name: ISSUES_MAP, error: 'not JSON; pipeline issues are not shown' });
    }
  }
  return { ok: true, files: passes, problems, sizes, issuesMap, readOnly };
}

/** Replace `<root>/detections/<name>` atomically, keeping the previous file as `.bak`. */
export async function writeDetectionPass(
  root: string,
  name: string,
  file: DetectionsFile,
): Promise<{ ok: boolean; error?: string }> {
  const dir = join(root, DETECTIONS_DIR);
  const target = join(dir, name);
  const newer = await newerOnDisk(target, 'aio.detections', `${DETECTIONS_DIR}/${name}`);
  if (newer) return { ok: false, error: newer };
  try {
    await mkdir(dir, { recursive: true });
    await writeJsonAtomic(target, file, { backup: true });
  } catch (e) {
    return { ok: false, error: `Could not save ${target}: ${String(e)}` };
  }
  return { ok: true };
}
