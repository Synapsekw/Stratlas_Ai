/// <reference types="electron-vite/node" />
/**
 * Coordinates of a site (M11 stream G1, data-conventions section 25, ADR 0010):
 *
 * - `geodesy:searchCrs` searches the EPSG catalogue (`@aio/geo` `catalogue/epsg.json.gz`, built
 *   from PROJ's `proj.db`), loaded once on first use;
 * - `geodesy:readCalibration` reads `survey/calibration.json` (a draft or the applied one);
 * - `geodesy:applyCalibration` applies (or removes) a calibration a person confirmed on its
 *   residual table: the `survey.calibration` and `survey.settings` ops are appended to the journal
 *   first, then the files are written atomically with a `.bak`. Refused for packages.
 *
 * The site settings (`survey/settings.json`, `survey:readSettings` and `survey:writeSettings` in
 * `survey.ts`) are read and written by the helpers here, journaled as `survey.settings`. A
 * calibration is solved from a controller file or point pairs by the `geo.calibration` pipeline.
 */
import type { DraftOp } from '@aio/journal';
import { parseCatalogue, searchCatalogue, type CrsCatalogue } from '@aio/geo';
import {
  CALIBRATION_FILE,
  defaultSurveySettings,
  SiteCalibration,
  SURVEY_SETTINGS_FILE,
  SurveySettings,
  type IpcRequest,
  type IpcResponse,
} from '@aio/schema';
import { mkdir, readFile } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { isChangedOnDisk, readJsonSeen, writeJsonSeen } from './fsutil';
import { newerOnDisk, newerThanThisBuild } from './newer';
import type { Handle } from './notYet';

/** The project registry slice this module needs. */
export interface GeodesyProjects {
  root(id: string): string | undefined;
  package(id: string): unknown;
}

/** A package's archive, read in place (player mode). */
export interface PackageArchive {
  entries: ReadonlyMap<string, unknown>;
  read(name: string): Promise<Buffer>;
}

/** Appends ops to this device's journal chain (main's journal service `append`). */
export type JournalAppend = (root: string, drafts: readonly DraftOp[]) => Promise<unknown>;

export interface GeodesyIpcDeps {
  handle: Handle;
  projects?: GeodesyProjects;
  /** The archive of an open package, for read-only reads. */
  projectPackage?: (id: string) => PackageArchive | undefined;
  journal?: JournalAppend;
  /** The catalogue (tests); default: the bundled `epsg.json.gz`. */
  catalogue?: () => Promise<CrsCatalogue>;
  /** Who applies a calibration (default: the OS account name). */
  user?: () => string;
  now?: () => Date;
}

const NO_PROJECTS = { ok: false as const, error: 'No project registry in this build.' };
const READ_ONLY = {
  ok: false as const,
  error: 'A package is read only: open the project folder to change its site settings.',
  code: 'read-only' as const,
};

function why(e: unknown): string {
  const code = (e as NodeJS.ErrnoException).code;
  if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS')
    return 'the project folder is read only';
  return e instanceof Error ? e.message : String(e);
}

function invalid(what: string, e: { issues: { path: PropertyKey[]; message: string }[] }) {
  const first = e.issues[0];
  const where = first?.path.length ? ` at ${first.path.map(String).join('.')}` : '';
  return `${what} is invalid${where}: ${first?.message ?? 'unknown error'}`;
}

// ---------------------------------------------------------------- the catalogue

let bundled: Promise<CrsCatalogue> | null = null;

/** The bundled catalogue, read and decompressed once. */
export function bundledCatalogue(): Promise<CrsCatalogue> {
  bundled ??= (async () => {
    const asset = await import('@aio/geo/catalogue/epsg.json.gz?asset');
    return loadCatalogueFile(asset.default);
  })();
  bundled.catch(() => {
    bundled = null;
  });
  return bundled;
}

