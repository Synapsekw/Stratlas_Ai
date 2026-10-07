/**
 * Registry of every file schema Stratlas reads or writes, and the one way to read a versioned
 * file (M9 T8). The 1.x policy (`docs/release/UPGRADE-POLICY.md`):
 *
 * - every `/1` file stays readable by every 1.x build;
 * - a future `/2` comes with a migrator here, a one-time **Upgrade project** with a backup, and an
 *   "older builds cannot open it" warning;
 * - a reader that meets a newer version refuses with "saved by a newer version, update the app"
 *   and changes nothing, as `parseManifest` and `parsePackageHeader` already do.
 *
 * Nothing here touches the disk: callers read the JSON, call `readVersioned` (or `newerRefusal`
 * before their own parse) and write only after a successful read.
 */

/**
 * Where a schema lives: a project, a package, userData, a hub folder, an exchange file, the
 * server, the pipeline pack or the app bundle (the demo).
 */
export type SchemaHome =
  'project' | 'package' | 'userData' | 'hub' | 'exchange' | 'server' | 'pack' | 'app';

export interface SchemaEntry {
  /** `aio.<name>` without the version. */
  family: string;
  /** Newest version this build reads and writes. */
  version: number;
  home: SchemaHome;
  /** Path or member pattern, for the docs and error messages. */
  where: string;
  /**
   * First milestone build that wrote it, from the git history (`tools/compat/milestones.mjs`).
   * `0.4` means 0.4 or earlier: the oldest build in the compatibility corpus.
   */
  since: string;
}

