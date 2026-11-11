/**
 * Track history sections for the existing detail views (Wave 3 M2): an antenna's azimuth,
 * downtilt and height over the survey dates in its details, and a hot spot's peak and ΔT in
 * Inspect. Each shows nothing until the object is seen on two dates.
 */
import { antennaTracks, hotspotTracks, trackOf } from '@aio/change/core';
import { TrackHistory } from '@aio/change';
import type { Detection } from '@aio/annotate/detections';
import { captureIndex, captureShift, dateShiftOf, useWorkspace } from '@aio/workspace';
import type { ReactElement } from 'react';
import { useMemo } from 'react';
import { useDetections } from '../detections/store';
import { useAntennas } from '../telecom/antennaStore';
import { hotspotsOf, isHotspot, useAntennaHistory, useDateLabel } from './siteTracks';

export function AntennaTrackHistory({ unitId }: { unitId: string }): ReactElement | null {
  const manifest = useWorkspace((s) => s.project?.manifest);
  const projectId = useAntennas((s) => s.projectId);
  const live = useAntennas((s) => s.file);
  const history = useAntennaHistory(projectId, live?.run.id ?? null);
  const dateLabel = useDateLabel(manifest);
  const tracks = useMemo(() => {
    // a track needs two dates, so one copy of the inventory at least
    if (!manifest || history.length === 0) return [];
    const captures = captureIndex(manifest).captures.map((c) => ({ id: c.id, date: c.date }));
    return antennaTracks(history, live, captures, (c) => captureShift(manifest, c));
  }, [manifest, history, live]);
  return (
    <TrackHistory
      track={trackOf(tracks, unitId)}
      current={unitId}
      dateLabel={dateLabel}
      testId="antenna-track"
    />
  );
}

export function HotspotTrackHistory({
  detection,
}: {
  detection: Pick<Detection, 'id' | 'pass' | 'classId'>;
}): ReactElement | null {
  const manifest = useWorkspace((s) => s.project?.manifest);
  const list = useDetections((s) => s.review.detections);
  const dateLabel = useDateLabel(manifest);
  const hot = isHotspot(detection);
  const tracks = useMemo(() => {
    const spots = hot ? hotspotsOf(list).filter((d) => d.point && d.status !== 'rejected') : [];
    if (!manifest || spots.length < 2) return [];
    return hotspotTracks(manifest, captureIndex(manifest), spots, (l) => dateShiftOf(manifest, l));
  }, [manifest, list, hot]);
  if (!hot) return null;
  return (
    <TrackHistory
      track={trackOf(tracks, detection.id)}
      current={detection.id}
      dateLabel={dateLabel}
      testId="hotspot-track"
    />
  );
}