/** Read a gzip catalogue file. */
export async function loadCatalogueFile(path: string): Promise<CrsCatalogue> {
  return parseCatalogue(gunzipSync(await readFile(path)).toString('utf8'));
}

// ---------------------------------------------------------------- survey settings (helpers)

/** Dotted paths and values of a JSON object's leaves (arrays are leaves). */
function leaves(v: unknown, prefix = '', out = new Map<string, unknown>()): Map<string, unknown> {
  if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
    for (const [k, x] of Object.entries(v)) leaves(x, prefix ? `${prefix}.${k}` : k, out);
  } else if (prefix) out.set(prefix, v);
  return out;
}

/** A `PatchPayload` from one settings object to another (null: nothing changed). */
export function settingsPatch(before: unknown, after: unknown): Record<string, unknown> | null {
  const b = leaves(before);
  const a = leaves(after);
  const set: Record<string, unknown> = {};
  const was: Record<string, unknown> = {};
  const unset: string[] = [];
  for (const [k, v] of a) {
    const old = b.get(k);
    if (JSON.stringify(old) === JSON.stringify(v)) continue;
    set[k] = v;
    if (b.has(k)) was[k] = old;
  }
  for (const [k, old] of b) {
    if (a.has(k)) continue;
    unset.push(k);
    was[k] = old;
  }
  if (Object.keys(set).length === 0 && unset.length === 0) return null;
  return {
    ...(Object.keys(set).length ? { set } : {}),
    ...(unset.length ? { unset } : {}),
    ...(Object.keys(was).length ? { was } : {}),
  };
}

type ReadSettings = IpcResponse<'survey:readSettings'>;

function parseSettings(raw: unknown): ReadSettings {
  const newer = newerThanThisBuild(raw, 'aio.survey-settings', SURVEY_SETTINGS_FILE);
  if (newer) return { ok: false, error: newer };
  const parsed = SurveySettings.safeParse(raw);
  return parsed.success
    ? { ok: true, settings: parsed.data, exists: true }
    : { ok: false, error: invalid(SURVEY_SETTINGS_FILE, parsed.error) };
}

/** `survey/settings.json` of a project folder; the defaults with `exists: false` when absent. */
export async function readSurveySettings(root: string): Promise<ReadSettings> {
  let raw: unknown;
  try {
    raw = await readJsonSeen(join(root, ...SURVEY_SETTINGS_FILE.split('/')));
  } catch (e) {
    return { ok: false, error: `Could not read the site settings: ${why(e)}` };
  }
  if (raw === undefined) return { ok: true, settings: defaultSurveySettings(), exists: false };
  return parseSettings(raw);
}

async function readPackageJson(archive: PackageArchive, name: string): Promise<unknown> {
  if (!archive.entries.has(name)) return undefined;
  return JSON.parse((await archive.read(name)).toString('utf8')) as unknown;
}

/**
 * Write `survey/settings.json`: the `survey.settings` op (a patch from the file on disk) is
 * appended first, then the file is written atomically with a `.bak`.
 */
export async function writeSurveySettings(
  root: string,
  settings: SurveySettings,
  journal?: JournalAppend,
): Promise<IpcResponse<'survey:writeSettings'>> {
  const parsed = SurveySettings.safeParse(settings);
  if (!parsed.success) return { ok: false, error: invalid('The site settings', parsed.error) };
  const path = join(root, ...SURVEY_SETTINGS_FILE.split('/'));
  const newer = await newerOnDisk(path, 'aio.survey-settings', SURVEY_SETTINGS_FILE);
  if (newer) return { ok: false, error: newer };
  const before = await readSurveySettings(root);
  const patch = settingsPatch(before.ok && before.exists ? before.settings : null, parsed.data);
  try {
    if (patch && journal) {
      await journal(root, [
        { kind: 'survey.settings', target: { rec: 'survey', id: 'settings' }, payload: patch },
      ]);
    }
    await mkdir(dirname(path), { recursive: true });
    await writeJsonSeen(path, parsed.data, { backup: true, name: SURVEY_SETTINGS_FILE });
    return { ok: true };
  } catch (e) {
    if (isChangedOnDisk(e)) return { ok: false, error: e.message };
    return { ok: false, error: `The site settings were not saved: ${why(e)}` };
  }
}

