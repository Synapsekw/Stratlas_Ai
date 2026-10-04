import {
  exportPackage,
  planPackage,
  scanProject,
  volumeFreeBytes,
  type PackagePlanResult,
  type SourceFile,
} from '@aio/project/package';
import {
  exportKindForFile,
  PACKAGE_EXTENSION,
  type IpcEvent,
  type IpcRequest,
  type IpcResponse,
  type PackageHeader,
  type ProjectManifest,
} from '@aio/schema';
import { basename, dirname, extname } from 'node:path';
import { readManifest, type ProjectRegistry } from './project';

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
    if (a === undefined || a.startsWith('-')) continue;
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
}

const notFolder = (projectId: string) =>
  `Project "${projectId}" is not an open project folder. Open the project folder (not a package) to export a package.`;

/** `package:plan`, `package:export` and `package:cancel`. */
export function createPackageJobs(deps: PackageJobDeps) {
  const jobs = new Map<string, AbortController>();

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
    }: IpcRequest<'package:plan'>): Promise<IpcResponse<'package:plan'>> {
      const m = await manifestOf(projectId);
      if (!m.ok) return m;
      try {
        const p = await deps.cache.plan(m.root, m.manifest, exclude);
        const free = await volumeFreeBytes(m.root);
        return {
          ok: true,
          plan: {
            layers: p.layers,
            baseBytes: p.baseBytes,
            totalBytes: p.totalBytes,
            totalFiles: p.totalFiles + 2,
            ...(free !== undefined ? { freeBytes: Math.floor(free) } : {}),
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
      try {
        deps.cache.forget(m.root);
        const r = await exportPackage({
          root: m.root,
          out,
          manifest: m.manifest,
          exclude: options.exclude,
          header: {
            readOnly: options.readOnly,
            aiPolicy: options.aiPolicy,
            exports: options.exports,
            ...(options.welcome ? { welcome: options.welcome } : {}),
          },
          ...(options.passphrase !== undefined ? { passphrase: options.passphrase } : {}),
          createdBy: deps.createdBy,
          signal: ac.signal,
          onProgress: (p) => {
            deps.progress({ jobId, ...p });
          },
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
      }
    },

    cancel({ jobId }: IpcRequest<'package:cancel'>): IpcResponse<'package:cancel'> {
      const ac = jobs.get(jobId);
      ac?.abort();
      return { ok: ac !== undefined };
    },
  };
}
