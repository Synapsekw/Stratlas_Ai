/**
 * Survey QA and terrain edits in main (M11 stream G8, data-conventions section 29):
 *
 * - `survey:readQa` reads the QA results `survey/qa/<capture>.json` (`aio.survey-qa/1`, written by
 *   the `survey.qa` pipeline), from the folder or, for a package, in place;
 * - `survey:releaseHold` releases a survey on hold with a person's note: the `survey.hold` op
 *   (action `release`) is appended to the journal first, then the file is written atomically with
 *   a `.bak` (status `released`, `release` set; the hold and the checks stay). Refused for packages;
 * - `survey:readTerrainEdits` and `survey:writeTerrainEdits` read and write the cleanups and crops
 *   list `survey/cleanups.json` (`aio.terrain-edits/1`), atomic with a `.bak`; the write is one of
 *   the journal service's wrapped writers (`journal.ts`), so its ops come first;
 * - `recordQaHold` journals the hold a finished `survey.qa` job wrote (`survey.hold`, action
 *   `hold`, the reason as the note), called by main for each job update (`qaJobEvents`).
 *
 * Only a person releases a hold; nothing here deletes a QA result or an edit.
 */
import type { DraftOp } from '@aio/journal';
import {
  QA_DIR,
  SurveyQa,
  TERRAIN_EDITS_FILE,
  TerrainEditsFile,
  type IpcRequest,
  type IpcResponse,
  type JobEvent,
} from '@aio/schema';
import { mkdir, readdir } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import type { z } from 'zod';
import { isChangedOnDisk, readJsonSeen, writeJsonSeen } from './fsutil';
import type { JournalAppend, PackageArchive } from './geodesy';
import { newerOnDisk, newerThanThisBuild } from './newer';
import type { Handle } from './notYet';

export interface SurveyQaIpcDeps {
  handle: Handle;
  projects?: { root(id: string): string | undefined; package(id: string): unknown };
  /** The archive of an open package, for read-only reads. */
  projectPackage?: (id: string) => PackageArchive | undefined;
  journal?: JournalAppend;
  /** Who releases a hold (default: the OS account name). */
  user?: () => string;
  now?: () => Date;
}

const NO_PROJECTS = { ok: false as const, error: 'No project registry in this build.' };
const NOT_OPEN = { ok: false as const, error: 'The project is not open.' };
const READ_ONLY = (what: string) => ({
  ok: false as const,
  error: `This project is a read-only package. ${what}`,
  code: 'read-only' as const,
});
const CAPTURE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const CAPTURE_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.json$/;
const BAD_CAPTURE = {
  ok: false as const,
  error: 'A survey id is letters, digits, dot, dash or underscore.',
};
/** A capture id that names a file in `survey/qa/` and nothing outside it. */
const safeCapture = (c: string) => CAPTURE.test(c) && !c.includes('..');

function why(e: unknown): string {
  const code = (e as NodeJS.ErrnoException).code;
  if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') return 'the folder is read only';
  return e instanceof Error ? e.message : String(e);
}

function parseAs<S extends z.ZodType>(
  raw: unknown,
  schema: S,
  family: string,
  name: string,
): { ok: true; value: z.infer<S> } | { ok: false; error: string } {
  const newer = newerThanThisBuild(raw, family, name);
  if (newer) return { ok: false, error: newer };
  const parsed = schema.safeParse(raw);
  if (parsed.success) return { ok: true, value: parsed.data };
  const first = parsed.error.issues[0];
  const where = first?.path.length ? ` at ${first.path.map(String).join('.')}` : '';
  return { ok: false, error: `${name} is invalid${where}: ${first?.message ?? 'unknown error'}` };
}

async function archiveJson(archive: PackageArchive, rel: string): Promise<unknown> {
  if (!archive.entries.has(rel)) return undefined;
  const text = (await archive.read(rel)).toString('utf8');
  return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text) as unknown;
}

const qaRel = (capture: string) => `${QA_DIR}/${capture}.json`;
const pathOf = (root: string, rel: string) => join(root, ...rel.split('/'));

// ---------------------------------------------------------------- QA results

/** The QA results of a project folder (one capture's, or every one), by capture. */
export async function readQaFolder(
  root: string,
  capture?: string,
): Promise<{ ok: true; files: SurveyQa[] } | { ok: false; error: string }> {
  if (capture !== undefined && !safeCapture(capture)) return BAD_CAPTURE;
  let names: string[];
  if (capture !== undefined) names = [`${capture}.json`];
  else {
    try {
      names = (await readdir(pathOf(root, QA_DIR))).filter((n) => CAPTURE_FILE.test(n)).sort();
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { ok: true, files: [] };
      return { ok: false, error: `Could not read the QA results: ${why(e)}` };
    }
  }
  const files: SurveyQa[] = [];
  for (const name of names) {
    const rel = `${QA_DIR}/${name}`;
    let raw: unknown;
    try {
      raw = await readJsonSeen(pathOf(root, rel));
    } catch (e) {
      return { ok: false, error: `Could not read ${rel}: ${why(e)}` };
    }
    if (raw === undefined) continue;
    const r = parseAs(raw, SurveyQa, 'aio.survey-qa', rel);
    if (!r.ok) return r;
    files.push(r.value);
  }
  return { ok: true, files };
}

