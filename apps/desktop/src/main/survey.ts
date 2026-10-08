/**
 * Surveying in the Builder (M11): the site's survey settings (`survey/settings.json`, G1), its
 * measurements (`survey/measurements.json`, G3), the comparison templates of the project
 * (`survey/templates.json`) and of the user library (userData), its designs (`survey/designs.json`,
 * G6) and the prepared surfaces for the From and To pickers (`survey/surfaces/<id>/tiles.json`,
 * G2). Every write is atomic with a `.bak` and refused for packages; measurements are journaled
 * (`survey:writeMeasurements` is a journaled writer in `journal.ts`: `measurement.create`,
 * `.patch` and `.delete` per measurement). The computing runs as pipeline jobs (`survey.*`,
 * `design.import`) through `jobs:start`. The site settings are G1's (`geodesy.ts`); designs and surfaces are still G0 stubs here.
 */
import {
  MEASUREMENTS_FILE,
  MeasurementsFile,
  SURVEY_TEMPLATES_FILE,
  SURVEY_TEMPLATES_USERDATA,
  SurveyTemplatesFile,
  emptyMeasurements,
  emptySurveyTemplates,
  type IpcResponse,
} from '@aio/schema';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { z } from 'zod';
import { isChangedOnDisk, readJsonSeen, writeJsonSeen } from './fsutil';
import { newerOnDisk, newerThanThisBuild } from './newer';
import { surveySettingsHandlers, type JournalAppend } from './geodesy';
import { notYet, type Handle } from './notYet';

/** A package's archive, read in place (members by project-relative name). */
export interface SurveyArchive {
  entries: ReadonlyMap<string, unknown>;
  read(name: string): Promise<Buffer>;
}

/** The registry slice this module needs: project ids to folders, packages read in place. */
export interface SurveyProjects {
  root(id: string): string | undefined;
  package(id: string): { archive: SurveyArchive } | undefined;
}

/** The same deps as G1's site settings (`geodesy.ts`), plus userData for the template library. */
export interface SurveyIpcDeps {
  handle: Handle;
  /** Without it (G0 tests) the measurement and template channels answer "not available yet". */
  projects?: { root(id: string): string | undefined; package(id: string): unknown };
  /** The archive of an open package, for read-only reads. */
  projectPackage?: (id: string) => SurveyArchive | undefined;
  /** userData, for the person's template library (`survey-templates.json`). */
  userData?: () => string;
  /** The journal service, for G1's site settings (`survey.settings`). */
  journal?: JournalAppend;
}

const NO_MEMBERS: SurveyArchive = {
  entries: new Map(),
  read: () => Promise.reject(new Error('The package has no such member.')),
};

/** Folders and packages as this module reads them. */
function access(
  deps: Omit<SurveyIpcDeps, 'handle' | 'userData' | 'journal'>,
): SurveyProjects | undefined {
  const { projects, projectPackage } = deps;
  if (!projects) return undefined;
  return {
    root: (id) => projects.root(id),
    package: (id) =>
      projects.package(id) ? { archive: projectPackage?.(id) ?? NO_MEMBERS } : undefined,
  };
}

interface Failure {
  ok: false;
  error: string;
  code?: 'read-only' | 'not-implemented';
}

const READ_ONLY_MEASUREMENTS =
  'This project is a read-only package. Its measurements cannot be changed.';
const READ_ONLY_TEMPLATES = 'This project is a read-only package. Its templates cannot be changed.';

function why(e: unknown): string {
  const code = (e as NodeJS.ErrnoException).code;
  if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') return 'the folder is read only';
  return e instanceof Error ? e.message : String(e);
}

function invalid(
  name: string,
  e: { issues: readonly { path: readonly PropertyKey[]; message: string }[] },
): string {
  const first = e.issues[0];
  const where = first?.path.length ? ` at ${first.path.map(String).join('.')}` : '';
  return `${name} is invalid${where}: ${first?.message ?? 'unknown error'}`;
}

/** Parse a JSON value read from disk or an archive as `schema`, refusing a newer build's file. */
function parseAs<S extends z.ZodType>(
  raw: unknown,
  schema: S,
  family: string,
  name: string,
): { ok: true; value: z.infer<S> } | { ok: false; error: string } {
  const newer = newerThanThisBuild(raw, family, name);
  if (newer) return { ok: false, error: newer };
  const parsed = schema.safeParse(raw);
  return parsed.success
    ? { ok: true, value: parsed.data }
    : { ok: false, error: invalid(name, parsed.error) };
}

/** A member of a package as JSON, or undefined when the package has none. */
async function readArchiveJson(archive: SurveyArchive, rel: string): Promise<unknown> {
  if (!archive.entries.has(rel)) return undefined;
  const text = (await archive.read(rel)).toString('utf8');
  return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text) as unknown;
}

// ---------------------------------------------------------------- measurements

export async function readMeasurements(
  projects: SurveyProjects,
  projectId: string,
): Promise<IpcResponse<'survey:readMeasurements'>> {
  const root = projects.root(projectId);
  const pkg = root === undefined ? projects.package(projectId) : undefined;
  if (root === undefined && !pkg)
    return { ok: false, error: `Project "${projectId}" is not open.` };
  let raw: unknown;
  try {
    raw =
      root !== undefined
        ? await readJsonSeen(join(root, ...MEASUREMENTS_FILE.split('/')))
        : pkg && (await readArchiveJson(pkg.archive, MEASUREMENTS_FILE));
  } catch (e) {
    return { ok: false, error: `Could not read the measurements: ${why(e)}` };
  }
  const readOnly = root === undefined;
  if (raw === undefined) return { ok: true, file: emptyMeasurements(), readOnly };
  const r = parseAs(raw, MeasurementsFile, 'aio.measurements', MEASUREMENTS_FILE);
  return r.ok ? { ok: true, file: r.value, readOnly } : r;
}

