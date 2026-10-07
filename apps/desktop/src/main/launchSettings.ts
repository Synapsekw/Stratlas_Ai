import { brand } from '@aio/brand';
import {
  defaultLaunchSettings,
  LAUNCH_SETTINGS_FILE,
  LaunchSettings,
  newerRefusal,
  type IpcChannel,
  type IpcResponse,
} from '@aio/schema';
import { join } from 'node:path';
import { readJson, writeJsonAtomic } from './fsutil';
import type { Handler } from './ipc';

/**
 * The launch screen preference in userData `launch.json` (`aio.launch-settings/1`), beside
 * settings.json and not in it: a 0.9 build reads settings.json with a strict schema. A missing or
 * unreadable file is the defaults (shown); a file from a newer build is read as the defaults and
 * never overwritten.
 */
export function launchSettingsPath(userData: string): string {
  return join(userData, LAUNCH_SETTINGS_FILE);
}

export function createLaunchSettingsStore(file: string) {
  // One change at a time: two quick switches must not interleave their writes.
  let queue: Promise<unknown> = Promise.resolve();
  function serial<T>(run: () => Promise<T>): Promise<T> {
    const next = queue.then(run, run);
    queue = next.catch(() => undefined);
    return next;
  }

  async function read(): Promise<{ settings: LaunchSettings; newer: string | null }> {
    let raw: unknown;
    try {
      raw = await readJson(file);
    } catch {
      return { settings: defaultLaunchSettings(), newer: null };
    }
    if (raw === undefined) return { settings: defaultLaunchSettings(), newer: null };
    const newer = newerRefusal(raw, brand.productName);
    if (newer) return { settings: defaultLaunchSettings(), newer };
    const parsed = LaunchSettings.safeParse(raw);
    return { settings: parsed.success ? parsed.data : defaultLaunchSettings(), newer: null };
  }

  return {
    async get(): Promise<IpcResponse<'launch:get'>> {
      return { ok: true, settings: (await read()).settings };
    },
    set(show: boolean): Promise<IpcResponse<'launch:set'>> {
      return serial(async () => {
        const { settings, newer } = await read();
        if (newer) return { ok: false, error: newer };
        const next = LaunchSettings.parse({ ...settings, show });
        await writeJsonAtomic(file, next);
        return { ok: true, settings: next };
      });
    },
  };
}

export type LaunchSettingsStore = ReturnType<typeof createLaunchSettingsStore>;

type Handle = <C extends IpcChannel>(channel: C, handler: Handler<C>) => void;

export function registerLaunchSettingsIpc(handle: Handle, store: LaunchSettingsStore): void {
  handle('launch:get', () => store.get());
  handle('launch:set', async (req) => {
    try {
      return await store.set(req.show);
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });
}
