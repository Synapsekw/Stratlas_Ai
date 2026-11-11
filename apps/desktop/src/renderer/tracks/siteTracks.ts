/**
 * Tracks across survey dates for the open project (Wave 3 M2), derived at read time with
 * `@aio/change/core` from what the app already holds: the antenna inventory and its per-date
 * copies (`telecom:readAntennaHistory`), the review's hot spots, and the change sets. Nothing is
 * written. The copies are read again whenever the live inventory's run changes (a new run writes
 * them).
 */
import {
  antennaTracks,
  hotspotTracks,
  HOTSPOT_CLASS,
  regionTracks,
  type HotspotDetection,
  type Track,
} from '@aio/change/core';
import type { Detection } from '@aio/annotate/detections';
import type { AntennaHistoryFile, AntennasFile, ChangeSet, ProjectManifest } from '@aio/schema';
import { captureIndex, captureShift, dateShiftOf } from '@aio/workspace';
import { useEffect, useMemo } from 'react';
import { createStore, useStore } from 'zustand';
import { bridge } from '../shell';

interface HistoryState {
  /** `<projectId>|<live inventory version>` the records were read for. */
  key: string | null;
  files: readonly AntennaHistoryFile[];
}

export const antennaHistory = createStore<HistoryState>()(() => ({ key: null, files: [] }));

let inFlight: string | null = null;

/**
 * The live inventory's version for the records: its run and how many units it has, so a new run
 * (new records) and a delete (records read again without the deleted units) both read again.
 */
export function inventoryVersion(live: AntennasFile | null): string {
  return live ? `${live.run.id}:${String(live.units.length)}` : '';
}

/** Read what each date measured for this project and live inventory version, once per pair. */
export async function loadAntennaHistory(projectId: string, version: string): Promise<void> {
  const key = `${projectId}|${version}`;
  if (antennaHistory.getState().key === key || inFlight === key) return;
  inFlight = key;
  try {
    const r = await bridge.call('telecom:readAntennaHistory', { projectId });
    if (inFlight !== key) return;
    antennaHistory.setState({ key, files: r.ok && r.value.ok ? r.value.files : [] });
  } finally {
    if (inFlight === key) inFlight = null;
  }
}

/** A thermal hot spot of the review: a `thermal-<layer>.json` draft or what it became. */
export function isHotspot(d: Pick<Detection, 'pass' | 'classId'>): boolean {
  return d.classId === HOTSPOT_CLASS || d.pass.startsWith('thermal-');
}

export function hotspotsOf(list: readonly Detection[]): HotspotDetection[] {
  const out: HotspotDetection[] = [];
  for (const d of list) {
    if (!isHotspot(d)) continue;
    const point = d.vote?.point;
    const h: HotspotDetection = {
      id: d.id,
      layer: d.source.layer,
      status: d.status,
      widthPx: d.size[0],
      pass: d.pass,
    };
    if (d.source.kind === 'photo') h.photo = d.source.photo;
    if (d.fields) h.fields = d.fields;
    if (point) h.point = [point[0], point[1], point[2]];
    out.push(h);
  }
  return out;
}

export interface TrackSources {
  manifest: ProjectManifest;
  live: AntennasFile | null;
  history: readonly AntennaHistoryFile[];
  detections: readonly Detection[];
  sets: readonly ChangeSet[];
  /** Change sets out of date after a line-up (`changeSetStale`): left out of region tracks. */
  isStale?: (set: ChangeSet) => boolean;
}

/** Every track of the project, by kind. */
export function siteTracks(src: TrackSources): {
  antennas: Track[];
  hotspots: Track[];
  regions: Track[];
} {
  // a track needs two dates: an antenna one copy at least, a hot spot a placed one, a region a set
  const spots = hotspotsOf(src.detections).filter((d) => d.point && d.status !== 'rejected');
  if (src.history.length === 0 && spots.length === 0 && src.sets.length === 0)
    return { antennas: [], hotspots: [], regions: [] };
  const index = captureIndex(src.manifest);
  const captures = index.captures.map((c) => ({ id: c.id, date: c.date }));
  return {
    antennas:
      src.history.length > 0
        ? antennaTracks(src.history, src.live, captures, (c) => captureShift(src.manifest, c))
        : [],
    hotspots:
      spots.length > 0
        ? hotspotTracks(src.manifest, index, spots, (l) => dateShiftOf(src.manifest, l))
        : [],
    regions: regionTracks(src.sets, captures, src.isStale),
  };
}

/** Keeps the records read for the live inventory, and returns them. */
export function useAntennaHistory(projectId: string | null, live: AntennasFile | null) {
  const version = inventoryVersion(live);
  useEffect(() => {
    if (projectId) void loadAntennaHistory(projectId, version);
  }, [projectId, version]);
  return useStore(antennaHistory, (s) => s.files);
}

/** The label the app gives each survey date, by capture id. */
export function useDateLabel(manifest: ProjectManifest | null | undefined) {
  return useMemo(() => {
    const byId = new Map<string, string>();
    for (const c of manifest?.captures ?? []) byId.set(c.id, c.label || c.date);
    return (id: string) => byId.get(id) ?? id;
  }, [manifest]);
}