// ---------------------------------------------------------------- calibration

type ReadCalibration = IpcResponse<'geodesy:readCalibration'>;

function parseCalibration(raw: unknown): ReadCalibration {
  if (raw === undefined) return { ok: true, calibration: null };
  const newer = newerThanThisBuild(raw, 'aio.site-calibration', CALIBRATION_FILE);
  if (newer) return { ok: false, error: newer };
  const parsed = SiteCalibration.safeParse(raw);
  return parsed.success
    ? { ok: true, calibration: parsed.data }
    : { ok: false, error: invalid(CALIBRATION_FILE, parsed.error) };
}

export async function readCalibration(root: string): Promise<ReadCalibration> {
  try {
    return parseCalibration(await readJsonSeen(join(root, ...CALIBRATION_FILE.split('/'))));
  } catch (e) {
    return { ok: false, error: `Could not read the site calibration: ${why(e)}` };
  }
}

/**
 * Apply (or remove) a calibration a person confirmed: `appliedAt` and `appliedBy` set (or cleared),
 * the site settings' `calibration` set (or removed). Journaled first, then written.
 */
export async function applyCalibration(
  root: string,
  req: IpcRequest<'geodesy:applyCalibration'>,
  opts: { journal?: JournalAppend; user: string; now: Date },
): Promise<IpcResponse<'geodesy:applyCalibration'>> {
  const cal = SiteCalibration.safeParse(req.calibration);
  if (!cal.success) return { ok: false, error: invalid('The calibration', cal.error) };
  const c = cal.data;
  if (req.apply && !c.horizontal && !c.vertical) {
    return {
      ok: false,
      error: 'This calibration has no horizontal or vertical adjustment to apply.',
    };
  }
  const calPath = join(root, ...CALIBRATION_FILE.split('/'));
  const setPath = join(root, ...SURVEY_SETTINGS_FILE.split('/'));
  for (const [p, fam, name] of [
    [calPath, 'aio.site-calibration', CALIBRATION_FILE],
    [setPath, 'aio.survey-settings', SURVEY_SETTINGS_FILE],
  ] as const) {
    const newer = await newerOnDisk(p, fam, name);
    if (newer) return { ok: false, error: newer };
  }
  const draft: SiteCalibration = { ...c };
  delete draft.appliedAt;
  delete draft.appliedBy;
  const next: SiteCalibration = req.apply
    ? { ...draft, appliedAt: opts.now.toISOString(), appliedBy: opts.user.slice(0, 200) }
    : draft;
  const settings = await readSurveySettings(root);
  if (!settings.ok) return settings;
  const rest: SurveySettings = { ...settings.settings };
  delete rest.calibration;
  const nextSettings: SurveySettings = req.apply ? { ...rest, calibration: c.id } : rest;
  // removing a calibration the heights were shown through falls back to the project's heights
  if (!req.apply && nextSettings.verticalDatum.kind === 'calibration') {
    nextSettings.verticalDatum = { kind: 'project' };
  }
  const prev = await readCalibration(root);
  const drafts: DraftOp[] = [
    {
      kind: 'survey.calibration',
      target: { rec: 'survey', id: 'calibration' },
      payload: {
        record: next,
        ...(prev.ok && prev.calibration ? { was: prev.calibration } : {}),
      },
    },
  ];
  const patch = settingsPatch(settings.exists ? settings.settings : null, nextSettings);
  if (patch)
    drafts.push({
      kind: 'survey.settings',
      target: { rec: 'survey', id: 'settings' },
      payload: patch,
    });
  try {
    await opts.journal?.(root, drafts);
    await mkdir(dirname(calPath), { recursive: true });
    await writeJsonSeen(calPath, next, { backup: true, name: CALIBRATION_FILE });
    await writeJsonSeen(setPath, nextSettings, { backup: true, name: SURVEY_SETTINGS_FILE });
    return { ok: true };
  } catch (e) {
    if (isChangedOnDisk(e)) return { ok: false, error: e.message };
    return { ok: false, error: `The calibration was not applied: ${why(e)}` };
  }
}

