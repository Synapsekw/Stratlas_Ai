/*
 * RF coverage in the main process (spec docs/superpowers/specs/2026-10-17-rf-coverage-design.md):
 * `rf/sectors.json` read and write (D8, D9), the catalogue (D10: built in, the person's own in
 * userData, the copy in the project), MSI import, coverage runs and their exports (D19).
 *
 * A project is read through a small source so a folder and a `.aio` package share one code path;
 * only a folder is ever written. Nothing here edits `telecom/antennas.json`: it is read, loosely
 * and optionally, to flag settings whose antenna is gone.
 */
import {
  parseRfCatalogue,
  parseRfRun,
  parseRfSectors,
  carrierProblems,
  etiltProblems,
  RF_CATALOGUE_PATH,
  RF_CATALOGUE_SCHEMA,
  RF_RUNS_DIR,
  RF_SECTORS_PATH,
  RfSectorsFile,
  type IpcRequest,
  type IpcResponse,
  type RfCatalogueEntry,
  type RfRun,
} from '@aio/schema';
import { copyFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { parseMsi, type MsiPattern } from '@aio/rf';
import { z } from 'zod';
import { isChangedOnDisk, readJson, readJsonSeen, writeJsonAtomic, writeJsonSeen } from './fsutil';
import {
  classAreasCsv,
  coverageGeoJson,
  readGridTiff,
  writeGridTiff,
  type GridGeo,
} from './rf/export';

interface Archive {
  entries: ReadonlyMap<string, unknown>;
  read(name: string): Promise<Buffer>;
}

export interface RfDeps {
  /** The person's own catalogue: userData `rf-catalogue/`. */
  userDir: string;
  /** The catalogue shipped with the app (`packages/rf/catalogue`); null when it is not found. */
  builtinDir: string | null;
  projects: {
    root(projectId: string): string | undefined;
    package(projectId: string): { archive: Archive } | undefined;
  };
  /** The save dialog: the chosen path, or null when the person cancels. */
  choose(defaultName: string, format: 'geotiff' | 'geojson' | 'csv'): Promise<string | null>;
  /** A package's export allow-list: the message to show, or null when the file may be saved. */
  refuse?: (projectId: string, fileName: string) => string | null;
}

interface Fail {
  ok: false;
  error: string;
  code?: 'read-only';
}
const fail = (error: string, code?: 'read-only'): Fail =>
  code ? { ok: false, error, code } : { ok: false, error };
const stripBom = (t: string): string => (t.charCodeAt(0) === 0xfeff ? t.slice(1) : t);
const why = (e: unknown): string => (e instanceof Error ? e.message : String(e));

// ---- project sources -----------------------------------------------------------------------------

interface Source {
  readOnly: boolean;
  /** Raw JSON of a project file; undefined when it does not exist. Throws on bad JSON. */
  json(rel: string): Promise<unknown>;
  bytes(rel: string): Promise<Buffer | null>;
  /** Names of the folders directly under `rel`. */
  folders(rel: string): Promise<string[]>;
}

function folderSource(root: string): Source {
  return {
    readOnly: false,
    json: (rel) => readJson(join(root, rel)),
    bytes: async (rel) => {
      try {
        return await readFile(join(root, rel));
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw e;
      }
    },
    folders: async (rel) => {
      try {
        const list = await readdir(join(root, rel), { withFileTypes: true });
        return list.filter((d) => d.isDirectory()).map((d) => d.name);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw e;
      }
    },
  };
}

function packageSource(archive: Archive): Source {
  const bytes = async (rel: string): Promise<Buffer | null> =>
    archive.entries.has(rel) ? archive.read(rel) : null;
  return {
    readOnly: true,
    json: async (rel) => {
      const b = await bytes(rel);
      return b === null ? undefined : (JSON.parse(b.toString('utf8')) as unknown);
    },
    bytes,
    folders: (rel) => {
      const prefix = rel.endsWith('/') ? rel : `${rel}/`;
      const out = new Set<string>();
      for (const name of archive.entries.keys()) {
        if (!name.startsWith(prefix)) continue;
        const rest = name.slice(prefix.length);
        const i = rest.indexOf('/');
        if (i > 0) out.add(rest.slice(0, i));
      }
      return Promise.resolve([...out]);
    },
  };
}

// ---- orphans (D9) --------------------------------------------------------------------------------

const AntennasLoose = z
  .object({
    units: z.array(
      z
        .object({
          id: z.string(),
          status: z.string().optional(),
          notFoundInLatest: z.boolean().optional(),
        })
        .loose(),
    ),
  })
  .loose();

/**
 * Antenna ids that the RF file keeps settings or sector membership for but the inventory no longer
 * has as a usable unit. `telecom/antennas.json` may not exist yet; then nothing is flagged.
 */
async function findOrphans(src: Source, file: RfSectorsFile): Promise<string[]> {
  let raw: unknown;
  try {
    raw = await src.json('telecom/antennas.json');
  } catch {
    return [];
  }
  const parsed = AntennasLoose.safeParse(raw);
  if (!parsed.success) return [];
  const usable = new Set(
    parsed.data.units
      .filter((u) => u.status !== 'rejected' && u.notFoundInLatest !== true)
      .map((u) => u.id),
  );
  const ids = new Set([
    ...file.antennas.map((a) => a.antennaId),
    ...file.sectors.flatMap((s) => s.antennaIds),
  ]);
  return [...ids].filter((id) => !usable.has(id));
}

// ---- catalogue -----------------------------------------------------------------------------------

interface CatalogueRead {
  entries: RfCatalogueEntry[];
  warnings: string[];
}

async function readCatalogueFile(file: string): Promise<CatalogueRead> {
  let raw: unknown;
  try {
    raw = await readJson(file);
  } catch (e) {
    return { entries: [], warnings: [`${basename(file)} could not be read: ${why(e)}`] };
  }
  if (raw === undefined) return { entries: [], warnings: [] };
  const r = parseRfCatalogue(raw);
  return r.ok
    ? { entries: r.value.entries, warnings: [] }
    : { entries: [], warnings: [`${basename(file)}: ${r.error}`] };
}

async function readCatalogueDir(dir: string | null): Promise<CatalogueRead> {
  if (dir === null) return { entries: [], warnings: [] };
  let names: string[];
  try {
    names = (await readdir(dir)).filter((n) => n.toLowerCase().endsWith('.json')).sort();
  } catch {
    return { entries: [], warnings: [] };
  }
  const out: CatalogueRead = { entries: [], warnings: [] };
  for (const n of names) {
    const r = await readCatalogueFile(join(dir, n));
    out.entries.push(...r.entries);
    out.warnings.push(...r.warnings);
  }
  return out;
}

async function readProjectCatalogue(src: Source): Promise<CatalogueRead> {
  let raw: unknown;
  try {
    raw = await src.json(RF_CATALOGUE_PATH);
  } catch (e) {
    return { entries: [], warnings: [`${RF_CATALOGUE_PATH} could not be read: ${why(e)}`] };
  }
  if (raw === undefined) return { entries: [], warnings: [] };
  const r = parseRfCatalogue(raw);
  return r.ok
    ? { entries: r.value.entries, warnings: [] }
    : { entries: [], warnings: [`${RF_CATALOGUE_PATH}: ${r.error}`] };
}

const catalogueDoc = (entries: RfCatalogueEntry[]) => ({ schema: RF_CATALOGUE_SCHEMA, entries });
const USER_FILE = 'user.json';

/** Files an entry names (measured patterns), relative to the catalogue folder. */
function patternFiles(e: RfCatalogueEntry): string[] {
  if (e.kind === 'antenna') return e.ports.flatMap((p) => p.patterns.map((r) => r.file));
  if (e.kind === 'aau') return (e.patterns ?? []).map((r) => r.file);
  return [];
}

/** The entry without the pattern references whose file is in `missing`. */
function withoutPatterns(e: RfCatalogueEntry, missing: ReadonlySet<string>): RfCatalogueEntry {
  if (missing.size === 0) return e;
  const keep = <T extends { file: string }>(list: T[]): T[] =>
    list.filter((p) => !missing.has(p.file));
  if (e.kind === 'antenna')
    return { ...e, ports: e.ports.map((p) => ({ ...p, patterns: keep(p.patterns) })) };
  if (e.kind === 'aau' && e.patterns) return { ...e, patterns: keep(e.patterns) };
  return e;
}

async function copyPatterns(from: string, to: string, files: string[]): Promise<string[]> {
  const missing: string[] = [];
  for (const f of files) {
    try {
      await mkdir(dirname(join(to, f)), { recursive: true });
      await copyFile(join(from, f), join(to, f));
    } catch {
      missing.push(f);
    }
  }
  return missing;
}

const MAX_MSI_BYTES = 5 * 1024 * 1024;
const MAX_CATALOGUE_BYTES = 10 * 1024 * 1024;
const safeName = (s: string): string => s.replace(/[^A-Za-z0-9._-]/g, '_');

// ---- runs and grids ------------------------------------------------------------------------------

type RunRead = { ok: true; run: RfRun } | Fail;

async function readRunFrom(src: Source, runId: string): Promise<RunRead> {
  const rel = `${RF_RUNS_DIR}/${runId}/run.json`;
  let raw: unknown;
  try {
    raw = await src.json(rel);
  } catch (e) {
    return fail(`${rel} could not be read: ${why(e)}`);
  }
  if (raw === undefined) return fail(`There is no coverage run ${runId} in this project.`);
  const r = parseRfRun(raw);
  if (!r.ok) return fail(r.error);
  if (r.value.runId !== runId)
    return fail(`${rel} is for run ${r.value.runId}, not ${runId}, so it is not used.`);
  return { ok: true, run: r.value };
}

/** A grid file of a run as Float32, checked against the run's grid. */
async function loadGrid(src: Source, run: RfRun, file: string): Promise<Float32Array> {
  const rel = `${RF_RUNS_DIR}/${run.runId}/${file}`;
  const bytes = await src.bytes(rel);
  if (bytes === null) throw new Error(`The run has no ${file}.`);
  const { width, height } = run.grid;
  if (/\.tiff?$/i.test(file)) {
    const t = readGridTiff(bytes);
    if (t.width !== width || t.height !== height)
      throw new Error(
        `${file} is ${String(t.width)} x ${String(t.height)} but the run's grid is ${String(width)} x ${String(height)}.`,
      );
    return t.data;
  }
  if (bytes.length !== width * height * 4)
    throw new Error(`${file} does not hold ${String(width * height)} Float32 values.`);
  const out = new Float32Array(width * height);
  for (let i = 0; i < out.length; i++) out[i] = bytes.readFloatLE(i * 4);
  return out;
}

const gridGeo = (run: RfRun): GridGeo => ({
  crs: run.grid.crs,
  resolutionM: run.grid.resolutionM,
  origin: run.grid.origin,
  width: run.grid.width,
  height: run.grid.height,
  nodata: run.grid.nodata,
});

// ---- the handlers --------------------------------------------------------------------------------

export function createRf(deps: RfDeps) {
  const sourceOf = (projectId: string): Source | undefined => {
    const root = deps.projects.root(projectId);
    if (root !== undefined) return folderSource(root);
    const pkg = deps.projects.package(projectId);
    return pkg ? packageSource(pkg.archive) : undefined;
  };
  const notOpen = (id: string): Fail => fail(`Project "${id}" is not open.`);

  /** Entries in the order a lookup should prefer them: the project's copy, the person's, built in. */
  async function effectiveCatalogue(src: Source | undefined): Promise<RfCatalogueEntry[]> {
    const project = src ? await readProjectCatalogue(src) : { entries: [] };
    const user = await readCatalogueDir(deps.userDir);
    const builtin = await readCatalogueDir(deps.builtinDir);
    return [...project.entries, ...user.entries, ...builtin.entries];
  }

  return {
    async readSectors(req: IpcRequest<'rf:readSectors'>): Promise<IpcResponse<'rf:readSectors'>> {
      const src = sourceOf(req.projectId);
      if (!src) return notOpen(req.projectId);
      let raw: unknown;
      try {
        // remembered, so the save that follows compares with what the person saw
        const root = deps.projects.root(req.projectId);
        raw =
          root === undefined
            ? await src.json(RF_SECTORS_PATH)
            : await readJsonSeen(join(root, RF_SECTORS_PATH));
      } catch (e) {
        return fail(`${RF_SECTORS_PATH} could not be read: ${why(e)}`);
      }
      if (raw === undefined) return { ok: true, file: null, readOnly: src.readOnly, orphans: [] };
      const r = parseRfSectors(raw);
      if (!r.ok) return fail(r.error);
      return {
        ok: true,
        file: r.value,
        readOnly: src.readOnly,
        orphans: await findOrphans(src, r.value),
      };
    },

    async writeSectors(
      req: IpcRequest<'rf:writeSectors'>,
    ): Promise<IpcResponse<'rf:writeSectors'>> {
      if (deps.projects.package(req.projectId))
        return fail(
          'This project is a read-only package. Coverage settings cannot be changed.',
          'read-only',
        );
      const root = deps.projects.root(req.projectId);
      if (root === undefined)
        return fail(`Project "${req.projectId}" is not open. Open it, then save again.`);
      const src = folderSource(root);
      // the contract delivers parsed data; this fills the defaults for a caller that did not
      const file = RfSectorsFile.parse(req.file);

      // a file from a newer version is never replaced
      const target = join(root, RF_SECTORS_PATH);
      try {
        const onDisk = await readJson(target);
        if (onDisk !== undefined) {
          const existing = parseRfSectors(onDisk);
          if (!existing.ok && existing.reason === 'newer') return fail(existing.error);
        }
      } catch {
        // an unreadable file is replaced; the previous one is kept as .bak
      }

      const catalogue = await effectiveCatalogue(src);
      const byId = new Map<string, RfCatalogueEntry>();
      for (const e of [...catalogue].reverse()) byId.set(e.id, e);
      const used = new Map<string, RfCatalogueEntry>();
      const problems: string[] = [];
      for (const a of file.antennas) {
        const ids = [
          ...(a.equipment?.kind === 'aau'
            ? [a.equipment.aau]
            : a.equipment
              ? [a.equipment.antenna, ...(a.equipment.radio ? [a.equipment.radio] : [])]
              : []),
          ...a.carriers.flatMap((c) => (c.radioUnit ? [c.radioUnit] : [])),
        ];
        for (const id of ids) {
          const e = byId.get(id);
          if (e) used.set(id, e);
          else problems.push(`${id} is not in the catalogue.`);
        }
        problems.push(...etiltProblems(a, catalogue).filter((p) => !problems.includes(p)));
        problems.push(...carrierProblems(a));
      }
      if (problems.length > 0) {
        const shown = [...new Set(problems)];
        return fail(
          `The coverage settings were not saved: ${shown.slice(0, 5).join(' ')}${shown.length > 5 ? ` (and ${String(shown.length - 5)} more)` : ''}`,
        );
      }

      const warnings: string[] = [];
      try {
        warnings.push(...(await copyUsedEntries(root, src, used)));
        await mkdir(join(root, 'rf'), { recursive: true });
        await writeJsonSeen(target, file, { backup: true, name: RF_SECTORS_PATH });
      } catch (e) {
        if (isChangedOnDisk(e)) return fail(e.message);
        return fail(`Could not save ${target}: ${why(e)}`);
      }
      return warnings.length > 0 ? { ok: true, warnings } : { ok: true };
    },

    async listCatalogue(
      req: IpcRequest<'rf:listCatalogue'>,
    ): Promise<IpcResponse<'rf:listCatalogue'>> {
      const warnings: string[] = [];
      const entries: { origin: 'builtin' | 'user' | 'project'; entry: RfCatalogueEntry }[] = [];
      const add = (origin: 'builtin' | 'user' | 'project', r: CatalogueRead): void => {
        entries.push(...r.entries.map((entry) => ({ origin, entry })));
        warnings.push(...r.warnings);
      };
      add('builtin', await readCatalogueDir(deps.builtinDir));
      add('user', await readCatalogueDir(deps.userDir));
      if (req.projectId !== undefined) {
        const src = sourceOf(req.projectId);
        if (!src) return notOpen(req.projectId);
        add('project', await readProjectCatalogue(src));
      }
      return { ok: true, entries, warnings };
    },

    async importCatalogue(
      req: IpcRequest<'rf:importCatalogue'>,
    ): Promise<IpcResponse<'rf:importCatalogue'>> {
      try {
        return req.format === 'msi' ? await importMsi(req) : await importCatalogueFile(req);
      } catch (e) {
        return fail(`Could not import ${basename(req.path)}: ${why(e)}`);
      }
    },

    async listRuns(req: IpcRequest<'rf:listRuns'>): Promise<IpcResponse<'rf:listRuns'>> {
      const src = sourceOf(req.projectId);
      if (!src) return notOpen(req.projectId);
      const runs: RfRun[] = [];
      try {
        for (const id of await src.folders(RF_RUNS_DIR)) {
          const r = await readRunFrom(src, id);
          if (r.ok) runs.push(r.run);
        }
      } catch (e) {
        return fail(`Could not list the coverage runs: ${why(e)}`);
      }
      runs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      return { ok: true, runs };
    },

    async readRun(req: IpcRequest<'rf:readRun'>): Promise<IpcResponse<'rf:readRun'>> {
      const src = sourceOf(req.projectId);
      if (!src) return notOpen(req.projectId);
      return readRunFrom(src, req.runId);
    },

    async export(req: IpcRequest<'rf:export'>): Promise<IpcResponse<'rf:export'>> {
      const src = sourceOf(req.projectId);
      if (!src) return notOpen(req.projectId);
      const r = await readRunFrom(src, req.runId);
      if (!r.ok) return r;
      const run = r.run;
      if (run.status !== 'done')
        return fail(`Run ${run.runId} did not finish, so it has no results to export.`);
      const view = req.view ?? 'rsrp';
      if (req.format === 'geojson' && view !== 'rsrp')
        return fail('Coverage polygons are drawn from the RSRP grid. Choose the RSRP view.');
      const name =
        req.format === 'csv'
          ? `${run.runId}-sectors.csv`
          : req.format === 'geojson'
            ? `${run.runId}-coverage.geojson`
            : `${run.runId}-${view}.tif`;
      const refused = deps.refuse?.(req.projectId, name) ?? null;
      if (refused !== null) return fail(refused);

      // read first, so a missing grid is reported before the dialog is shown
      let body: Buffer | string;
      try {
        const geo = gridGeo(run);
        const thresholds = run.inputs.sectors.study.thresholds;
        if (req.format === 'geotiff') {
          body = writeGridTiff(await loadGrid(src, run, run.outputs[view]), geo);
        } else if (req.format === 'geojson') {
          body = JSON.stringify(
            coverageGeoJson(await loadGrid(src, run, run.outputs.rsrp), geo, thresholds),
          );
        } else {
          body = classAreasCsv({
            rsrp: await loadGrid(src, run, run.outputs.rsrp),
            bestServer: await loadGrid(src, run, run.outputs.bestServer),
            grid: geo,
            thresholds,
            sectors: run.inputs.sectors.sectors.map((s) => ({ id: s.id, name: s.name })),
          });
        }
      } catch (e) {
        return fail(`Run ${run.runId} could not be exported: ${why(e)}`);
      }
      const path = await deps.choose(name, req.format);
      if (path === null) return { ok: true, path: null };
      try {
        await writeFile(path, body);
      } catch (e) {
        return fail(`${name} could not be saved to ${path}: ${why(e)}`);
      }
      return { ok: true, path };
    },
  };

  /** Copy the entries a project uses, and their pattern files, into `rf/` (D10). */
  async function copyUsedEntries(
    root: string,
    src: Source,
    used: Map<string, RfCatalogueEntry>,
  ): Promise<string[]> {
    const warnings: string[] = [];
    if (used.size === 0) return warnings;
    const project = await readProjectCatalogue(src);
    const have = new Set(project.entries.map((e) => e.id));
    const fresh = [...used.values()].filter((e) => !have.has(e.id));
    if (fresh.length === 0) return warnings;
    const rfDir = join(root, 'rf');
    await mkdir(rfDir, { recursive: true });
    // the copy beside the entry's own catalogue folder: user entries first, then built in
    const userIds = new Set((await readCatalogueDir(deps.userDir)).entries.map((e) => e.id));
    const copies: RfCatalogueEntry[] = [];
    for (const e of fresh) {
      const from = userIds.has(e.id) ? deps.userDir : deps.builtinDir;
      const missing = new Set(
        from === null ? patternFiles(e) : await copyPatterns(from, rfDir, patternFiles(e)),
      );
      if (missing.size > 0) {
        warnings.push(
          `Pattern files of ${e.id} could not be copied into the project (${[...missing].join(', ')}). Those patterns are left out, so the generic pattern is used for them.`,
        );
      }
      copies.push(withoutPatterns(e, missing));
    }
    await writeJsonSeen(
      join(rfDir, 'catalogue.json'),
      catalogueDoc([...project.entries, ...copies]),
      {
        backup: true,
        name: RF_CATALOGUE_PATH,
      },
    );
    return warnings;
  }

  async function saveUserEntries(changed: RfCatalogueEntry[]): Promise<string[]> {
    const file = join(deps.userDir, USER_FILE);
    const current = await readCatalogueFile(file);
    if (current.warnings.length > 0)
      throw new Error(
        `${USER_FILE} in your catalogue could not be read, so it was not changed. ${current.warnings.join(' ')}`,
      );
    const warnings: string[] = [];
    const entries = [...current.entries];
    for (const e of changed) {
      const i = entries.findIndex((x) => x.id === e.id);
      if (i >= 0) {
        entries[i] = e;
        warnings.push(`Replaced ${e.id}, which was already in your catalogue.`);
      } else entries.push(e);
    }
    await mkdir(deps.userDir, { recursive: true });
    await writeJsonAtomic(file, catalogueDoc(entries), { backup: true });
    return warnings;
  }

  async function importCatalogueFile(
    req: IpcRequest<'rf:importCatalogue'>,
  ): Promise<IpcResponse<'rf:importCatalogue'>> {
    if ((await stat(req.path)).size > MAX_CATALOGUE_BYTES)
      return fail('The catalogue file is too large.');
    let raw: unknown;
    try {
      raw = JSON.parse(stripBom(await readFile(req.path, 'utf8'))) as unknown;
    } catch {
      return fail(`${basename(req.path)} is not a JSON file.`);
    }
    const r = parseRfCatalogue(raw);
    if (!r.ok) return fail(r.error);
    const warnings = await saveUserEntries(r.value.entries);
    const files = [...new Set(r.value.entries.flatMap(patternFiles))];
    const missing = await copyPatterns(dirname(req.path), deps.userDir, files);
    if (missing.length > 0)
      warnings.push(`Pattern files not found beside the catalogue file: ${missing.join(', ')}.`);
    const builtin = new Set((await readCatalogueDir(deps.builtinDir)).entries.map((e) => e.id));
    const shadowed = r.value.entries.filter((e) => builtin.has(e.id)).map((e) => e.id);
    if (shadowed.length > 0) warnings.push(`Same id as a built in entry: ${shadowed.join(', ')}.`);
    return { ok: true, entries: r.value.entries, warnings };
  }

  async function importMsi(
    req: IpcRequest<'rf:importCatalogue'>,
  ): Promise<IpcResponse<'rf:importCatalogue'>> {
    const attach = req.attach;
    if (!attach) return fail('Choose the antenna and port the pattern file belongs to.');
    if ((await stat(req.path)).size > MAX_MSI_BYTES) return fail('The pattern file is too large.');
    const text = await readFile(req.path, 'utf8');
    let parsed: MsiPattern;
    try {
      parsed = parseMsi(text);
    } catch (e) {
      return fail(`${basename(req.path)}: ${why(e).replace(/^MSI: /, '')}`);
    }
    const user = await readCatalogueFile(join(deps.userDir, USER_FILE));
    const pool = [...user.entries, ...(await readCatalogueDir(deps.builtinDir)).entries];
    const entry = pool.find((e) => e.id === attach.entryId);
    if (entry?.kind !== 'antenna')
      return fail(`${attach.entryId} is not an antenna in the catalogue.`);
    const portIndex = entry.ports.findIndex((p) => p.id === attach.portId);
    const port = entry.ports[portIndex];
    if (!port) return fail(`${attach.entryId} has no port ${attach.portId}.`);

    const { frequencyMhz } = parsed;
    const warnings: string[] = [];
    let etiltDeg = parsed.etiltDeg ?? null;
    if (etiltDeg === null) {
      if (port.etilt.minDeg !== port.etilt.maxDeg)
        return fail('The file does not say its electrical tilt (a TILT line with a number).');
      etiltDeg = port.etilt.minDeg;
    } else if (etiltDeg < port.etilt.minDeg || etiltDeg > port.etilt.maxDeg) {
      warnings.push(`The file's tilt ${String(etiltDeg)} is outside the port's range.`);
    }
    if (frequencyMhz < port.bandRangeMhz[0] || frequencyMhz > port.bandRangeMhz[1])
      warnings.push(
        `The file's frequency ${String(frequencyMhz)} MHz is outside the port's band range.`,
      );

    const file = `patterns/${safeName(`${entry.id}-${port.id}-${String(frequencyMhz)}-${String(etiltDeg)}`)}.msi`;
    await mkdir(join(deps.userDir, 'patterns'), { recursive: true });
    await writeFile(join(deps.userDir, file), text);
    const patterns = [
      ...port.patterns.filter((p) => !(p.frequencyMhz === frequencyMhz && p.etiltDeg === etiltDeg)),
      { frequencyMhz, etiltDeg, file },
    ].sort((a, b) => a.frequencyMhz - b.frequencyMhz || a.etiltDeg - b.etiltDeg);
    const updated: RfCatalogueEntry = {
      ...entry,
      ports: entry.ports.map((p, i) => (i === portIndex ? { ...p, patterns } : p)),
    };
    warnings.push(...(await saveUserEntries([updated])).filter((w) => !w.startsWith('Replaced')));
    return { ok: true, entries: [updated], warnings };
  }
}

export type RfHandlers = ReturnType<typeof createRf>;
