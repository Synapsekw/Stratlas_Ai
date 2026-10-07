/**
 * Per-project agent state kept on this workstation (userData/ai-projects.json), keyed by the
 * project folder: "Always allow" for the send preview (AI-6) and tokens and estimated cost per
 * provider (AI-7). Kept out of the project folder on purpose: consent is a person's choice on a
 * machine, and read-only customer packages still get a meter.
 */
import { addProviderUsage } from '@aio/ai/main';
import type { AiPolicy, ProjectUsage, ProviderUsage } from '@aio/schema';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { readJson, writeJsonAtomic } from './fsutil';
import { newerThanThisBuild } from './newer';

const Entry = z.object({
  name: z.string(),
  alwaysAllow: z.boolean(),
  usage: z.array(
    z.object({
      provider: z.string(),
      inputTokens: z.number(),
      outputTokens: z.number(),
      costUsd: z.number(),
      costKnown: z.boolean(),
    }),
  ),
  updatedAt: z.string(),
});
const File = z.object({
  schema: z.literal('aio.ai-projects/1'),
  projects: z.record(z.string(), Entry),
});
type Entry = z.infer<typeof Entry>;

/** The store key of a project folder: resolved, and case-folded on Windows. */
export function projectKey(root: string, platform = process.platform): string {
  const r = resolve(root);
  return platform === 'win32' ? r.toLowerCase() : r;
}

export interface UsageReport {
  provider: string;
  inputTokens: number;
  outputTokens: number;
  costUsd?: number;
}

export interface AiProjectStore {
  get(root: string): Promise<{ alwaysAllow: boolean; usage: ProviderUsage[] }>;
  setConsent(root: string, name: string, alwaysAllow: boolean): Promise<void>;
  addUsage(root: string, name: string, usage: UsageReport): void;
  list(): Promise<ProjectUsage[]>;
  /** Write pending usage now (on quit). */
  flush(): Promise<void>;
}

export function createAiProjectStore(
  file: string,
  opts: { now?: () => Date; writeDelayMs?: number } = {},
): AiProjectStore {
  const now = opts.now ?? (() => new Date());
  let cache: Record<string, Entry> | null = null;
  /** Set when the file was saved by a newer build: it is then never written (UPGRADE-POLICY). */
  let refused: string | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let writing: Promise<void> = Promise.resolve();

  async function load(): Promise<Record<string, Entry>> {
    if (cache) return cache;
    try {
      const raw = await readJson(file);
      refused = newerThanThisBuild(raw, 'aio.ai-projects', 'ai-projects.json');
      if (refused) console.warn(refused);
      const r = File.safeParse(raw);
      cache = r.success && !refused ? r.data.projects : {};
    } catch {
      cache = {};
    }
    return cache;
  }

  function write(): Promise<void> {
    if (refused) return writing;
    const projects = cache ?? {};
    writing = writing.then(() =>
      writeJsonAtomic(file, { schema: 'aio.ai-projects/1', projects }).catch((e: unknown) => {
        console.warn(`Could not save ${file}: ${e instanceof Error ? e.message : String(e)}`);
      }),
    );
    return writing;
  }

  function writeSoon(): void {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      void write();
    }, opts.writeDelayMs ?? 500);
  }

  const blank = (name: string): Entry => ({
    name,
    alwaysAllow: false,
    usage: [],
    updatedAt: now().toISOString(),
  });

  return {
    async get(root) {
      const e = (await load())[projectKey(root)];
      return { alwaysAllow: e?.alwaysAllow ?? false, usage: e?.usage ?? [] };
    },
    async setConsent(root, name, alwaysAllow) {
      const all = await load();
      if (refused) throw new Error(refused);
      const key = projectKey(root);
      all[key] = {
        ...(all[key] ?? blank(name)),
        name,
        alwaysAllow,
        updatedAt: now().toISOString(),
      };
      await write();
    },
    addUsage(root, name, usage) {
      void load().then((all) => {
        if (refused) return;
        const key = projectKey(root);
        const prev = all[key] ?? blank(name);
        all[key] = {
          ...prev,
          name,
          usage: addProviderUsage(prev.usage, usage),
          updatedAt: now().toISOString(),
        };
        writeSoon();
      });
    },
    async list() {
      const all = await load();
      return Object.entries(all)
        .filter(([, e]) => e.usage.length > 0)
        .map(([key, e]) => ({ key, name: e.name, updatedAt: e.updatedAt, providers: e.usage }))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    },
    async flush() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
        await write();
      }
      await writing;
    },
  };
}

/**
 * The project's AI policy from its raw manifest. A customer package may carry `aiPolicy: 'forbid'`
 * (stream N4); the frozen manifest schema strips unknown keys, so read the file itself and accept
 * the field at the top level or under `package`. Only an explicit `forbid` blocks cloud providers.
 */
export async function readAiPolicy(root: string): Promise<AiPolicy> {
  let raw: unknown;
  try {
    const text = await readFile(join(root, 'manifest.json'), 'utf8');
    raw = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text) as unknown;
  } catch {
    return 'allow';
  }
  if (typeof raw !== 'object' || raw === null) return 'allow';
  const m = raw as { aiPolicy?: unknown; package?: { aiPolicy?: unknown } };
  const value = m.aiPolicy ?? m.package?.aiPolicy;
  return value === 'forbid' ? 'forbid' : 'allow';
}
