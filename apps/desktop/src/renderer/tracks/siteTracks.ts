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
import type { AntennasFile, ChangeSet, ProjectManifest } from '@aio/schema';
import { captureIndex, captureShift, dateShiftOf } from '@aio/workspace';
import { useEffect, useMemo } from 'react';
import { createStore, useStore } from 'zustand';
import { bridge } from '../shell';

interface HistoryState {
  /** `<projectId>|<live run id>` the copies were read for. */
  key: string | null;
  files: readonly AntennasFile[];
}

export const antennaHistory = createStore<HistoryState>()(() => ({ key: null, files: [] }));

let inFlight: string | null = null;

/** Read the per-date copies for this project and live run, once per pair. */
export async function loadAntennaHistory(projectId: string, runId: string | null): Promise<void> {
  const key = `${projectId}|${runId ?? ''}`;
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
  history: readonly AntennasFile[];
  detections: readonly Detection[];
  sets: readonly ChangeSet[];
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
    regions: regionTracks(src.sets, captures),
  };
}

/** Keeps the copies read for the live inventory, and returns them. */
export function useAntennaHistory(projectId: string | null, runId: string | null) {
  useEffect(() => {
    if (projectId) void loadAntennaHistory(projectId, runId);
  }, [projectId, runId]);
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
