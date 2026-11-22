/**
 * Why Detect antennas cannot start now, or null: the one rule of both its buttons (Tools > Measure
 * > Telecom and the empty Antennas list). Read-only, a run going, a flag being measured, or the
 * cloud the run reads still loading.
 */
import { getActiveStage, onActiveScene } from '@aio/engine';
import { t } from '@aio/ui';
import { useEffect, useReducer, useSyncExternalStore } from 'react';
import { useAntennaClouds } from './AntennaRunner';
import { useAntennas } from './antennaStore';

export function useDetectReason(): string | null {
  const stage = useSyncExternalStore(onActiveScene, getActiveStage, getActiveStage);
  const clouds = useAntennaClouds();
  const s = useAntennas((a) => a);
  const [, bump] = useReducer((n: number) => n + 1, 0);
  // the clouds finishing their load change the reason
  useEffect(() => stage?.onLayerLoaded(bump), [stage]);
  const watched = s.cloudLayer
    ? clouds.filter((l) => l.id === s.cloudLayer)
    : clouds.filter((l) => l.visible);
  const loading = stage !== null && watched.some((l) => !stage.layerLoaded(l.id));
  if (s.readOnly) return t('telecom.antennas.readOnly');
  if (s.running) return t('telecom.antennas.running');
  if (s.flagStarting || s.flagJob) return t('telecom.antennas.flag.busy');
  if (loading) return t('telecom.antennas.loading');
  return null;
}
