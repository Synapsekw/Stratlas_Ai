import { z } from 'zod';
import { Id, IsoTime, err, ok, type Result } from './common';
import { PackageReplyPolicy } from './exchange';

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

/** May the holder extract the package into an editable project ("extract to edit"). */
export const EditPolicy = z.enum(['forbid', 'allow']);

/** Folder inside a package that holds embedded map packs (`<id>.pmtiles` with `<id>.json`). */
export const EMBEDDED_PACKS_DIR = 'packs';

/** File an extracted project keeps at its root: where it came from. */
export const PACKAGE_ORIGIN_FILE = 'package-origin.json';

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
  /**
   * Extract to edit. Absent in packages written before it existed: then a working package
   * (`readOnly: false`) may be extracted and a customer package may not (`packageEditAllowed`).
   */
  editPolicy: EditPolicy.optional(),
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
  // ---- M9; both optional, and older players strip them (this object is not strict) ----
  /** The holder may send back comments and acceptance as a signed reply file (`.aiosync`). */
  reply: PackageReplyPolicy.optional(),
  /** History carried: the signed audit summary (customer default) or the full journal. */
  journal: z.enum(['full', 'summary']).optional(),
});

/** What the renderer learns about an opened package. */
export const PackageInfo = z.object({
  header: PackageHeader,
  /** The `.aio` file. */
  file: z.string(),
  encrypted: z.boolean(),
  sizeBytes: z.number().int().nonnegative(),
});

/**
 * `package-origin.json` in a project extracted from a package: the package it came from and when
 * that package was exported, shown with the project so nobody mistakes the copy for the source.
 */
export const PackageOrigin = z.object({
  schema: z.literal('aio.origin/1'),
  /** File name of the `.aio` package. */
  package: z.string().min(1),
  /** Where the package was when it was extracted. */
  path: z.string().optional(),
  /** Project id inside the package (the builder's project). */
  projectId: Id,
  /** When the package was exported (`PackageHeader.createdAt`). */
  exportedAt: IsoTime,
  /** App that exported it. */
  exportedBy: z.string().optional(),
  extractedAt: IsoTime,
  /** Person (OS account) who extracted it. */
  extractedBy: z.string().optional(),
  encrypted: z.boolean(),
});

/** May this package be extracted into an editable project. */
export function packageEditAllowed(
  header: Pick<PackageHeader, 'editPolicy' | 'readOnly'>,
): boolean {
  return header.editPolicy === undefined ? !header.readOnly : header.editPolicy === 'allow';
}

export type ExportKind = z.infer<typeof ExportKind>;
export type AiPolicy = z.infer<typeof AiPolicy>;
export type EditPolicy = z.infer<typeof EditPolicy>;
export type PackageOrigin = z.infer<typeof PackageOrigin>;
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
    return err(
      `Package was written by a newer version of Quadrion AI (${version}). Update the app to open it.`,
    );
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
