import { clipKeys, photoCorrection, type WalkFit } from '@aio/geo';
import { WALK_HEIGHT_M, type WalkLayer } from '@aio/schema';
import { loadFlight, type Flight, type VideoLayer } from '@aio/video';
import { dateShiftOf, useWorkspace } from '@aio/workspace';
import { useEffect, useMemo, useState } from 'react';
import { inputsKey, placedWalks, usePlacedWalkFits, viewHeading } from '../../walks/placeWalk';
import { useCaptureIndex } from '../compare';
import { safeAssetUrl } from './safeAssetUrl';
import { sampleVideo, spotEntries, type DirectionKeys } from './spotEntries';
import type { FrameSample, SpotEntry, TrackSample } from './spotTypes';
import { walkTrack } from './spotWalk';

/**
 * Samples of each clip, once per clip and calibration per session (spec "Scale"): one entry per
 * clip, replaced when its calibration or lens changes (the lens is copied into every pose).
 */
const sampled = new Map<string, { inputs: string; samples: readonly FrameSample[] }>();
export function cachedSamples(
  projectId: string,
  layer: VideoLayer,
  flight: Flight,
  keys: DirectionKeys,
): readonly FrameSample[] {
  const key = `${projectId}|${layer.id}`;
  const inputs = JSON.stringify([
    layer.flight,
    layer.offsetMs,
    layer.orientation ?? null,
    layer.positionOffsetM ?? null,
    layer.lens,
    keys ?? null,
  ]);
  const hit = sampled.get(key);
  if (hit?.inputs === inputs) return hit.samples;
  const samples = sampleVideo(layer, flight, keys);
  sampled.set(key, { inputs, samples });
  return samples;
}

/** Tracks of placed walks, per walk inputs and live fit (a moved drawing makes a new fit). */
const tracked = new Map<string, { fit: WalkFit; samples: readonly TrackSample[] }>();
function cachedTrack(
  projectId: string,
  layer: WalkLayer,
  fit: WalkFit,
  orientation: readonly Float64Array[] | null,
): readonly TrackSample[] {
  const key = inputsKey(projectId, layer);
  const hit = tracked.get(key);
  if (hit?.fit === fit) return hit.samples;
  const yaw = layer.place?.yawOffsetDeg ?? 0;
  const samples = walkTrack(fit, layer.durationS, layer.place?.heightM ?? WALK_HEIGHT_M, (t) =>
    viewHeading(fit, orientation, yaw, t),
  );
  tracked.set(key, { fit, samples });
  return samples;
}

/**
 * The spot search's entries for the open project. Flight logs are read only while `active` (the
 * viewer or an inline strip is open) and shared with the Frames pane through `loadFlight`'s cache.
 * A clip whose log is missing or broken is unreadable (null, counted as skipped on its date); one
 * still loading is left out until it arrives. Walks the same way: an unplaced walk (or one whose
 * pins no longer fit) is skipped, a placed one whose files are still being read is left out.
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
  const { fits, inputsOf } = usePlacedWalkFits(active);
  const placed = useMemo(
    () => new Set(project ? placedWalks(project.manifest).map((w) => w.id) : []),
    [project],
  );
  const walksReading = [...placed].some((id) => !inputsOf(id));
  const entries = useMemo(() => {
    // the viewer is mounted all session long: nothing is computed until it (or a strip) opens
    if (!active || !project || !index) return [];
    return spotEntries({
      layers,
      index,
      correction: (l, p) => photoCorrection(orientation, l, p) ?? null,
      shiftOf: (l) => dateShiftOf(project.manifest, l),
      videoSamples: (l) => {
        if (!map) return undefined;
        const f = map.get(l.id);
        return f ? cachedSamples(project.id, l, f, clipKeys(orientation, l.id)) : null;
      },
      walkSamples: (l) => {
        if (!placed.has(l.id)) return null;
        const inputs = inputsOf(l.id);
        if (!inputs) return undefined;
        const fit = fits.find((w) => w.layer.id === l.id);
        return fit ? cachedTrack(project.id, l, fit.fit, inputs.orientation) : null;
      },
    });
  }, [active, project, index, layers, orientation, map, placed, inputsOf, fits]);
  return { entries, reading: active && ((clips.length > 0 && !map) || walksReading) };
}
