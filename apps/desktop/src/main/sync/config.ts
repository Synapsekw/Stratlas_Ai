import { randomId } from '@aio/journal';
import { TEAM_CONFIG_SCHEMA, TeamConfigFile, type ProjectTeamConfig } from '@aio/schema';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { readJson, writeJsonAtomic } from '../fsutil';

/** The library key of a project folder (case-insensitive on Windows, like `ProjectRegistry`). */
export function rootKey(root: string): string {
  const r = resolve(root);
  return process.platform === 'win32' ? r.toLowerCase() : r;
}

export type TeamConfigPatch = {
  [K in Exclude<keyof ProjectTeamConfig, 'root' | 'replicaId'>]?: ProjectTeamConfig[K] | undefined;
};

/**
 * userData `team/projects.json` (`aio.team-config/1`): per project folder, this machine's sharing
 * setup. A folder gets its replica id the first time it is asked for, so a copied or moved folder
 * starts a new chain (data-conventions section 17). Writes are serialised.
 */
export interface TeamConfigStore {
  /** The entry of a folder, made (mode `off`, a new replica) when absent. */
  get(root: string): Promise<ProjectTeamConfig>;
  /** Change fields; `undefined` removes one (leaving a hub clears its path). */
  update(root: string, patch: TeamConfigPatch): Promise<ProjectTeamConfig>;
  /** Folders currently synced through a hub. */
  all(): Promise<ProjectTeamConfig[]>;
}

export function createTeamConfigStore(file: string): TeamConfigStore {
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = queue.then(fn, fn);
    queue = run.catch(() => undefined);
    return run;
  };

  async function load(): Promise<ProjectTeamConfig[]> {
    let raw: unknown;
    try {
      raw = await readJson(file);
    } catch {
      return [];
    }
    if (raw === undefined) return [];
    const parsed = TeamConfigFile.safeParse(raw);
    return parsed.success ? parsed.data.projects : [];
  }

  async function save(projects: ProjectTeamConfig[]): Promise<void> {
    await mkdir(dirname(file), { recursive: true });
    await writeJsonAtomic(file, { schema: TEAM_CONFIG_SCHEMA, projects }, { backup: true });
  }

  const find = (list: ProjectTeamConfig[], root: string) =>
    list.find((p) => rootKey(p.root) === rootKey(root));

  async function getOrMake(
    root: string,
  ): Promise<{ list: ProjectTeamConfig[]; entry: ProjectTeamConfig; made: boolean }> {
    const list = await load();
    const known = find(list, root);
    if (known) return { list, entry: known, made: false };
    const entry: ProjectTeamConfig = {
      root: resolve(root),
      replicaId: randomId('r_', 16),
      mode: 'off',
      fetch: {},
      peers: {},
      journal: 'on',
    };
    list.push(entry);
    return { list, entry, made: true };
  }

  return {
    get: (root) =>
      serial(async () => {
        const { list, entry, made } = await getOrMake(root);
        if (made) await save(list);
        return entry;
      }),
    update: (root, patch) =>
      serial(async () => {
        const { list, entry } = await getOrMake(root);
        const next = Object.fromEntries(
          Object.entries({ ...entry, ...patch }).filter(([, v]) => v !== undefined),
        ) as ProjectTeamConfig;
        list[list.indexOf(entry)] = next;
        await save(list);
        return next;
      }),
    all: () => serial(load),
  };
}
