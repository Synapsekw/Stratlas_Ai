/**
 * Registry of every file schema Stratlas reads or writes (M9; T8 owns the logic and the migrator
 * hooks). The 1.x policy: every `/1` file stays readable; a future `/2` comes with a migrator, a
 * one-time Upgrade project with a backup, and an "older builds cannot open" warning. A reader that
 * meets a newer version refuses with "saved by a newer Stratlas, update the app", as
 * `parseManifest` and `parsePackageHeader` already do.
 */

/** Where a schema lives: a project, a package, userData, a hub folder or an exchange file. */
export type SchemaHome =
  'project' | 'package' | 'userData' | 'hub' | 'exchange' | 'server' | 'pack';

export interface SchemaEntry {
  /** `aio.<name>` without the version. */
  family: string;
  /** Newest version this build reads and writes. */
  version: number;
  home: SchemaHome;
  /** Path or member pattern, for the docs and error messages. */
  where: string;
  /** App version that introduced it, where known (T8 fills the rest from the git tags). */
  since?: string;
}

/** Every `aio.*` file schema in this build. A new file schema adds a row here. */
export const SCHEMA_REGISTRY: readonly SchemaEntry[] = [
  { family: 'aio.project', version: 1, home: 'project', where: 'project.json' },
  { family: 'aio.issues', version: 1, home: 'project', where: 'issues.json' },
  {
    family: 'aio.flight',
    version: 1,
    home: 'project',
    where: 'flight pose files (video layer poses)',
  },
  { family: 'aio.tiles', version: 1, home: 'project', where: 'raster tile index (kit-pyramid)' },
  { family: 'aio.road', version: 1, home: 'project', where: 'road.json' },
  { family: 'aio.volumes', version: 1, home: 'project', where: 'volumes.json' },
  { family: 'aio.boundaries', version: 1, home: 'project', where: 'edits/boundaries.json' },
  { family: 'aio.detections', version: 1, home: 'project', where: 'detections/*.json' },
  { family: 'aio.narrative', version: 1, home: 'project', where: 'report/narrative.json' },
  { family: 'aio.origin', version: 1, home: 'project', where: 'package-origin.json' },
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
  { family: 'aio.package', version: 1, home: 'package', where: 'aio-package.json' },
  { family: 'aio.conversation', version: 1, home: 'userData', where: 'conversations/*.json' },
  { family: 'aio.ai-projects', version: 1, home: 'userData', where: 'ai-projects.json' },
  {
    family: 'aio.update-feed',
    version: 1,
    home: 'server',
    where: 'update feed (UPDATE_FEED_FILE)',
  },
  { family: 'aio.panoramas', version: 1, home: 'project', where: 'panoramas/panoramas.json' },
  { family: 'aio.update-journal', version: 1, home: 'userData', where: 'updates/journal.json' },
  {
    family: 'aio.detector',
    version: 1,
    home: 'userData',
    where: 'models/detect/*/model.json',
    since: '0.8',
  },
  { family: 'aio.pipeline-pack', version: 1, home: 'pack', where: 'pack.json' },
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
];

/** `aio.<family>/<version>` split, or null when the string is not a schema id. */
export function parseSchemaId(id: string): { family: string; version: number } | null {
  const m = /^(aio\.[a-z][a-z0-9-]*)\/([1-9]\d{0,3})$/.exec(id);
  return m?.[1] && m[2] ? { family: m[1], version: Number(m[2]) } : null;
}

export type ReaderVerdict =
  | { kind: 'current'; entry: SchemaEntry }
  /** An older version this build migrates (none in 1.0: every schema is still `/1`). */
  | { kind: 'older'; entry: SchemaEntry; from: number }
  | { kind: 'newer'; entry: SchemaEntry; found: number; message: string }
  | { kind: 'unknown'; message: string };

/**
 * How this build treats a file with schema `id`. Skeleton for T8: classifies only; T8 adds the
 * migrator chain and wires every reader through it.
 */
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
    message: `${entry.where} was saved by a newer version of ${appName} (${id}). Update the app to open it.`,
  };
}
