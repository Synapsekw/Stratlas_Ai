/**
 * The real HCl and Al-Zour projects for agent end-to-end tests, without touching them: each test
 * gets a temporary data root with a copy of the project (manifest, issues, models, rasters,
 * flights, photos, panoramas, posters and the smaller point clouds; not the video files, not
 * clouds of 150 MB or more). Everything the app writes (agent conversations, issues) lands in the
 * copy; the real project is only read. Links would not do: the app refuses files whose real path
 * leaves the project folder. Skipped on machines without the projects (E:\Stratlas Data, or
 * STRATLAS_PROJECTS_DATA).
 */
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, relative, sep } from 'node:path';
import type { DataRoot } from './fixtures';

export const REAL_DATA = process.env.STRATLAS_PROJECTS_DATA ?? 'E:\\Stratlas Data';

const SKIPPED_DIRS = new Set(['video', 'ai']);
const MAX_FILE = 150 * 1024 * 1024;

export function realProject(id: string): string {
  return join(REAL_DATA, 'projects', id);
}

export function hasRealProject(id: string): boolean {
  return existsSync(join(realProject(id), 'manifest.json'));
}

export interface ProjectCopy extends DataRoot {
  /** Remove the temporary folder. */
  dispose(): Promise<void>;
}

/**
 * A temporary data root holding a copy of `projects/<id>` (see above) and of the named map packs
 * (`packs/<pack>.pmtiles` and `.json`) when the machine has them.
 */
export async function copiedDataRoot(id: string, packs: string[] = []): Promise<ProjectCopy> {
  const src = realProject(id);
  const base = await mkdtemp(join(tmpdir(), `aio-agent-${id}-`));
  const root = join(base, 'data');
  const userData = join(base, 'user');
  const projectDir = join(root, 'projects', id);
  await mkdir(userData, { recursive: true });
  await mkdir(join(root, 'packs'), { recursive: true });
  for (const pack of packs) {
    for (const ext of ['.pmtiles', '.json']) {
      const from = join(REAL_DATA, 'packs', pack + ext);
      if (existsSync(from)) await cp(from, join(root, 'packs', pack + ext));
    }
  }
  await cp(src, projectDir, {
    recursive: true,
    filter: async (from) => {
      const rel = relative(src, from);
      if (!rel) return true;
      const top = rel.split(sep)[0] ?? '';
      if (SKIPPED_DIRS.has(top) || top.includes('.before') || basename(from).endsWith('.bak'))
        return false;
      const s = await stat(from);
      return s.isDirectory() || s.size < MAX_FILE;
    },
  });
  return {
    base,
    root,
    userData,
    projectId: id,
    projectDir,
    dispose: () => rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }),
  };
}
