import { useWorkspace } from '@aio/workspace';

export interface VideoWindowProps {
  /** Video layer id from the manifest. */
  layerId: string;
  className?: string;
}

/**
 * A video window synced to the project clock, with a telemetry overlay (altitude, speed, gimbal,
 * timecode). Owner: stream S6. Annotation tools (stream S7) mount inside it through `children`.
 *
 * Phase 0 stub.
 */
export function VideoWindow({ layerId, className }: VideoWindowProps) {
  const name = useWorkspace(
    (s) => s.project?.manifest.layers.find((l) => l.id === layerId)?.name ?? layerId,
  );
  return (
    <div className={className} data-stub="video-window" aria-label={`Video ${name}`}>
      Video: {name}
    </div>
  );
}
