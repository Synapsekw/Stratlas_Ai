import { brand } from '@aio/brand';
import {
  defaultOnlineSettings,
  newerRefusal,
  ONLINE_SETTINGS_FILE,
  onlineSatelliteOn,
  OnlineSettings,
  type IpcResponse,
} from '@aio/schema';
import { join } from 'node:path';
import { readJson, writeJsonAtomic } from './fsutil';

/**
 * Whether the person switched online satellite on (ADR 0007, amendment of 10 Oct 2026), in
 * userData `online.json` (`aio.online-settings/1`), beside settings.json and not in it: older
 * builds read settings.json with their own schema, so it keeps exactly the keys they know (as
 * `launch.json` and `globe.json` do). A missing or unreadable file is off; a file from a newer
 * build is read as off and never overwritten.
 *
 * The tile gate (`onlineTiles.ts`) asks `satellite()` for every tile, so it must answer at once:
 * - off until the file has been read;
 * - switching **off** counts from the moment it is asked for, before the file is written;
 * - switching **on** counts once the file is written, so a switch that could not be saved never
 *   lets a request out.
 */
export function onlineSettingsPath(userData: string): string {
  return join(userData, ONLINE_SETTINGS_FILE);
}

export function createOnlineSettingsStore(file: string) {
  let on = false;
  let loaded: Promise<void> | null = null;
  /** The newest change asked for; an older one still being written does not undo it. */
  let asked = 0;

  // One change at a time: two quick switches must not interleave their writes.
  let queue: Promise<unknown> = Promise.resolve();
  function serial<T>(run: () => Promise<T>): Promise<T> {
    const next = queue.then(run, run);
    queue = next.catch(() => undefined);
    return next;
  }

  async function read(): Promise<{ settings: OnlineSettings; newer: string | null }> {
    let raw: unknown;
    try {
      raw = await readJson(file);
    } catch {
      return { settings: defaultOnlineSettings(), newer: null };
    }
    if (raw === undefined) return { settings: defaultOnlineSettings(), newer: null };
    const newer = newerRefusal(raw, brand.productName);
    if (newer) return { settings: defaultOnlineSettings(), newer };
    const parsed = OnlineSettings.safeParse(raw);
    return { settings: parsed.success ? parsed.data : defaultOnlineSettings(), newer: null };
  }

  /** Read the file once (at start); until then the answer is off. */
  function load(): Promise<void> {
    loaded ??= serial(async () => {
      const { settings } = await read();
      // a switch made while the file was being read wins over what the file said
      if (asked === 0) on = onlineSatelliteOn(settings);
    });
    return loaded;
  }

  return {
    load,
    /** For the tile gate: whether online satellite is switched on, right now. */
    satellite: (): boolean => on,
    /** The switch once every change asked for so far is written. */
    async get(): Promise<boolean> {
      await load();
      await queue;
      return on;
    },
    set(next: boolean): Promise<IpcResponse<'onlineTiles:setSatellite'>> {
      asked += 1;
      const mine = asked;
      // off at once: nothing more is requested from this moment
      if (!next) on = false;
      void load();
      return serial(async () => {
        try {
          const { settings, newer } = await read();
          if (newer) return { ok: false, error: newer };
          await writeJsonAtomic(file, OnlineSettings.parse({ ...settings, satellite: next }));
        } catch (e) {
          return {
            ok: false,
            error: `The online satellite setting was not saved: ${e instanceof Error ? e.message : String(e)}`,
          };
        }
        if (mine === asked) on = next;
        return { ok: true, satellite: next };
      });
    },
  };
}

export type OnlineSettingsStore = ReturnType<typeof createOnlineSettingsStore>;
