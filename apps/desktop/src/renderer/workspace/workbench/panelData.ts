/**
 * What the project holds, as the right panel's sections read it (D2): a section shows when its
 * data is there, never because of the project type. Small on purpose, so the panel's tabs and the
 * palette can read it without the benches.
 */
import { canCompare, useWorkspace } from '@aio/workspace';
import { useMemo } from 'react';
import { useIsRoad } from '../../road/useRoadMap';
import { useActiveSpace } from '../../spaces/activeSpace';
import { useCaptureIndex } from '../compare';
import type { PanelData } from './tabsModel';
import { useHasVolumeMeasurements, useKitVolumes } from './view';

/** The layer kinds a project holds (pure). */
export function layerData(
  kinds: ReadonlySet<string>,
): Omit<PanelData, 'dated' | 'volumes' | 'road' | 'flightlines'> {
  const pointcloud = kinds.has('pointcloud');
  const model3d = pointcloud || kinds.has('mesh');
  return {
    pointcloud,
    model3d,
    surface: model3d || kinds.has('raster'),
    video: kinds.has('video'),
    photos: kinds.has('photos') || kinds.has('panoramas'),
  };
}

export function usePanelData(): PanelData {
  const kindsKey = useWorkspace((s) =>
    [...new Set((s.project?.manifest.layers ?? []).map((l) => l.kind))].sort().join(','),
  );
  const captureIx = useCaptureIndex();
  const dated = captureIx !== null && canCompare(captureIx);
  const kit = useKitVolumes();
  const piles = useHasVolumeMeasurements();
  const road = useIsRoad();
  const { spaceId } = useActiveSpace();
  // any flight line in the active space, whatever the project type
  const flightlines = useWorkspace((s) =>
    (s.project?.manifest.layers ?? []).some(
      (l) => l.kind === 'flightline' && (l.space ?? 'main') === spaceId,
    ),
  );
  return useMemo(
    () => ({
      ...layerData(new Set(kindsKey.split(','))),
      dated,
      volumes: kit || piles,
      road,
      flightlines,
    }),
    [kindsKey, dated, kit, piles, road, flightlines],
  );
}
