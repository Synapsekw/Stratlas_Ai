import { t } from '@aio/ui';
import type { TraceLabels } from '@aio/video';
import { useWorkspace, workspace } from '@aio/workspace';
import { stagePrefs, useStagePrefs, type StagePrefState } from './stagePrefs';

/**
 * Drone telemetry (the tactical trace and HUD of the playing clip), per project: on unless the
 * person turned it off. Independent of the flight path mode (P).
 */
export function telemetryOn(s: StagePrefState, projectId: string | null): boolean {
  return projectId ? (s.byProject[projectId]?.telemetry ?? true) : true;
}

export function useTelemetryOn(): boolean {
  const projectId = useWorkspace((s) => s.project?.id ?? null);
  return useStagePrefs((s) => telemetryOn(s, projectId));
}

/** D, the toolbar and the palette: flip it for the open project. */
export function toggleTelemetry(): void {
  const id = workspace.getState().project?.id;
  if (!id) return;
  const s = stagePrefs.getState();
  s.update(id, { telemetry: !telemetryOn(s, id) });
}

/** The HUD words from the catalogue. */
export function telemetryLabels(): TraceLabels {
  return {
    title: t('stage.telemetry.hud.title'),
    distance: t('stage.telemetry.hud.distance'),
    agl: t('stage.telemetry.hud.agl'),
    elevation: t('stage.telemetry.hud.elevation'),
    speed: t('stage.telemetry.hud.speed'),
    heading: t('stage.telemetry.hud.heading'),
    gimbal: t('stage.telemetry.hud.gimbal'),
    clipTime: t('stage.telemetry.hud.clipTime'),
    start: t('stage.telemetry.hud.start'),
  };
}
