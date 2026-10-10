/**
 * Street maps for the library's projects, live: the projects and their places (`library:list`,
 * `globe:sites`), the installed packs and the downloads (`packs:list`, `packs:jobs`, the
 * `packs:job` event) and the two preferences (`GlobeSettings.projectMaps` in userData
 * `globe.json`). Everything it starts goes through `packs:download`, so main checks each region
 * and refuses on an offline-only workstation.
 *
 * Other screens show the same fact with `useProjectMapHint()`: how many projects have no
 * detailed street map, a sentence for it, and `open()` to bring up the panel in Settings,
 * Offline maps.
 */
import { defaultGlobeSettings, type MapPackInfo, type PackJob } from '@aio/schema';
import { t } from '@aio/ui';
import { useEffect, useMemo } from 'react';
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';
import { bridge, shell } from '../shell';
import {
  DEFAULT_PREFS,
  prefsOf,
  queueRegions,
  type ProjectMapPrefs,
  type QueueResult,
} from './offer';
import {
  coverageProjects,
  coverageReport,
  type CoverageProject,
  type CoverageReport,
  type PlannedRegion,
} from './plan';

interface MapCoverageState {
  /** The first answer is in. */
  loaded: boolean;
  error: string | null;
  /**
   * The library and the places of its projects were read. Without them nothing can be said about
   * any project: no plan, and no pack is called left over.
   */
  placesKnown: boolean;
  projects: CoverageProject[];
  packs: MapPackInfo[];
  jobs: PackJob[];
  prefs: ProjectMapPrefs;
  /** Read the projects, packs, downloads and preferences again. */
  refresh: () => Promise<void>;
  /** Save a preference; the error sentence when it was not saved. */
  setPrefs: (patch: Partial<ProjectMapPrefs>) => Promise<string | null>;
  /** Queue regions in the pack manager (Downloads shows them). */
  download: (regions: readonly PlannedRegion[]) => Promise<QueueResult>;
  /** Show the "Maps for your projects" panel: Settings, Offline maps. */
  openPanel: () => void;
}

let refreshing: Promise<void> | null = null;
/** Counts the refreshes asked for: one asked while a read is under way is read once more. */
let asked = 0;

export const mapCoverage = createStore<MapCoverageState>()((set, get) => ({
  loaded: false,
  error: null,
  placesKnown: false,
  projects: [],
  packs: [],
  jobs: [],
  prefs: DEFAULT_PREFS,

  refresh: () => {
    asked += 1;
    if (refreshing) return refreshing;
    const read = async () => {
      const [library, sites, packs, jobs, globe] = await Promise.all([
        bridge.call('library:list', {}),
        bridge.call('globe:sites', {}),
        bridge.call('packs:list', {}),
        bridge.call('packs:jobs', {}),
        bridge.call('globe:getSettings', {}),
      ]);
      const placed = sites.ok && sites.value.ok ? sites.value.sites : null;
      const error = !library.ok
        ? library.error
        : !sites.ok
          ? sites.error
          : !sites.value.ok
            ? sites.value.error
            : !packs.ok
              ? packs.error
              : null;
      set({
        loaded: true,
        error,
        placesKnown: library.ok && placed !== null,
        projects: library.ok && placed ? coverageProjects(library.value, placed) : [],
        packs: packs.ok ? packs.value : get().packs,
        jobs: jobs.ok ? jobs.value : get().jobs,
        prefs: globe.ok && globe.value.ok ? prefsOf(globe.value.settings.projectMaps) : get().prefs,
      });
    };
    refreshing = (async () => {
      for (;;) {
        const seen = asked;
        await read();
        // nothing was asked meanwhile: what was read is current
        if (asked === seen) break;
      }
    })().finally(() => {
      refreshing = null;
    });
    return refreshing;
  },

  setPrefs: async (patch) => {
    const before = get().prefs;
    const next = { ...before, ...patch };
    set({ prefs: next });
    const cur = await bridge.call('globe:getSettings', {});
    const settings = cur.ok && cur.value.ok ? cur.value.settings : defaultGlobeSettings();
    const r = await bridge.call('globe:setSettings', {
      settings: { ...settings, projectMaps: { ...settings.projectMaps, ...next } },
    });
    const error = !r.ok ? r.error : !r.value.ok ? r.value.error : null;
    if (error) set({ prefs: before });
    return error;
  },

  download: async (regions) => {
    const result = await queueRegions(
      regions,
      async (region) => {
        const r = await bridge.call('packs:download', region);
        return r.ok ? r.value : { ok: false, error: r.error };
      },
      shell.getState().settings.offlineOnly === true,
    );
    const jobs = await bridge.call('packs:jobs', {});
    if (jobs.ok) set({ jobs: jobs.value });
    return result;
  },

  openPanel: () => {
    shell.getState().openSettingsPage('maps');
  },
}));

let started = false;

/** Load once and follow the downloads, the library and the data folder from then on. */
function start(): void {
  if (started) return;
  started = true;
  void mapCoverage.getState().refresh();
  window.aio.on('packs:job', (job) => {
    const s = mapCoverage.getState();
    mapCoverage.setState({ jobs: [...s.jobs.filter((j) => j.id !== job.id), job] });
    // a finished or dismissed pack changes what is covered
    if (job.state === 'done') void s.refresh();
  });
  shell.subscribe((s, prev) => {
    if (s.library !== prev.library || s.settings.dataRoot !== prev.settings.dataRoot)
      void mapCoverage.getState().refresh();
  });
}

export type MapCoverage = MapCoverageState & CoverageReport;

/** The store with what the panel shows worked out from it. Loads on first use. */
export function useMapCoverage(): MapCoverage {
  useEffect(start, []);
  const s = useStore(mapCoverage);
  const report = useMemo(() => {
    const r = coverageReport(s.projects, s.packs, s.jobs);
    return s.placesKnown ? r : { ...r, plan: { regions: [] }, orphans: [] };
  }, [s.placesKnown, s.projects, s.packs, s.jobs]);
  return { ...s, ...report };
}

/** What another screen says about street maps for the projects, and how it opens the panel. */
export interface ProjectMapHint {
  /** Projects placed on the Earth without a detailed street map; 0 until loaded. */
  missing: number;
  /** Projects placed on the Earth. */
  located: number;
  /** "3 projects have no detailed street map", or null when there is nothing to say. */
  text: string | null;
  /** Open Settings, Offline maps, where the missing areas are listed with their sizes. */
  open: () => void;
}

/** The hint from a report (also for callers outside React, with `mapCoverage.getState()`). */
export function projectMapHint(report: Pick<CoverageReport, 'summary'>): ProjectMapHint {
  const { missing, located } = report.summary;
  return {
    missing,
    located,
    text: missing > 0 ? t('maps.coverage.hint', { count: missing }) : null,
    open: () => {
      mapCoverage.getState().openPanel();
    },
  };
}

/**
 * For the Globe, the title bar and any other screen: how many projects have no detailed street
 * map, as a number and a sentence, and `open()` for the panel that downloads them. Reads local
 * files only; nothing is downloaded by showing it.
 */
export function useProjectMapHint(): ProjectMapHint {
  const { summary } = useMapCoverage();
  return useMemo(() => projectMapHint({ summary }), [summary]);
}
