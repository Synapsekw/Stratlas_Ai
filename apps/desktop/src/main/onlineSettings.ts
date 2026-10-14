import { brand } from '@aio/brand';
import {
  defaultOnlineSettings,
  newerRefusal,
  ONLINE_SETTINGS_FILE,
  OnlineSettings,
  onlineState,
  type IpcRequest,
  type IpcResponse,
  type OnlineState,
} from '@aio/schema';
import { join } from 'node:path';
import { readJson, writeJsonAtomic } from './fsutil';

/**
 * Whether the person switched online maps on, and which online satellite this workstation uses
 * (ADR 0007, amendments of 10 and 14 Oct 2026), in userData `online.json`
 * (`aio.online-settings/1`), beside settings.json and not in it. A missing or unreadable file is
 * off; a file from a newer build is read as off and never overwritten.
 *
 * The tile gate (`onlineTiles.ts`) asks `current()` for every tile, so it answers at once:
 * - off until the file has been read;
 * - switching **off** counts from the moment it is asked for, before the file is written;
 * - switching **on** counts once the file is written, so a switch that could not be saved never
 *   lets a request out.
 * The source is written with every change: a file that says on without a source reads as
 * Sentinel-2 (what 0.11 streamed), which must only happen for files 0.11 wrote.
 */
export function onlineSettingsPath(userData: string): string {
  return join(userData, ONLINE_SETTINGS_FILE);
}

export function createOnlineSettingsStore(file: string) {
  let state: OnlineState = onlineState({});
  let loaded: Promise<void> | null = null;
  /** The newest change asked for; an older one still being written does not undo it. */
  let asked = 0;

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

  function load(): Promise<void> {
    loaded ??= serial(async () => {
      const { settings } = await read();
      // a change made while the file was being read wins over what the file said
      if (asked === 0) state = onlineState(settings);
    });
    return loaded;
  }

  return {
    load,
    /** For the tile gate: the switch and the source, right now. */
    current: (): OnlineState => state,
    /** The state once every change asked for so far is written. */
    async get(): Promise<OnlineState> {
      await load();
      await queue;
      return state;
    },
    set(patch: IpcRequest<'onlineTiles:set'>): Promise<IpcResponse<'onlineTiles:set'>> {
      asked += 1;
      const mine = asked;
      // off at once: nothing more is requested from this moment
      if (patch.enabled === false) state = { ...state, enabled: false };
      void load();
      return serial(async () => {
        let next: OnlineState;
        try {
          const { settings, newer } = await read();
          if (newer) return { ok: false, error: newer };
          const was = onlineState(settings);
          next = { enabled: patch.enabled ?? was.enabled, source: patch.source ?? was.source };
          await writeJsonAtomic(
            file,
            OnlineSettings.parse({ ...settings, satellite: next.enabled, source: next.source }),
          );
        } catch (e) {
          return {
            ok: false,
            error: `The online maps setting was not saved: ${e instanceof Error ? e.message : String(e)}`,
          };
        }
        if (mine === asked) state = next;
        return { ok: true, enabled: next.enabled, source: next.source };
      });
    },
  };
}

export type OnlineSettingsStore = ReturnType<typeof createOnlineSettingsStore>;