async function readQaArchive(
  archive: PackageArchive,
  capture?: string,
): Promise<IpcResponse<'survey:readQa'>> {
  if (capture !== undefined && !safeCapture(capture)) return BAD_CAPTURE;
  const names =
    capture !== undefined
      ? [qaRel(capture)]
      : [...archive.entries.keys()]
          .filter(
            (n) => n.startsWith(`${QA_DIR}/`) && CAPTURE_FILE.test(n.slice(QA_DIR.length + 1)),
          )
          .sort();
  const files: SurveyQa[] = [];
  for (const rel of names) {
    const raw = await archiveJson(archive, rel);
    if (raw === undefined) continue;
    const r = parseAs(raw, SurveyQa, 'aio.survey-qa', rel);
    if (!r.ok) return r;
    files.push(r.value);
  }
  return { ok: true, files, readOnly: true };
}

/**
 * Release a survey on hold: `survey.hold` (action `release`, the note) journaled first, then the
 * file written with status `released` and `release` `{ at, by, note }`.
 */
export async function releaseHold(
  root: string,
  req: Omit<IpcRequest<'survey:releaseHold'>, 'projectId'>,
  opts: { journal?: JournalAppend; user: string; now: Date },
): Promise<IpcResponse<'survey:releaseHold'>> {
  if (!safeCapture(req.capture)) return BAD_CAPTURE;
  const note = req.note.trim();
  if (!note) return { ok: false, error: 'Write a note on why the survey is released.' };
  const rel = qaRel(req.capture);
  const path = pathOf(root, rel);
  const newer = await newerOnDisk(path, 'aio.survey-qa', rel);
  if (newer) return { ok: false, error: newer };
  const read = await readQaFolder(root, req.capture);
  if (!read.ok) return read;
  const qa = read.files[0];
  if (!qa) return { ok: false, error: 'This survey has no QA result to release.' };
  if (qa.status !== 'hold' && qa.status !== 'fail')
    return { ok: false, error: `This survey is not on hold (its QA status is ${qa.status}).` };
  const by = opts.user.trim().slice(0, 200);
  const next: SurveyQa = {
    ...qa,
    status: 'released',
    release: { at: opts.now.toISOString(), ...(by ? { by } : {}), note },
  };
  const parsed = SurveyQa.safeParse(next);
  if (!parsed.success) return { ok: false, error: 'The released QA result is invalid.' };
  const drafts: DraftOp[] = [
    {
      kind: 'survey.hold',
      target: { rec: 'survey', id: `qa/${req.capture}` },
      payload: { capture: req.capture, action: 'release', note },
    },
  ];
  try {
    await opts.journal?.(root, drafts);
    await writeJsonSeen(path, parsed.data, { backup: true, name: rel });
    return { ok: true, qa: parsed.data };
  } catch (e) {
    if (isChangedOnDisk(e)) return { ok: false, error: e.message };
    return { ok: false, error: `The survey was not released: ${why(e)}` };
  }
}

/** Journal the hold a `survey.qa` job wrote for `capture` (nothing when the survey is not held). */
export async function recordQaHold(
  root: string,
  capture: string,
  journal: JournalAppend,
): Promise<boolean> {
  if (!safeCapture(capture)) return false;
  const read = await readQaFolder(root, capture);
  const qa = read.ok ? read.files[0] : undefined;
  if (qa?.status !== 'hold' || !qa.hold) return false;
  await journal(root, [
    {
      kind: 'survey.hold',
      target: { rec: 'survey', id: `qa/${capture}` },
      payload: { capture, action: 'hold', note: qa.hold.reason.slice(0, 2000) },
    },
  ]);
  return true;
}

/** A job event listener: journals the hold of each `survey.qa` job that finishes. */
export function qaJobEvents(deps: {
  journal: JournalAppend;
  packaged?: (root: string) => boolean;
}) {
  // a job's finished update can arrive more than once: its hold is journaled once
  const seen = new Set<string>();
  return async (e: JobEvent): Promise<void> => {
    if (e.type !== 'update' || e.job.pipeline !== 'survey.qa' || e.job.status !== 'done') return;
    const capture = e.job.params.capture;
    if (typeof capture !== 'string' || deps.packaged?.(e.job.project)) return;
    const key = `${e.job.id}@${e.job.finishedAt ?? e.job.updatedAt}`;
    if (seen.has(key)) return;
    seen.add(key);
    try {
      await recordQaHold(e.job.project, capture, deps.journal);
    } catch (err) {
      console.warn(`Survey QA: the hold of ${capture} was not journaled (${String(err)}).`);
    }
  };
}

