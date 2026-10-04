import { z } from 'zod';
import { Id, IsoTime, err, ok, type Result } from './common';

export const PACKAGE_SCHEMA = 'aio.package/1' as const;

/** Member of a `.aio` package that holds its header (policy, welcome text). */
export const PACKAGE_HEADER_FILE = 'aio-package.json';

/** File extension of a single-file project package. */
export const PACKAGE_EXTENSION = '.aio';

/** What a package lets its holder export. */
export const ExportKind = z.enum([
  'issues-csv',
  'issues-geojson',
  'report-pdf',
  'snapshot',
  'kit-json',
  'masks',
  /** Any other project file (models, clips, photos). */
  'files',
]);

/** May project data be sent to a cloud AI provider while this package is open. */
export const AiPolicy = z.enum(['forbid', 'allow']);

export const DEFAULT_PACKAGE_EXPORTS: readonly z.infer<typeof ExportKind>[] = [
  'issues-csv',
  'report-pdf',
  'snapshot',
];

/**
 * `aio-package.json`: the header of a `.aio` package (BLD-9, APP-5). A customer package is
 * read-only, forbids cloud AI and limits exports unless the builder chose otherwise.
 */
export const PackageHeader = z.object({
  schema: z.literal(PACKAGE_SCHEMA),
  projectId: Id,
  createdAt: IsoTime,
  /** App name and version that wrote the package. */
  createdBy: z.string().optional(),
  /** Player mode: no editing, issues are never written. */
  readOnly: z.boolean().default(true),
  aiPolicy: AiPolicy.default('forbid'),
  exports: z.array(ExportKind).default([...DEFAULT_PACKAGE_EXPORTS]),
  /** Layers of the source project left out of the package. */
  excludedLayers: z.array(Id).default([]),
  /** Customer welcome screen. */
  welcome: z
    .object({
      message: z.string().max(2000).optional(),
      tips: z.array(z.string().min(1).max(200)).max(8).optional(),
    })
    .optional(),
});

/** What the renderer learns about an opened package. */
export const PackageInfo = z.object({
  header: PackageHeader,
  /** The `.aio` file. */
  file: z.string(),
  encrypted: z.boolean(),
  sizeBytes: z.number().int().nonnegative(),
});

export type ExportKind = z.infer<typeof ExportKind>;
export type AiPolicy = z.infer<typeof AiPolicy>;
export type PackageHeader = z.infer<typeof PackageHeader>;
export type PackageHeaderInput = z.input<typeof PackageHeader>;
export type PackageInfo = z.infer<typeof PackageInfo>;

/** Parse untrusted JSON into a package header, with messages a person can act on. */
export function parsePackageHeader(json: unknown): Result<PackageHeader> {
  if (typeof json !== 'object' || json === null) return err('Package header is not a JSON object.');
  const version = (json as { schema?: unknown }).schema;
  if (
    typeof version === 'string' &&
    version !== PACKAGE_SCHEMA &&
    version.startsWith('aio.package/')
  ) {
    return err(`Package was written by a newer Stratlas (${version}). Update the app to open it.`);
  }
  const r = PackageHeader.safeParse(json);
  if (r.success) return ok(r.data);
  const first = r.error.issues[0];
  const where = first?.path.length ? ` at ${first.path.join('.')}` : '';
  return err(`Package header is invalid${where}: ${first?.message ?? 'unknown error'}`);
}

const BY_EXTENSION: Record<string, ExportKind> = {
  csv: 'issues-csv',
  pdf: 'report-pdf',
  geojson: 'issues-geojson',
  png: 'snapshot',
  jpg: 'snapshot',
  jpeg: 'snapshot',
  webp: 'snapshot',
  json: 'kit-json',
  zip: 'masks',
};

/** The export kind a saved file falls under, by its extension. */
export function exportKindForFile(name: string): ExportKind {
  const dot = name.lastIndexOf('.');
  const ext = dot < 0 ? '' : name.slice(dot + 1).toLowerCase();
  return BY_EXTENSION[ext] ?? 'files';
}

/** May a file with this name be saved under a package's export list. */
export function exportAllowed(allowed: readonly ExportKind[], name: string): boolean {
  return allowed.includes(exportKindForFile(name));
}
