import { defaultRoutes } from '@aio/ai/routes';
import { ReportSectionId, Settings, type IpcRequest } from '@aio/schema';
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
  const fromEnv = o.env.QUADRION_DATA;
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
    direction: 'ltr',
    offlineOnly: false,
    updateCheck: false,
    updateUrl: '',
  };
}

/**
 * House report sections an 0.8 build knows. 0.8 reads `reportContents` with a strict schema over
 * these ids only, so one later id (`audit`, `approvals`) would make it drop every report choice.
 * Later sections are kept in `reportSectionsExtra` on disk instead, which 0.8 ignores
 * (`docs/release/UPGRADE-POLICY.md`, settings).
 */
export const REPORT_SECTIONS_08 = [
  'contents',
  'summary',
  'scope',
  'site',
  'statistics',
  'register',
  'issues',
  'appendices',
] as const;

/** On-disk key for report sections an 0.8 build does not know (not part of `Settings`). */
const EXTRA = 'reportSectionsExtra';

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const known08 = (id: string) => (REPORT_SECTIONS_08 as readonly string[]).includes(id);

/** On/off values of `reportSectionsExtra`; anything else is dropped. */
function extraSections(raw: unknown): Record<string, boolean> {
  if (!isRecord(raw)) return {};
  return Object.fromEntries(
    Object.entries(raw).filter((e): e is [string, boolean] => typeof e[1] === 'boolean'),
  );
}

/** Fold `reportSectionsExtra` back into `reportContents.sections` (sections this build knows). */
function fromDisk(stored: Record<string, unknown>): Record<string, unknown> {
  const extra = extraSections(stored[EXTRA]);
  const ours = Object.entries(extra).filter(([id]) => ReportSectionId.safeParse(id).success);
  if (ours.length === 0) return stored;
  const contents = isRecord(stored.reportContents) ? stored.reportContents : {};
  const sections = isRecord(contents.sections) ? contents.sections : {};
  return {
    ...stored,
    reportContents: { ...contents, sections: { ...Object.fromEntries(ours), ...sections } },
  };
}

/**
 * The file to write: sections 0.8 does not know move from `reportContents` to
 * `reportSectionsExtra`, together with any a newer build left there that this one does not know.
 */
function toDisk(settings: Settings, keep: Record<string, boolean>): Record<string, unknown> {
  const { reportContents, ...rest } = settings;
  const out: Record<string, unknown> = { ...rest };
  const extra: Record<string, boolean> = Object.fromEntries(
    Object.entries(keep).filter(([id]) => !ReportSectionId.safeParse(id).success),
  );
  if (reportContents) {
    const { sections, ...contents } = reportContents;
    const old = Object.entries(sections ?? {}).filter(([id]) => known08(id));
    for (const [id, on] of Object.entries(sections ?? {})) if (!known08(id)) extra[id] = on;
    out.reportContents =
      old.length > 0 ? { ...contents, sections: Object.fromEntries(old) } : contents;
  }
  if (Object.keys(extra).length > 0) out[EXTRA] = extra;
  return out;
}

/** Keep every stored field that is still valid; anything else falls back to its default. */
function merge(defaults: Settings, raw: unknown): Settings {
  if (typeof raw !== 'object' || raw === null) return defaults;
  const stored = fromDisk(raw as Record<string, unknown>);
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
  /**
   * Read-modify-write: `change` sees the settings after every earlier update has been written,
   * so concurrent callers (a typed field and a logo pick) never drop each other's change.
   */
  update(change: (current: Settings) => IpcRequest<'settings:set'>): Promise<Settings>;
  /** Last known settings, for synchronous callers such as the AI runtime. */
  current(): Settings;
  /**
   * Resolves once every update asked for so far is written, so `current()` then reflects them:
   * a check made right after a change (the agent's route after cloud AI is turned on) sees it.
   */
  settled(): Promise<void>;
}

/** Settings as JSON in `file` (userData/settings.json), validated against the frozen schema. */
export function createSettingsStore(file: string, defaults: Settings): SettingsStore {
  let cache: Settings | undefined;
  /** `reportSectionsExtra` as read, so sections of a newer build survive this one's saves. */
  let keep: Record<string, boolean> = {};

  async function load(): Promise<Settings> {
    if (cache) return cache;
    let raw: unknown;
    try {
      raw = await readJson(file);
    } catch (e) {
      console.warn(`Settings file ${file} is unreadable, using defaults: ${String(e)}`);
      raw = undefined;
    }
    keep = isRecord(raw) ? extraSections(raw[EXTRA]) : {};
    cache = merge(defaults, raw);
    return cache;
  }

  async function apply(patch: IpcRequest<'settings:set'>): Promise<Settings> {
    const given = Object.entries(patch).filter(([, v]) => v !== undefined);
    const next = Settings.parse({ ...(await load()), ...Object.fromEntries(given) });
    await writeJsonAtomic(file, toDisk(next, keep));
    cache = next;
    return next;
  }

  // Updates run one at a time: each reads what the previous one wrote.
  let queue: Promise<unknown> = Promise.resolve();
  function serial(job: () => Promise<Settings>): Promise<Settings> {
    const run = queue.then(job, job);
    queue = run.catch(() => undefined);
    return run;
  }

  return {
    get: load,
    set: (patch) => serial(() => apply(patch)),
    update: (change) => serial(async () => apply(change(await load()))),
    current: () => cache ?? defaults,
    settled: () => queue.then(() => undefined),
  };
}