// ---------------------------------------------------------------- terrain edits

const emptyEdits = (): TerrainEditsFile => ({ schema: 'aio.terrain-edits/1', edits: [] });

export async function readTerrainEdits(
  root: string,
): Promise<IpcResponse<'survey:readTerrainEdits'>> {
  let raw: unknown;
  try {
    raw = await readJsonSeen(pathOf(root, TERRAIN_EDITS_FILE));
  } catch (e) {
    return { ok: false, error: `Could not read the terrain edits: ${why(e)}` };
  }
  if (raw === undefined) return { ok: true, file: emptyEdits(), readOnly: false };
  const r = parseAs(raw, TerrainEditsFile, 'aio.terrain-edits', TERRAIN_EDITS_FILE);
  return r.ok ? { ok: true, file: r.value, readOnly: false } : r;
}

export async function writeTerrainEdits(
  root: string,
  input: TerrainEditsFile,
): Promise<IpcResponse<'survey:writeTerrainEdits'>> {
  const parsed = TerrainEditsFile.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'The terrain edits are invalid.' };
  const ids = new Set<string>();
  for (const e of parsed.data.edits) {
    if (ids.has(e.id)) return { ok: false, error: `The terrain edit "${e.id}" is listed twice.` };
    ids.add(e.id);
  }
  const path = pathOf(root, TERRAIN_EDITS_FILE);
  const newer = await newerOnDisk(path, 'aio.terrain-edits', TERRAIN_EDITS_FILE);
  if (newer) return { ok: false, error: newer };
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeJsonSeen(path, parsed.data, { backup: true, name: TERRAIN_EDITS_FILE });
    return { ok: true };
  } catch (e) {
    if (isChangedOnDisk(e)) return { ok: false, error: e.message };
    return { ok: false, error: `The terrain edits were not saved: ${why(e)}` };
  }
}

// ---------------------------------------------------------------- IPC

function osUser(): string {
  try {
    return userInfo().username.trim() || 'this computer';
  } catch {
    return 'this computer';
  }
}

export function registerSurveyQaIpc(deps: SurveyQaIpcDeps): void {
  const { handle, projects, projectPackage, journal } = deps;

  handle('survey:readQa', async ({ projectId, capture }) => {
    if (!projects) return NO_PROJECTS;
    if (projects.package(projectId)) {
      const archive = projectPackage?.(projectId);
      if (!archive) return { ok: true, files: [], readOnly: true };
      try {
        return await readQaArchive(archive, capture);
      } catch (e) {
        return { ok: false, error: `Could not read the QA results: ${why(e)}` };
      }
    }
    const root = projects.root(projectId);
    if (root === undefined) return NOT_OPEN;
    const r = await readQaFolder(root, capture);
    return r.ok ? { ok: true, files: r.files, readOnly: false } : r;
  });

  handle('survey:releaseHold', async ({ projectId, capture, note }) => {
    if (!projects) return NO_PROJECTS;
    if (projects.package(projectId)) return READ_ONLY('Its QA holds cannot be released.');
    const root = projects.root(projectId);
    if (root === undefined) return NOT_OPEN;
    return releaseHold(
      root,
      { capture, note },
      {
        ...(journal ? { journal } : {}),
        user: deps.user?.() ?? osUser(),
        now: deps.now?.() ?? new Date(),
      },
    );
  });

  handle('survey:readTerrainEdits', async ({ projectId }) => {
    if (!projects) return NO_PROJECTS;
    if (projects.package(projectId)) {
      const archive = projectPackage?.(projectId);
      try {
        const raw = archive ? await archiveJson(archive, TERRAIN_EDITS_FILE) : undefined;
        if (raw === undefined) return { ok: true, file: emptyEdits(), readOnly: true };
        const r = parseAs(raw, TerrainEditsFile, 'aio.terrain-edits', TERRAIN_EDITS_FILE);
        return r.ok ? { ok: true, file: r.value, readOnly: true } : r;
      } catch (e) {
        return { ok: false, error: `Could not read the terrain edits: ${why(e)}` };
      }
    }
    const root = projects.root(projectId);
    if (root === undefined) return NOT_OPEN;
    return readTerrainEdits(root);
  });

  handle('survey:writeTerrainEdits', async ({ projectId, file }) => {
    if (!projects) return NO_PROJECTS;
    if (projects.package(projectId)) return READ_ONLY('Its terrain edits cannot be changed.');
    const root = projects.root(projectId);
    if (root === undefined) return NOT_OPEN;
    return writeTerrainEdits(root, file);
  });
}