export async function writeMeasurements(
  projects: SurveyProjects,
  projectId: string,
  input: MeasurementsFile,
): Promise<IpcResponse<'survey:writeMeasurements'>> {
  if (projects.package(projectId))
    return { ok: false, error: READ_ONLY_MEASUREMENTS, code: 'read-only' };
  const root = projects.root(projectId);
  if (root === undefined) return { ok: false, error: `Project "${projectId}" is not open.` };
  const file = MeasurementsFile.parse(input);
  const path = join(root, ...MEASUREMENTS_FILE.split('/'));
  const newer = await newerOnDisk(path, 'aio.measurements', MEASUREMENTS_FILE);
  if (newer) return { ok: false, error: newer };
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeJsonSeen(path, file, { backup: true, name: MEASUREMENTS_FILE });
    return { ok: true };
  } catch (e) {
    if (isChangedOnDisk(e)) return { ok: false, error: e.message };
    return { ok: false, error: `The measurements were not saved: ${why(e)}` };
  }
}

// ---------------------------------------------------------------- templates

type TemplatesFile = z.infer<typeof SurveyTemplatesFile>;

async function readTemplatesAt(path: string, name: string) {
  const raw = await readJsonSeen(path);
  if (raw === undefined) return { ok: true as const, value: null };
  return parseAs(raw, SurveyTemplatesFile, 'aio.survey-templates', name);
}

export async function readTemplates(
  projects: SurveyProjects,
  userData: string,
  projectId: string | undefined,
): Promise<IpcResponse<'survey:readTemplates'>> {
  let project: TemplatesFile | null = null;
  try {
    if (projectId !== undefined) {
      const root = projects.root(projectId);
      const pkg = root === undefined ? projects.package(projectId) : undefined;
      if (root === undefined && !pkg)
        return { ok: false, error: `Project "${projectId}" is not open.` };
      if (root !== undefined) {
        const r = await readTemplatesAt(
          join(root, ...SURVEY_TEMPLATES_FILE.split('/')),
          SURVEY_TEMPLATES_FILE,
        );
        if (!r.ok) return r;
        project = r.value;
      } else if (pkg) {
        const raw = await readArchiveJson(pkg.archive, SURVEY_TEMPLATES_FILE);
        if (raw !== undefined) {
          const r = parseAs(
            raw,
            SurveyTemplatesFile,
            'aio.survey-templates',
            SURVEY_TEMPLATES_FILE,
          );
          if (!r.ok) return r;
          project = r.value;
        }
      }
    }
    const u = await readTemplatesAt(join(userData, SURVEY_TEMPLATES_USERDATA), 'Your templates');
    if (!u.ok) return u;
    return { ok: true, project, user: u.value ?? emptySurveyTemplates() };
  } catch (e) {
    return { ok: false, error: `Could not read the templates: ${why(e)}` };
  }
}

export async function writeTemplates(
  projects: SurveyProjects,
  userData: string,
  req: { scope: 'project' | 'user'; projectId?: string | undefined; file: TemplatesFile },
): Promise<IpcResponse<'survey:writeTemplates'>> {
  let path: string;
  let name: string;
  if (req.scope === 'project') {
    if (req.projectId === undefined)
      return { ok: false, error: 'Project templates need an open project.' };
    if (projects.package(req.projectId))
      return { ok: false, error: READ_ONLY_TEMPLATES, code: 'read-only' };
    const root = projects.root(req.projectId);
    if (root === undefined) return { ok: false, error: `Project "${req.projectId}" is not open.` };
    path = join(root, ...SURVEY_TEMPLATES_FILE.split('/'));
    name = SURVEY_TEMPLATES_FILE;
  } else {
    path = join(userData, SURVEY_TEMPLATES_USERDATA);
    name = SURVEY_TEMPLATES_USERDATA;
  }
  const file = SurveyTemplatesFile.parse(req.file);
  const newer = await newerOnDisk(path, 'aio.survey-templates', name);
  if (newer) return { ok: false, error: newer };
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeJsonSeen(path, file, { backup: true, name });
    return { ok: true };
  } catch (e) {
    if (isChangedOnDisk(e)) return { ok: false, error: e.message };
    return { ok: false, error: `The templates were not saved: ${why(e)}` };
  }
}

// ---------------------------------------------------------------- registration

export function registerSurveyIpc({ handle, userData, journal, ...deps }: SurveyIpcDeps): void {
  const projects = access(deps);
  const what = 'Surveying';
  const unavailable = (): Failure => notYet(what);
  const settings = surveySettingsHandlers(journal ? { ...deps, journal } : deps);
  handle('survey:readSettings', settings.read);
  handle('survey:writeSettings', settings.write);
  handle('survey:readMeasurements', ({ projectId }) =>
    projects ? readMeasurements(projects, projectId) : unavailable(),
  );
  handle('survey:writeMeasurements', ({ projectId, file }) =>
    projects ? writeMeasurements(projects, projectId, file) : unavailable(),
  );
  handle('survey:readTemplates', ({ projectId }) =>
    projects && userData ? readTemplates(projects, userData(), projectId) : unavailable(),
  );
  handle('survey:writeTemplates', (req) =>
    projects && userData ? writeTemplates(projects, userData(), req) : unavailable(),
  );
  handle('survey:readDesigns', () => notYet(what));
  handle('survey:writeDesigns', () => notYet(what));
  handle('survey:surfaces', () => notYet(what));
}
