import { defaultRoutes } from '@aio/ai';
import { Settings, type IpcRequest } from '@aio/schema';
import { join } from 'node:path';
import { readJson, writeJsonAtomic } from './fsutil';

const DEV_DATA_ROOT = 'E:\\Stratlas Data';

/** Where projects and map packs live unless the person picks another folder in Settings. */
export function defaultDataRoot(o: {
  env: Record<string, string | undefined>;
  platform: string;
  documents: string;
  exists: (p: string) => boolean;
}): string {
  const fromEnv = o.env.STRATLAS_DATA;
  if (fromEnv) return fromEnv;
  if (o.platform === 'win32' && o.exists(DEV_DATA_ROOT)) return DEV_DATA_ROOT;
  return join(o.documents, 'Stratlas Data');
}

export function defaultSettings(dataRoot: string): Settings {
  return {
    cloudAi: false,
    theme: 'dark',
    sidebarCollapsed: false,
    dataRoot,
    routes: defaultRoutes(),
  };
}

/** Keep every stored field that is still valid; anything else falls back to its default. */
function merge(defaults: Settings, raw: unknown): Settings {
  if (typeof raw !== 'object' || raw === null) return defaults;
  const stored = raw as Record<string, unknown>;
  const out: Record<string, unknown> = { ...defaults };
  for (const [key, field] of Object.entries(Settings.shape)) {
    if (!(key in stored)) continue;
    const r = field.safeParse(stored[key]);
    if (r.success) out[key] = r.data;
  }
  return Settings.parse(out);
}

export interface SettingsStore {
  get(): Promise<Settings>;
  /** Merge a partial update (undefined fields are ignored), validate and persist it. */
  set(patch: IpcRequest<'settings:set'>): Promise<Settings>;
  /** Last known settings, for synchronous callers such as the AI runtime. */
  current(): Settings;
}

/** Settings as JSON in `file` (userData/settings.json), validated against the frozen schema. */
export function createSettingsStore(file: string, defaults: Settings): SettingsStore {
  let cache: Settings | undefined;

  async function load(): Promise<Settings> {
    if (cache) return cache;
    let raw: unknown;
    try {
      raw = await readJson(file);
    } catch (e) {
      console.warn(`Settings file ${file} is unreadable, using defaults: ${String(e)}`);
      raw = undefined;
    }
    cache = merge(defaults, raw);
    return cache;
  }

  return {
    get: load,
    async set(patch) {
      const given = Object.entries(patch).filter(([, v]) => v !== undefined);
      const next = Settings.parse({ ...(await load()), ...Object.fromEntries(given) });
      await writeJsonAtomic(file, next);
      cache = next;
      return next;
    },
    current: () => cache ?? defaults,
  };
}
