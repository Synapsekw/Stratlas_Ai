import { updateManifestFile } from '@aio/project/builder';
import type { Issue, ProjectManifest } from '@aio/schema';
import { nativeImage } from 'electron';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import { readIssues, readManifest, writeIssues } from './project';
import { resolveInside } from './protocol/paths';
import { turnLens90, turnQuat90 } from './rotateBgra';
import { bitmapSize, turnNativeImage } from './rotateNative';
import { projectThumbPath } from './thumbs';

const LOCKED = new Set(['EPERM', 'EACCES', 'EBUSY']);
const THUMB_PX = 320;

interface OpenProjects {
  root(projectId: string): string | undefined;
}

export type RotatePhotoResult =
  { ok: true; issues: Issue[]; manifest: ProjectManifest } | { ok: false; error: string };

const fail = (error: string): RotatePhotoResult => ({ ok: false, error });

/** Rename `from` over `to`, retrying while Windows has the destination open for reading. */
async function renameOver(from: string, to: string): Promise<void> {
  for (let wait = 10; ; wait *= 2) {
    try {
      await rename(from, to);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code ?? '';
      if (process.platform !== 'win32' || !LOCKED.has(code) || wait > 1280) throw e;
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
}

async function replaceFile(dest: string, bytes: Buffer): Promise<void> {
  const tmp = `${dest}.turning`;
  await writeFile(tmp, bytes);
  try {
    await renameOver(tmp, dest);
  } catch (e) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw e;
  }
}

/**
 * Turn one project photo 90 degrees clockwise: the file, its thumbnail, every image sighting
 * on it, and a pinhole or f-theta lens so it still matches the pixels.
 */
export async function rotateProjectPhoto(
  registry: OpenProjects,
  req: { projectId: string; layerId: string; photoId: string },
): Promise<RotatePhotoResult> {
  const root = registry.root(req.projectId);
  if (root === undefined) return fail(`Project "${req.projectId}" is not open.`);
  const manifest = await readManifest(root);
  if (!manifest.ok) return fail(manifest.error);
  const layer = manifest.value.layers.find((l) => l.id === req.layerId);
  if (layer?.kind !== 'photos') return fail('That layer is not a photos layer.');
  const photo = layer.items.find((p) => p.id === req.photoId);
  if (!photo) return fail('That photo is not in this layer.');
  if (!('path' in photo.src)) return fail('This photo has no file to turn.');
  const resolved = await resolveInside(root, photo.src.path.replace(/\\/g, '/'));
  if (!resolved.ok) return fail('This photo has no file to turn.');
  const ext = extname(resolved.path).toLowerCase();
  if (ext !== '.jpg' && ext !== '.jpeg' && ext !== '.png') {
    return fail('Only a JPEG or PNG photo can be turned.');
  }

  const issues = await readIssues(root);
  if (!issues.ok) return fail(issues.error);
  if (
    issues.value.some((issue) =>
      issue.sightings.some(
        (s) =>
          s.on === 'image' &&
          s.layer === req.layerId &&
          s.photo === req.photoId &&
          s.geom.type === 'mask',
      ),
    )
  ) {
    return fail(
      'This photo has mask annotations. Rotation is unavailable because the mask and its overlay must stay aligned.',
    );
  }

  const img = nativeImage.createFromPath(resolved.path);
  if (img.isEmpty()) return fail('The image could not be decoded.');
  let pixels: { width: number; height: number };
  try {
    pixels = bitmapSize(img);
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
  let lens: typeof photo.lens;
  try {
    lens = photo.lens ? turnLens90(photo.lens, pixels.width, pixels.height) : undefined;
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
  const q = photo.q ? turnQuat90(photo.q) : undefined;
  const turned = turnNativeImage(img, 1);
  const bytes = ext === '.png' ? turned.toPNG() : turned.toJPEG(90);

  const { turnIssueSightings } = await import('@aio/project/import');
  const sightings = turnIssueSightings(
    issues.value,
    req.layerId,
    new Map([[req.photoId, { turn: 1 as const, width: pixels.width, height: pixels.height }]]),
  );

  if (sightings.changes.length > 0) {
    const wrote = await writeIssues(root, sightings.issues);
    if (!wrote.ok) return fail(wrote.error ?? 'The marks on this photo could not be saved.');
  }

  try {
    await replaceFile(resolved.path, bytes);
  } catch (e) {
    if (sightings.changes.length > 0) {
      await writeIssues(root, issues.value).catch(() => undefined);
    }
    return fail(`The photo could not be saved: ${e instanceof Error ? e.message : String(e)}`);
  }

  const thumbRel = projectThumbPath(photo.src.path.replace(/\\/g, '/'));
  if (thumbRel) {
    try {
      const { width, height } = turned.getSize();
      const long = Math.max(width, height);
      const thumb =
        long > THUMB_PX
          ? turned.resize(
              width >= height
                ? { width: THUMB_PX, quality: 'good' }
                : { height: THUMB_PX, quality: 'good' },
            )
          : turned;
      const dest = join(root, ...thumbRel.split('/'));
      await mkdir(dirname(dest), { recursive: true });
      await replaceFile(dest, thumb.toJPEG(80));
    } catch {
      // the photo itself is turned; a stale thumbnail refreshes on the next cache miss
    }
  }

  if (!lens && !q) {
    return { ok: true, issues: sightings.issues, manifest: manifest.value };
  }
  const updated = await updateManifestFile(root, (current) => ({
    manifest: {
      ...current,
      layers: current.layers.map((l) => {
        if (l.id !== req.layerId || l.kind !== 'photos') return l;
        return {
          ...l,
          items: l.items.map((p) =>
            p.id === req.photoId
              ? {
                  ...p,
                  ...(lens ? { lens } : {}),
                  ...(q ? { q } : {}),
                }
              : p,
          ),
        };
      }),
    },
  }));
  return { ok: true, issues: sightings.issues, manifest: updated.manifest };
}
