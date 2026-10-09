/**
 * The site's terrain overlays (`survey/overlays.json`, `aio.survey-overlays/1`, data-conventions
 * section 29; M11 G5). `survey.overlay` (the pipeline) makes an overlay's files in
 * `survey/overlays/<id>/` and lists it; the app changes what a person may change: an overlay's name
 * and visibility, and removing it (its folder is deleted with it). What the pipeline wrote (kind,
 * source, options, folder, fingerprint, files) is never changed here, and an overlay the pipeline
 * did not make cannot be added. Written atomically with a `.bak`; a package's file is read in
 * place and never written. Overlays are not journaled: they are derived views, made again from
 * their surfaces by the pipeline.
 */
import {
  OVERLAYS_DIR,
  OVERLAYS_FILE,
  SurveyOverlaysFile,
  type IpcResponse,
  type SurveyOverlaysFile as SurveyOverlaysFileT,
} from '@aio/schema';
import { access, mkdir, readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { isChangedOnDisk, readJsonSeen, writeJsonSeen } from './fsutil';
import { newerOnDisk, newerThanThisBuild } from './newer';
import type { Handle } from './notYet';

const FAMILY = 'aio.survey-overlays';
const READ_ONLY = 'This project is a read-only package. Its overlays cannot be changed.';
/** Fields `survey.overlay` wrote; a save that changes one is refused. */
const FIXED = ['kind', 'source', 'options', 'dir', 'fingerprint', 'createdAt', 'files'] as const;

export const emptyOverlays = (): SurveyOverlaysFileT => ({
  schema: 'aio.survey-overlays/1',
  overlays: [],
});

interface Archive {
  entries: ReadonlyMap<string, unknown>;
  read(name: string): Promise<Buffer>;
}

export interface SurveyOverlaysDeps {
  handle: Handle;
  projects: { root(id: string): string | undefined; package(id: string): unknown };
  projectPackage?: (id: string) => Archive | undefined;
}

function why(e: unknown): string {
  const code = (e as NodeJS.ErrnoException).code;
  if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS')
    return 'the project folder is read only';
  return e instanceof Error ? e.message : String(e);
}

function parse(
  raw: unknown,
): { ok: true; file: SurveyOverlaysFileT } | { ok: false; error: string } {
  const newer = newerThanThisBuild(raw, FAMILY, OVERLAYS_FILE);
  if (newer) return { ok: false, error: newer };
  const parsed = SurveyOverlaysFile.safeParse(raw);
  if (parsed.success) return { ok: true, file: parsed.data };
  const first = parsed.error.issues[0];
  const where = first?.path.length ? ` at ${first.path.map(String).join('.')}` : '';
  return {
    ok: false,
    error: `${OVERLAYS_FILE} is invalid${where}: ${first?.message ?? 'unknown error'}`,
  };
}

/** `survey/overlays.json` of a project folder; an empty list when the site has none. */
export async function readOverlays(
  root: string,
  remember = true,
): Promise<{ ok: true; file: SurveyOverlaysFileT } | { ok: false; error: string }> {
  let raw: unknown;
  const path = join(root, ...OVERLAYS_FILE.split('/'));
  try {
    if (remember) raw = await readJsonSeen(path);
    else {
      const text = await readFile(path, 'utf8').catch((e: unknown) => {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw e;
      });
      raw = text === undefined ? undefined : (JSON.parse(text) as unknown);
    }
  } catch (e) {
    return { ok: false, error: `Could not read the overlays: ${why(e)}` };
  }
  return raw === undefined ? { ok: true, file: emptyOverlays() } : parse(raw);
}

/** A package's overlays, read from the archive in place. */
export async function readPackageOverlays(
  archive: Archive,
): Promise<{ ok: true; file: SurveyOverlaysFileT } | { ok: false; error: string }> {
  if (!archive.entries.has(OVERLAYS_FILE)) return { ok: true, file: emptyOverlays() };
  try {
    const text = (await archive.read(OVERLAYS_FILE)).toString('utf8');
    return parse(JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text));
  } catch (e) {
    return { ok: false, error: `Could not read the overlays: ${why(e)}` };
  }
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const folderOf = (id: string) => `${OVERLAYS_DIR}/${id}`;

/** Why a save may not go from `before` to `after`, or null when it may. */
export function checkOverlaysChange(
  before: SurveyOverlaysFileT,
  after: SurveyOverlaysFileT,
): string | null {
  const old = new Map(before.overlays.map((o) => [o.id, o]));
  const ids = new Set<string>();
  for (const o of after.overlays) {
    if (ids.has(o.id)) return `The overlay id "${o.id}" is used twice.`;
    ids.add(o.id);
    const prev = old.get(o.id);
    if (!prev)
      return `"${o.name}" is not an overlay of this site. Make overlays with the Overlays panel.`;
    const changed = FIXED.find((k) => !same(prev[k], o[k]));
    if (changed) return `The overlay "${prev.name}" keeps the ${changed} it was made with.`;
  }
  return null;
}

/** Save `survey/overlays.json` (atomic, `.bak`) and delete the folders of removed overlays. */
export async function writeOverlays(
  root: string,
  file: SurveyOverlaysFileT,
): Promise<IpcResponse<'survey:writeOverlays'>> {
  const path = join(root, ...OVERLAYS_FILE.split('/'));
  const newer = await newerOnDisk(path, FAMILY, OVERLAYS_FILE);
  if (newer) return { ok: false, error: newer };
  // read without remembering it: a save over a list the pipeline changed since the person last
  // read it is refused (changed on disk), so an overlay just made is never dropped unseen
  const current = await readOverlays(root, false);
  if (!current.ok) return current;
  const refused = checkOverlaysChange(current.file, file);
  if (refused) return { ok: false, error: refused };
  const kept = new Set(file.overlays.map((o) => o.id));
  const removed = current.file.overlays.filter((o) => !kept.has(o.id));
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeJsonSeen(path, file, { backup: true, name: OVERLAYS_FILE });
  } catch (e) {
    if (isChangedOnDisk(e)) return { ok: false, error: e.message };
    return { ok: false, error: `The overlays were not saved: ${why(e)}` };
  }
  for (const o of removed) {
    // only an overlay's own folder, never anything a damaged entry might point at
    if (o.dir !== folderOf(o.id)) continue;
    const dir = join(root, ...folderOf(o.id).split('/'));
    try {
      await access(dir);
      await rm(dir, { recursive: true, force: true });
    } catch {
      // already gone
    }
  }
  return { ok: true };
}

export function registerSurveyOverlaysIpc({
  handle,
  projects,
  projectPackage,
}: SurveyOverlaysDeps): void {
  handle('survey:readOverlays', async ({ projectId }) => {
    const root = projects.root(projectId);
    if (root !== undefined) {
      const r = await readOverlays(root);
      return r.ok ? { ...r, readOnly: false } : r;
    }
    if (projects.package(projectId)) {
      const archive = projectPackage?.(projectId);
      const r = archive
        ? await readPackageOverlays(archive)
        : { ok: true as const, file: emptyOverlays() };
      return r.ok ? { ...r, readOnly: true } : r;
    }
    return { ok: false, error: `Project "${projectId}" is not open.` };
  });
  handle('survey:writeOverlays', ({ projectId, file }) => {
    if (projects.package(projectId)) return { ok: false, error: READ_ONLY, code: 'read-only' };
    const root = projects.root(projectId);
    if (root === undefined)
      return { ok: false, error: `Project "${projectId}" is not open. Open it, then try again.` };
    return writeOverlays(root, file);
  });
}
