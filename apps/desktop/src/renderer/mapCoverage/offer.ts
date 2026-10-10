/**
 * When street maps for a project may be offered or fetched, and the one way they are fetched.
 * Downloading a map extract tells the map host which area was asked for, so it is always an
 * informed action: a Download click on a list that names the areas and their size, or the
 * opt-in "download automatically" preference. An offline-only workstation downloads nothing.
 * Pure: the IPC call comes in as a function.
 */
import type { PackRegion } from '@aio/schema';
import { toPackRegion, type PlannedRegion } from './plan';

/** `GlobeSettings.projectMaps` with its defaults filled in. */
export interface ProjectMapPrefs {
  /** Say so when an opened project has no detailed street map. Default on. */
  offer: boolean;
  /** Download a newly opened project's missing maps without asking. Default off. */
  auto: boolean;
}

export const DEFAULT_PREFS: ProjectMapPrefs = { offer: true, auto: false };

export function prefsOf(
  stored: { offer?: boolean | undefined; auto?: boolean | undefined } | undefined,
): ProjectMapPrefs {
  return { offer: stored?.offer ?? DEFAULT_PREFS.offer, auto: stored?.auto ?? DEFAULT_PREFS.auto };
}

/**
 * What to do when a project opens:
 * - `none`: nothing to say (covered, not placed, a bundled demo, already answered, offers off),
 *   and always on an offline-only workstation: it downloads nothing, and Settings, Offline maps
 *   says what is missing and how to bring a pack in as a file;
 * - `prompt`: a small notice that names the areas and the size, with Download;
 * - `auto`: queue the plan without asking (the opt-in preference, online only).
 */
export type OfferAction = 'none' | 'prompt' | 'auto';

export interface OfferInput {
  /** The project is placed on the Earth. */
  located: boolean;
  /** An installed pack covers the site in detail. */
  covered: boolean;
  /** A demo project that ships with the app (synthetic place): never offered. */
  demo: boolean;
  /** This project was already offered or fetched on this workstation. */
  handled: boolean;
  offlineOnly: boolean;
  prefs: ProjectMapPrefs;
  /** Regions of the plan that a download would start. */
  regions: number;
}

export function offerFor(i: OfferInput): OfferAction {
  if (!i.located || i.covered || i.demo || i.handled || i.regions === 0) return 'none';
  if (i.offlineOnly) return 'none';
  if (i.prefs.auto) return 'auto';
  return i.prefs.offer ? 'prompt' : 'none';
}

export interface QueueResult {
  /** Ids of the regions whose download started. */
  started: string[];
  /** Regions that did not start, with main's sentence. */
  failed: { id: string; label: string; error: string }[];
}

/** `packs:download` as the renderer calls it: main checks every region again. */
export type StartDownload = (
  region: PackRegion,
) => Promise<{ ok: boolean; error?: string | undefined }>;

/**
 * Start the download of each region through the pack manager, one after the other, so they show
 * in Downloads with the same resume and verification as a region added by hand. Nothing is asked
 * of main on an offline-only workstation.
 */
export async function queueRegions(
  regions: readonly PlannedRegion[],
  start: StartDownload,
  offlineOnly: boolean,
): Promise<QueueResult> {
  const result: QueueResult = { started: [], failed: [] };
  if (offlineOnly) return result;
  for (const region of regions) {
    if (region.busy) continue;
    let answer: { ok: boolean; error?: string | undefined };
    try {
      answer = await start(toPackRegion(region));
    } catch (e) {
      answer = { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
    if (answer.ok) result.started.push(region.id);
    else result.failed.push({ id: region.id, label: region.label, error: answer.error ?? '' });
  }
  return result;
}

/** Projects already offered or fetched on this workstation (renderer storage). */
const HANDLED_KEY = 'quadrion.projectMaps.handled';

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export function handledProjects(store: Pick<Storage, 'getItem'> | null = storage()): string[] {
  try {
    const v = JSON.parse(store?.getItem(HANDLED_KEY) ?? '[]') as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/** Remember that a project was offered its street maps, so the notice does not come back. */
export function markHandled(
  projectId: string,
  store: Pick<Storage, 'getItem' | 'setItem'> | null = storage(),
): void {
  const ids = handledProjects(store);
  if (ids.includes(projectId)) return;
  try {
    store?.setItem(HANDLED_KEY, JSON.stringify([...ids, projectId].slice(-500)));
  } catch {
    // blocked storage: the answer lasts for this session
  }
}
