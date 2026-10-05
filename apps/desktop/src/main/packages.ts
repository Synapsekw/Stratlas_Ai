import {
  exportPackage,
  extractProject,
  extractRefusal,
  planPackage,
  scanProject,
  volumeFreeBytes,
  type PackagePlanResult,
  type SourceFile,
  type ZipArchive,
} from '@aio/project/package';
import {
  EXPORT_FORMAT_KIND,
  exportKindForFile,
  PACKAGE_EXTENSION,
  type ExportFormat,
  type IpcEvent,
  type IpcRequest,
  type IpcResponse,
  type MapPackInfo,
  type PackageHeader,
  type PackageMapPackRequest,
  type ProjectManifest,
  type ReportFile,
} from '@aio/schema';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join } from 'node:path';
import { embedSummary, planEmbed, writeEmbed } from './packs/embed';
import { readManifest, type PackageSource, type ProjectRegistry } from './project';

const EXPORT_LABEL: Record<string, string> = {
  'issues-csv': 'issue CSV',
  'issues-geojson': 'GeoJSON',
  'report-pdf': 'PDF',
  snapshot: 'image',
  'kit-json': 'JSON',
  masks: 'mask archive',
  files: 'project',
};

/** Cloud AI needs the global switch on and, inside a package, the package's permission (AI-2). */
export function cloudAllowedFor(setting: boolean, header: PackageHeader | undefined): boolean {
  if (!setting) return false;
  return header === undefined || header.aiPolicy === 'allow';
}

/** Null when a file may be saved; otherwise the message for the person. */
export function checkExport(header: PackageHeader | undefined, name: string): string | null {
  if (!header) return null;
  const kind = exportKindForFile(name);
  if (header.exports.includes(kind)) return null;
  return `This package does not allow saving ${EXPORT_LABEL[kind] ?? kind} files. Ask the sender for a package that includes them.`;
}

/**
 * Null when an issue export (`export:run`) may run for a project with this package header (none:
 * a folder project); otherwise the message for the person. COCO and masks read the photo files
 * of a project folder, so a package never offers them.
 */
export function exportFormatRefusal(
  header: PackageHeader | undefined,
  format: ExportFormat,
): string | null {
  if (!header) return null;
  const kind = EXPORT_FORMAT_KIND[format];
  if (!header.exports.includes(kind))
    return `This package does not allow saving ${EXPORT_LABEL[kind] ?? kind} files. Ask the sender for a package that includes them.`;
  if (format === 'coco' || format === 'masks-zip')
    return 'COCO and mask exports need the project folder with its photos; they are not available from a package.';
  return null;
}

