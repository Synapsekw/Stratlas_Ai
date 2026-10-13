import { clipKeys, photoCorrection } from '@aio/geo';
import { loadFlight, type Flight, type VideoLayer } from '@aio/video';
import { useWorkspace } from '@aio/workspace';
import { useEffect, useMemo, useState } from 'react';
import { useCaptureIndex } from '../compare';
import { safeAssetUrl } from './safeAssetUrl';
import { sampleVideo, spotEntries, type DirectionKeys } from './spotEntries';
import type { FrameSample, SpotEntry } from './spotTypes';

/** Samples of each clip, once per clip and calibration per session (spec "Scale"). */
const sampled = new Map<string, readonly FrameSample[]>();
function cachedSamples(
  projectId: string,
  layer: VideoLayer,
  flight: Flight,
  keys: DirectionKeys,
): readonly FrameSample[] {
  const key = `${projectId}|${layer.id}|${JSON.stringify([layer.flight, layer.offsetMs, layer.orientation ?? null, layer.positionOffsetM ?? null, keys ?? null])}`;
  let s = sampled.get(key);
  if (!s) {
    s = sampleVideo(layer, flight, keys);
    sampled.set(key, s);
  }
  return s;
}

/**
 * The spot search's entries for the open project. Flight logs are read only while `active` (the
 * viewer or an inline strip is open) and shared with the Frames pane through `loadFlight`'s cache.
 * A clip whose log is missing or broken is unreadable (null, counted as skipped on its date); one
 * still loading is left out until it arrives.
 */
export function useSpotEntries(active: boolean): { entries: SpotEntry[]; reading: boolean } {
  const project = useWorkspace((s) => s.project);
  const orientation = useWorkspace((s) => s.orientation);
  const index = useCaptureIndex();
  const layers = useMemo(() => project?.manifest.layers ?? [], [project]);
  const clips = useMemo(() => layers.filter((l): l is VideoLayer => l.kind === 'video'), [layers]);
  const key = `${project?.id ?? ''}|${clips.map((l) => `${l.id}=${JSON.stringify(l.flight.src)}`).join('|')}`;
  const [flights, setFlights] = useState<{
    key: string;
    map: ReadonlyMap<string, Flight | null>;
  } | null>(null);
  useEffect(() => {
    if (!active || !project) return;
    let live = true;
    void Promise.allSettled(
      clips.map((l) => {
        const url = safeAssetUrl(project.id, l.flight.src);
        return url ? loadFlight(url) : Promise.reject(new Error('Flight log path is not valid'));
      }),
    ).then((rs) => {
      if (!live) return;
      const map = new Map<string, Flight | null>();
      clips.forEach((l, i) => {
        const r = rs[i];
        map.set(l.id, r?.status === 'fulfilled' ? r.value : null);
      });
      setFlights({ key, map });
    });
    return () => {
      live = false;
    };
  }, [active, project, clips, key]);
  const map = flights?.key === key ? flights.map : null;
  const entries = useMemo(() => {
    if (!project || !index) return [];
    return spotEntries({
      layers,
      index,
      correction: (l, p) => photoCorrection(orientation, l, p) ?? null,
      videoSamples: (l) => {
        if (!map) return undefined;
        const f = map.get(l.id);
        return f ? cachedSamples(project.id, l, f, clipKeys(orientation, l.id)) : null;
      },
    });
  }, [project, index, layers, orientation, map]);
  return { entries, reading: active && clips.length > 0 && !map };
}