/** Every `aio.*` file schema in this build. A new file schema adds a row here. */
export const SCHEMA_REGISTRY: readonly SchemaEntry[] = [
  { family: 'aio.project', version: 1, home: 'project', where: 'manifest.json', since: '0.4' },
  { family: 'aio.issues', version: 1, home: 'project', where: 'issues.json', since: '0.4' },
  { family: 'aio.flight', version: 1, home: 'project', where: 'flight pose files', since: '0.4' },
  { family: 'aio.tiles', version: 1, home: 'project', where: 'raster tile index', since: '0.4' },
  { family: 'aio.road', version: 1, home: 'project', where: 'road.json', since: '0.4' },
  { family: 'aio.volumes', version: 1, home: 'project', where: 'volumes.json', since: '0.4' },
  {
    family: 'aio.boundaries',
    version: 1,
    home: 'project',
    where: 'edits/boundaries.json',
    since: '0.4',
  },
  {
    family: 'aio.panoramas',
    version: 1,
    home: 'project',
    where: 'panoramas/panoramas.json',
    since: '0.4',
  },
  {
    family: 'aio.pngcloud',
    version: 1,
    home: 'project',
    where: 'point cloud PNG index',
    since: '0.4',
  },
  {
    family: 'aio.patch',
    version: 1,
    home: 'project',
    where: 'models/patches/*.json',
    since: '0.4',
  },
  {
    family: 'aio.aik-records',
    version: 1,
    home: 'project',
    where: 'inspection records.json',
    since: '0.4',
  },
  { family: 'aio.job', version: 1, home: 'project', where: 'jobs/<id>/ job record', since: '0.4' },
  {
    family: 'aio.detections',
    version: 1,
    home: 'project',
    where: 'detections/*.json',
    since: '0.6',
  },
  {
    family: 'aio.narrative',
    version: 1,
    home: 'project',
    where: 'report/narrative.json',
    since: '0.6',
  },
  { family: 'aio.origin', version: 1, home: 'project', where: 'package-origin.json', since: '0.6' },
  {
    family: 'aio.inspection-issues',
    version: 1,
    home: 'project',
    where: 'inspection issue map',
    since: '0.6',
  },
  {
    family: 'aio.contact-sheets',
    version: 1,
    home: 'project',
    where: 'inspection contact sheets index',
    since: '0.6',
  },
  { family: 'aio.change', version: 1, home: 'project', where: 'change/*.json', since: '0.8' },
  {
    family: 'aio.procmodel',
    version: 1,
    home: 'project',
    where: 'models/*.procmodel.json',
    since: '0.8',
  },
  {
    family: 'aio.drawingplacement',
    version: 1,
    home: 'project',
    where: 'drawings/*/placement.json',
    since: '0.8',
  },
  { family: 'aio.grid', version: 1, home: 'project', where: 'change/sources/*.json', since: '0.8' },
  { family: 'aio.package', version: 1, home: 'package', where: 'aio-package.json', since: '0.4' },
  {
    family: 'aio.conversation',
    version: 1,
    home: 'userData',
    where: 'conversations/*.json',
    since: '0.4',
  },
  {
    family: 'aio.ai-projects',
    version: 1,
    home: 'userData',
    where: 'ai-projects.json',
    since: '0.4',
  },
  {
    family: 'aio.pmextract',
    version: 1,
    home: 'userData',
    where: 'map pack extract plan',
    since: '0.6',
  },
  {
    family: 'aio.update-journal',
    version: 1,
    home: 'userData',
    where: 'updates/journal.json',
    since: '0.7',
  },
  {
    family: 'aio.detector',
    version: 1,
    home: 'userData',
    where: 'models/detect/*/model.json',
    since: '0.8',
  },
  { family: 'aio.update-feed', version: 1, home: 'server', where: 'update feed', since: '0.7' },
  { family: 'aio.demo', version: 1, home: 'app', where: 'demo/demo.json', since: '0.7' },
  {
    family: 'aio.pipeline-pack',
    version: 1,
    home: 'pack',
    where: 'pipeline pack manifest.json',
    since: '0.4',
  },
  // M9
  {
    family: 'aio.op',
    version: 1,
    home: 'project',
    where: 'journal/ops/<chain>/*.jsonl',
    since: '0.9',
  },
  {
    family: 'aio.checkpoint',
    version: 1,
    home: 'project',
    where: 'journal/checkpoints/*.json',
    since: '0.9',
  },
  {
    family: 'aio.device',
    version: 1,
    home: 'project',
    where: 'journal/devices/*.json',
    since: '0.9',
  },
  { family: 'aio.team', version: 1, home: 'project', where: 'team.json', since: '0.9' },
  {
    family: 'aio.orientation',
    version: 1,
    home: 'project',
    where: 'orientation.json',
    since: '0.9',
  },
  { family: 'aio.identity', version: 1, home: 'userData', where: 'identity.json', since: '0.9' },
  {
    family: 'aio.team-config',
    version: 1,
    home: 'userData',
    where: 'team/projects.json',
    since: '0.9',
  },
  { family: 'aio.idcard', version: 1, home: 'exchange', where: '*.aioid', since: '0.9' },
  {
    family: 'aio.exchange',
    version: 1,
    home: 'exchange',
    where: '*.aiosync aio-exchange.json',
    since: '0.9',
  },
  { family: 'aio.hub', version: 1, home: 'hub', where: 'aio-hub.json', since: '0.9' },
  {
    family: 'aio.presence',
    version: 1,
    home: 'hub',
    where: 'projects/*/presence/*.json',
    since: '0.9',
  },
  {
    family: 'aio.receipt',
    version: 1,
    home: 'server',
    where: 'receipts (team server)',
    since: '0.9',
  },
  { family: 'aio.audit', version: 1, home: 'exchange', where: 'audit-json export', since: '0.9' },
  {
    family: 'aio.journal-cache',
    version: 1,
    home: 'userData',
    where: 'journal-cache/*/meta.json',
    since: '0.9',
  },
  {
    family: 'aio.team-servers',
    version: 1,
    home: 'userData',
    where: 'team/servers.json',
    since: '0.9',
  },
  {
    family: 'aio.blob-cache',
    version: 1,
    home: 'userData',
    where: 'blobs/ cache index',
    since: '0.9',
  },
  {
    family: 'aio.exchange-enc',
    version: 1,
    home: 'exchange',
    where: 'encrypted *.aiosync header line',
    since: '0.9',
  },
  {
    family: 'aio.server-audit',
    version: 1,
    home: 'server',
    where: 'export-audit folder (team server CLI)',
    since: '0.9',
  },
  {
    family: 'aio.server-backup',
    version: 1,
    home: 'server',
    where: 'backup .jsonl (team server CLI)',
    since: '0.9',
  },
  // library.json had no schema id before 0.9; files without one read as /1.
  { family: 'aio.library', version: 1, home: 'userData', where: 'library.json', since: '0.9' },
  // M10: every new file lives beside the manifest or in a new folder, so 0.9 never reads it.
  {
    family: 'aio.photo-run',
    version: 1,
    home: 'project',
    where: 'photogrammetry/<run>/run.json',
    since: '0.10',
  },
  {
    family: 'aio.gcp',
    version: 1,
    home: 'project',
    where: 'photogrammetry/<run>/gcp.json',
    since: '0.10',
  },
  {
    family: 'aio.photo-accuracy',
    version: 1,
    home: 'project',
    where: 'photogrammetry/<run>/report/accuracy.json',
    since: '0.10',
  },
  { family: 'aio.tilesets', version: 1, home: 'project', where: 'tilesets.json', since: '0.10' },
  {
    family: 'aio.raster-pack',
    version: 1,
    home: 'userData',
    where: 'packs/imagery/*.json and packs/terrain/*.json (data folder)',
    since: '0.10',
  },
  {
    family: 'aio.globe-settings',
    version: 1,
    home: 'userData',
    where: 'globe.json',
    since: '0.10',
  },
];