/** `report:list` for a package: the PDFs it carries in `report/`, read in place. */
export function packageReports(archive: Pick<ZipArchive, 'entries'>): ReportFile[] {
  const out: ReportFile[] = [];
  for (const [name, e] of archive.entries) {
    const m = /^report\/([^/]+\.pdf)$/i.exec(name);
    if (m?.[1]) out.push({ path: name, name: m[1], sizeBytes: e.size });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * A temp folder with a package's manifest and issues, for the export utility (which reads a
 * project folder). The package itself is never written; `dispose` removes the folder.
 */
export async function stagePackageExport(
  pkg: Pick<PackageSource, 'archive' | 'manifest'>,
  tempDir: string,
): Promise<{ root: string; dispose(): Promise<void> }> {
  const root = await mkdtemp(join(tempDir, 'stratlas-export-'));
  try {
    await writeFile(join(root, 'manifest.json'), JSON.stringify(pkg.manifest));
    const issues = pkg.archive.entries.has('issues.json')
      ? await pkg.archive.read('issues.json')
      : JSON.stringify({ schema: 'aio.issues/1', issues: [] });
    await writeFile(join(root, 'issues.json'), issues);
  } catch (e) {
    await rm(root, { recursive: true, force: true });
    throw e;
  }
  return { root, dispose: () => rm(root, { recursive: true, force: true }) };
}

/** The policy of the project opened last (the one the person is looking at). */
export class ProjectPolicy {
  private active: string | null = null;
  constructor(private readonly registry: ProjectRegistry) {}

  opened(projectId: string): void {
    this.active = projectId;
  }

  header(): PackageHeader | undefined {
    return this.active === null ? undefined : this.registry.package(this.active)?.header;
  }

  cloudAllowed(setting: boolean): boolean {
    return cloudAllowedFor(setting, this.header());
  }

  checkExport(name: string): string | null {
    return checkExport(this.header(), name);
  }
}

/** The `.aio` path among process arguments (a double-click passes it last). */
export function packagePathFromArgv(argv: readonly string[]): string | null {
  for (let i = argv.length - 1; i >= 1; i--) {
    const a = argv[i];
    // A `<scheme>://open?path=...aio` link is not a path (appLink.ts reads it).
    if (a === undefined || a.startsWith('-') || a.includes('://')) continue;
    if (a.toLowerCase().endsWith(PACKAGE_EXTENSION)) return a;
  }
  return null;
}

/** File scans kept for a short while, so toggling layers in the export dialog stays quick. */
export function createPlanCache(ttlMs = 60_000) {
  const scans = new Map<string, { at: number; files: Promise<SourceFile[]> }>();
  const files = (root: string): Promise<SourceFile[]> => {
    const hit = scans.get(root);
    if (hit && Date.now() - hit.at < ttlMs) return hit.files;
    const p = scanProject(root);
    scans.set(root, { at: Date.now(), files: p });
    p.catch(() => scans.delete(root));
    return p;
  };
  return {
    files,
    async plan(
      root: string,
      manifest: ProjectManifest,
      exclude: readonly string[],
    ): Promise<PackagePlanResult> {
      return planPackage(manifest, await files(root), exclude);
    },
    forget(root: string): void {
      scans.delete(root);
    },
  };
}

export interface PackageJobDeps {
  registry: ProjectRegistry;
  cache: ReturnType<typeof createPlanCache>;
  /** Ask where to save; null when the person cancels. */
  chooseTarget: (defaultName: string) => Promise<string | null>;
  progress: (event: IpcEvent<'package:progress'>) => void;
  createdBy: string;
  /** Installed map packs and their folder, for map regions inside packages. */
  packs?: { dir: () => string; list: () => Promise<MapPackInfo[]> };
  /** Where an embedded map region is clipped before it is packaged. */
  tempDir?: () => string;
  /** Data root that extracted projects go to (extract to edit). */
  dataRoot?: () => string;
  /** OS account, recorded in an extracted project's origin note. */
  user?: string;
}

const notFolder = (projectId: string) =>
  `Project "${projectId}" is not an open project folder. Open the project folder (not a package) to export a package.`;

/** `package:plan`, `package:export`, `package:extract` and `package:cancel`. */
export function createPackageJobs(deps: PackageJobDeps) {
  const jobs = new Map<string, AbortController>();

  async function embedPlan(manifest: ProjectManifest, request: PackageMapPackRequest) {
    if (!deps.packs) {
      return { ok: false as const, reason: 'Map packs are not available in this build.' };
    }
    return planEmbed({
      manifest,
      request,
      packs: await deps.packs.list(),
      packsDir: deps.packs.dir(),
    });
  }

  async function manifestOf(projectId: string) {
    const root = deps.registry.root(projectId);
    if (root === undefined) return { ok: false as const, error: notFolder(projectId) };
    const m = await readManifest(root);
    if (!m.ok) return m;
    return { ok: true as const, root, manifest: m.value };
  }

  return {
    async plan({
      projectId,
      exclude,
      mapPack,
    }: IpcRequest<'package:plan'>): Promise<IpcResponse<'package:plan'>> {
      const m = await manifestOf(projectId);
      if (!m.ok) return m;
      try {
        const p = await deps.cache.plan(m.root, m.manifest, exclude);
        const free = await volumeFreeBytes(m.root);
        const region = mapPack ? embedSummary(await embedPlan(m.manifest, mapPack)) : undefined;
        const extra = region?.ok ? region.bytes + 1024 : 0;
        return {
          ok: true,
          plan: {
            layers: p.layers,
            baseBytes: p.baseBytes,
            totalBytes: p.totalBytes + extra,
            totalFiles: p.totalFiles + 2 + (region?.ok ? 2 : 0),
            ...(free !== undefined ? { freeBytes: Math.floor(free) } : {}),
            ...(region ? { mapPack: region } : {}),
          },
        };
      } catch (e) {
        return { ok: false, error: `Could not read ${m.root}: ${String(e)}` };
      }
    },

    async export({
      jobId,
      options,
    }: IpcRequest<'package:export'>): Promise<IpcResponse<'package:export'>> {
      const m = await manifestOf(options.projectId);
      if (!m.ok) return m;
      if (jobs.has(jobId)) return { ok: false, error: 'This export is already running.' };
      const chosen = await deps.chooseTarget(`${m.manifest.id}${PACKAGE_EXTENSION}`);
      if (chosen === null) return { ok: true, path: null };
      const out =
        extname(chosen).toLowerCase() === PACKAGE_EXTENSION
          ? chosen
          : `${chosen}${PACKAGE_EXTENSION}`;
      const ac = new AbortController();
      jobs.set(jobId, ac);
      let embed: Awaited<ReturnType<typeof writeEmbed>> | null = null;
      try {
        deps.cache.forget(m.root);
        if (options.mapPack) {
          const planned = await embedPlan(m.manifest, options.mapPack);
          if (!planned.ok) throw new Error(planned.reason);
          embed = await writeEmbed(planned.value, {
            tempDir: deps.tempDir?.() ?? tmpdir(),
            projectName: m.manifest.name,
            signal: ac.signal,
          });
        }
        const r = await exportPackage({
          root: m.root,
          out,
          manifest: m.manifest,
          exclude: options.exclude,
          header: {
            readOnly: options.readOnly,
            aiPolicy: options.aiPolicy,
            ...(options.editPolicy ? { editPolicy: options.editPolicy } : {}),
            exports: options.exports,
            ...(options.welcome ? { welcome: options.welcome } : {}),
          },
          ...(options.passphrase !== undefined ? { passphrase: options.passphrase } : {}),
          createdBy: deps.createdBy,
          signal: ac.signal,
          onProgress: (p) => {
            deps.progress({ jobId, ...p });
          },
          ...(embed ? { extra: embed.members } : {}),
        });
        return { ok: true, path: out, bytes: r.bytes };
      } catch (e) {
        if (e instanceof Error && e.name === 'AbortError') return { ok: true, path: null };
        const why = e instanceof Error ? e.message : String(e);
        return {
          ok: false,
          error: `${basename(out)} was not written to ${dirname(out)}: ${why}`,
        };
      } finally {
        jobs.delete(jobId);
        await embed?.dispose().catch(() => undefined);
      }
    },

    /** Extract to edit: an open package into a new project folder in the data root. */
    async extract({
      jobId,
      projectId,
    }: IpcRequest<'package:extract'>): Promise<IpcResponse<'package:extract'>> {
      const pkg = deps.registry.package(projectId);
      if (!pkg) {
        return { ok: false, error: 'Open the package first, then extract it to edit.' };
      }
      const refusal = extractRefusal(pkg.header, pkg.file);
      if (refusal) return { ok: false, error: refusal };
      if (!deps.dataRoot) return { ok: false, error: 'No data folder is set.' };
      if (jobs.has(jobId)) return { ok: false, error: 'This extract is already running.' };
      const ac = new AbortController();
      jobs.set(jobId, ac);
      try {
        const r = await extractProject({
          archive: pkg.archive,
          header: pkg.header,
          manifest: pkg.manifest,
          file: pkg.file,
          dataRoot: deps.dataRoot(),
          ...(deps.user ? { extractedBy: deps.user } : {}),
          signal: ac.signal,
          onProgress: (p) => {
            deps.progress({ jobId, ...p });
          },
        });
        return { ok: true, root: r.root };
      } catch (e) {
        if (e instanceof Error && e.name === 'AbortError') return { ok: true, root: null };
        return {
          ok: false,
          error: `${basename(pkg.file)} was not extracted: ${e instanceof Error ? e.message : String(e)}`,
        };
      } finally {
        jobs.delete(jobId);
      }
    },

    cancel({ jobId }: IpcRequest<'package:cancel'>): IpcResponse<'package:cancel'> {
      const ac = jobs.get(jobId);
      ac?.abort();
      return { ok: ac !== undefined };
    },
  };
}