function osUser(): string {
  try {
    return userInfo().username.trim() || 'this computer';
  } catch {
    return 'this computer';
  }
}

export function registerGeodesyIpc(deps: GeodesyIpcDeps): void {
  const { handle, projects, projectPackage, journal } = deps;
  const catalogue = deps.catalogue ?? bundledCatalogue;

  handle('geodesy:searchCrs', async (req) => {
    try {
      const { entries } = await catalogue();
      return {
        ok: true,
        results: searchCatalogue(entries, {
          query: req.query,
          ...(req.near ? { near: req.near } : {}),
          ...(req.kinds ? { kinds: req.kinds } : {}),
          ...(req.limit ? { limit: req.limit } : {}),
        }),
      };
    } catch (e) {
      return { ok: false, error: `The coordinate system list could not be read: ${why(e)}` };
    }
  });

  handle('geodesy:readCalibration', async ({ projectId }) => {
    if (!projects) return NO_PROJECTS;
    const archive = projects.package(projectId) ? projectPackage?.(projectId) : undefined;
    if (archive) {
      try {
        return parseCalibration(await readPackageJson(archive, CALIBRATION_FILE));
      } catch (e) {
        return { ok: false, error: `Could not read the site calibration: ${why(e)}` };
      }
    }
    const root = projects.root(projectId);
    if (root === undefined) return { ok: false, error: 'The project is not open.' };
    return readCalibration(root);
  });

  handle('geodesy:applyCalibration', async (req) => {
    if (!projects) return NO_PROJECTS;
    if (projects.package(req.projectId)) return READ_ONLY;
    const root = projects.root(req.projectId);
    if (root === undefined) return { ok: false, error: 'The project is not open.' };
    return applyCalibration(root, req, {
      ...(journal ? { journal } : {}),
      user: deps.user?.() ?? osUser(),
      now: deps.now?.() ?? new Date(),
    });
  });
}

/** `survey:readSettings` and `survey:writeSettings` (registered by `survey.ts`). */
export function surveySettingsHandlers(deps: {
  projects?: GeodesyProjects;
  projectPackage?: (id: string) => PackageArchive | undefined;
  journal?: JournalAppend;
}) {
  const { projects, projectPackage, journal } = deps;
  return {
    read: async ({ projectId }: IpcRequest<'survey:readSettings'>): Promise<ReadSettings> => {
      if (!projects) return NO_PROJECTS;
      const archive = projects.package(projectId) ? projectPackage?.(projectId) : undefined;
      if (archive) {
        try {
          const raw = await readPackageJson(archive, SURVEY_SETTINGS_FILE);
          return raw === undefined
            ? { ok: true, settings: defaultSurveySettings(), exists: false }
            : parseSettings(raw);
        } catch (e) {
          return { ok: false, error: `Could not read the site settings: ${why(e)}` };
        }
      }
      const root = projects.root(projectId);
      if (root === undefined) return { ok: false, error: 'The project is not open.' };
      return readSurveySettings(root);
    },
    write: async (
      req: IpcRequest<'survey:writeSettings'>,
    ): Promise<IpcResponse<'survey:writeSettings'>> => {
      if (!projects) return NO_PROJECTS;
      if (projects.package(req.projectId)) return READ_ONLY;
      const root = projects.root(req.projectId);
      if (root === undefined) return { ok: false, error: 'The project is not open.' };
      return writeSurveySettings(root, req.settings, journal);
    },
  };
}