/**
 * Ids that look like file schemas but are not files: wire protocols (`aio.pipelines/1`,
 * `aio.sync/1`), signing domains (`aio.cert/1`, `aio.request/1`) and tool-only formats (the
 * demo's ground truth, the calibration patch). The registry test fails on any other unlisted id.
 */
export const NOT_FILE_SCHEMAS: readonly string[] = [
  'aio.pipelines/1',
  'aio.sync/1',
  'aio.cert/1',
  'aio.request/1',
  'aio.invite/1',
  'aio.truth/1',
  'aio.video-calibration-patch/1',
];

/** `aio.<family>/<version>` split, or null when the string is not a schema id. */
export function parseSchemaId(id: string): { family: string; version: number } | null {
  const m = /^(aio\.[a-z][a-z0-9-]*)\/([1-9]\d{0,3})$/.exec(id);
  return m?.[1] && m[2] ? { family: m[1], version: Number(m[2]) } : null;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * The schema id a file declares: its `schema` string, or for ops and checkpoints (which carry a
 * numeric `v`) `<family>/<v>` when the caller names the family. Null when there is none.
 */
export function schemaIdOf(raw: unknown, family?: string): string | null {
  if (!isRecord(raw)) return null;
  const own = (k: string): unknown => (Object.hasOwn(raw, k) ? raw[k] : undefined);
  const schema = own('schema');
  if (typeof schema === 'string') return schema;
  const v = own('v');
  if (family && typeof v === 'number' && Number.isInteger(v) && v > 0)
    return `${family}/${String(v)}`;
  return null;
}

export type ReaderVerdict =
  | { kind: 'current'; entry: SchemaEntry }
  /** An older version this build migrates (none in 1.0: every schema is still `/1`). */
  | { kind: 'older'; entry: SchemaEntry; from: number }
  | { kind: 'newer'; entry: SchemaEntry; found: number; message: string }
  | { kind: 'unknown'; message: string };

const newerMessage = (where: string, id: string, appName: string) =>
  `${where} was saved by a newer version of ${appName} (${id}). Update the app to open it. The file was not changed.`;

/** How this build treats a file with schema `id`. */
export function readerFor(id: string, appName = 'the app'): ReaderVerdict {
  const parsed = parseSchemaId(id);
  const entry = parsed ? SCHEMA_REGISTRY.find((e) => e.family === parsed.family) : undefined;
  if (!parsed || !entry) return { kind: 'unknown', message: `Unknown file format "${id}".` };
  if (parsed.version === entry.version) return { kind: 'current', entry };
  if (parsed.version < entry.version) return { kind: 'older', entry, from: parsed.version };
  return {
    kind: 'newer',
    entry,
    found: parsed.version,
    message: newerMessage(entry.where, id, appName),
  };
}

/**
 * The refusal for a file saved by a newer build, or null. One line before an existing reader's
 * own parse: `const newer = newerRefusal(raw, brand.productName); if (newer) return err(newer);`.
 * Unknown families answer null (the reader's own check names them).
 */
export function newerRefusal(raw: unknown, appName = 'the app', family?: string): string | null {
  const id = schemaIdOf(raw, family);
  if (id === null) return null;
  const verdict = readerFor(id, appName);
  return verdict.kind === 'newer' ? verdict.message : null;
}

/** One step of a migrator chain: a `from` file of `family` becomes a `from + 1` file. */
export interface Migration {
  family: string;
  from: number;
  /** What changes, for the Upgrade project dialog and the release notes. */
  note: string;
  /** Pure: returns a new object and never mutates `raw`. */
  migrate: (raw: Record<string, unknown>) => Record<string, unknown>;
}

/** Migrators of this build. Empty in 1.0: every schema is still `/1`. */
export const MIGRATIONS: readonly Migration[] = [];

/** The steps from `from` to `to`, in order; null when a step is missing. */
export function migrationPath(
  family: string,
  from: number,
  to: number,
  migrations: readonly Migration[] = MIGRATIONS,
): Migration[] | null {
  const steps: Migration[] = [];
  for (let v = from; v < to; v++) {
    const step = migrations.find((m) => m.family === family && m.from === v);
    if (!step) return null;
    steps.push(step);
  }
  return steps;
}

/** Structural so this module does not tie callers to one zod major. */
interface SafeParser<T> {
  safeParse(
    v: unknown,
  ):
    | { success: true; data: T }
    | { success: false; error: { issues: { path: PropertyKey[]; message: string }[] } };
}

export type VersionedRead<T> =
  | { ok: true; value: T; migratedFrom: number | null }
  | {
      ok: false;
      reason: 'not-object' | 'wrong-family' | 'newer' | 'older' | 'invalid';
      error: string;
    };

export interface ReadVersionedOptions<T> {
  family: string;
  /** The current schema (zod or anything with the same `safeParse`). */
  schema: SafeParser<T>;
  /** Newest version this reader knows; default: the registry row (1 when unregistered). */
  version?: number;
  /** Product name for messages (`brand.productName`). */
  appName?: string;
  /** How the file is named in messages, e.g. `issues.json` or a full path. */
  what?: string;
  migrations?: readonly Migration[];
}

/**
 * Read a versioned file: refuse newer versions without touching them, migrate older ones step by
 * step (on a copy), then validate. Never throws for any JSON value.
 */
export function readVersioned<T>(raw: unknown, o: ReadVersionedOptions<T>): VersionedRead<T> {
  const entry = SCHEMA_REGISTRY.find((e) => e.family === o.family);
  const current = o.version ?? entry?.version ?? 1;
  const appName = o.appName ?? 'the app';
  const what = o.what ?? entry?.where ?? o.family;
  if (!isRecord(raw))
    return { ok: false, reason: 'not-object', error: `${what} is not a JSON object.` };
  let data: Record<string, unknown> = raw;
  let migratedFrom: number | null = null;
  const id = schemaIdOf(raw, o.family);
  const parsed = id === null ? null : parseSchemaId(id);
  if (id !== null && parsed?.family !== o.family) {
    return {
      ok: false,
      reason: 'wrong-family',
      error: `${what} is not an ${o.family} file (${id}).`,
    };
  }
  if (parsed && parsed.version > current) {
    return { ok: false, reason: 'newer', error: newerMessage(what, id ?? '', appName) };
  }
  if (parsed && parsed.version < current) {
    const steps = migrationPath(o.family, parsed.version, current, o.migrations ?? MIGRATIONS);
    if (!steps) {
      return {
        ok: false,
        reason: 'older',
        error: `${what} was saved by an older version of ${appName} (${id ?? ''}) that this version cannot convert. The file was not changed.`,
      };
    }
    try {
      for (const step of steps) data = step.migrate(structuredClone(data));
    } catch (e) {
      return {
        ok: false,
        reason: 'older',
        error: `${what} could not be converted from ${id ?? ''}: ${e instanceof Error ? e.message : String(e)}. The file was not changed.`,
      };
    }
    migratedFrom = parsed.version;
  }
  const r = o.schema.safeParse(data);
  if (r.success) return { ok: true, value: r.data, migratedFrom };
  const first = r.error.issues[0];
  const at = first?.path.length ? ` at ${first.path.map(String).join('.')}` : '';
  return {
    ok: false,
    reason: 'invalid',
    error: `${what} is invalid${at}: ${first?.message ?? 'unknown error'}`,
  };
}

// Pipeline pack app ranges ---------------------------------------------------------------------

const VERSION = /^\d+(\.\d+){0,2}(-[0-9A-Za-z.-]+)?$/;

/** Dotted-version order; a pre-release (`1.0.0-rc.1`) sorts before its release. */
export function compareVersions(a: string, b: string): number {
  const split = (v: string) => {
    const [core = '', pre] = v.split(/-(.*)/s, 2);
    const nums = core.split('.').map((n) => Number(n) || 0);
    while (nums.length < 3) nums.push(0);
    return { nums, pre };
  };
  const x = split(a);
  const y = split(b);
  for (let i = 0; i < 3; i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
    if (d !== 0) return d;
  }
  if (x.pre === y.pre) return 0;
  if (x.pre === undefined) return 1;
  if (y.pre === undefined) return -1;
  const xp = x.pre.split('.');
  const yp = y.pre.split('.');
  for (let i = 0; i < Math.max(xp.length, yp.length); i++) {
    const p = xp[i];
    const q = yp[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn && Number(p) !== Number(q)) return Number(p) - Number(q);
    if (pn !== qn) return pn ? -1 : 1;
    if (p !== q) return p < q ? -1 : 1;
  }
  return 0;
}

export interface RangeComparator {
  op: '>=' | '>' | '<=' | '<' | '=';
  version: string;
}

/**
 * Parse an app range such as `>=0.9.0 <2.0.0` (space-separated comparators, all must hold).
 * Null when it is empty or anything in it cannot be read.
 */
export function parseAppRange(range: string): RangeComparator[] | null {
  const parts = range.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return null;
  const out: RangeComparator[] = [];
  for (const p of parts) {
    const m = /^(>=|<=|>|<|=)?(.+)$/.exec(p);
    const version = m?.[2];
    if (!version || !VERSION.test(version)) return null;
    out.push({ op: (m[1] ?? '=') as RangeComparator['op'], version });
  }
  return out;
}

/** Does `version` satisfy `range`? A range that cannot be read allows nothing. */
export function appRangeAllows(range: string, version: string): boolean {
  const comparators = parseAppRange(range);
  if (!comparators) return false;
  return comparators.every(({ op, version: v }) => {
    const d = compareVersions(version, v);
    return op === '>='
      ? d >= 0
      : op === '>'
        ? d > 0
        : op === '<='
          ? d <= 0
          : op === '<'
            ? d < 0
            : d === 0;
  });
}

/**
 * The refusal for a pipeline pack whose declared `appRange` excludes this app, or null. A pack
 * that declares no range (0.3 and older) is accepted, as before.
 */
export function packRangeRefusal(
  appRange: string | undefined,
  appVersion: string,
  appName = 'the app',
): string | null {
  if (appRange === undefined) return null;
  const fix = 'Install the pipeline pack made for this version.';
  if (!parseAppRange(appRange))
    return `This pipeline pack declares an app range that cannot be read (${appRange}). ${fix}`;
  if (appRangeAllows(appRange, appVersion)) return null;
  return `This pipeline pack works with ${appName} ${appRange}, and this is ${appVersion}. ${fix}`;
}
