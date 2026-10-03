import { useWorkspace } from '@aio/workspace';

/**
 * Issue register: issues with code, class, severity (model colours), status and sightings;
 * filter, search, sort; selecting an issue selects it in every view. Owner: stream S7.
 *
 * Phase 0 stub.
 */
export function IssueRegister({ className }: { className?: string }) {
  const count = useWorkspace((s) => s.issues.length);
  return (
    <div className={className} data-stub="issue-register">
      Issues: {count}
    </div>
  );
}

/** Detail and edit form for one issue (class, severity, status, note, sightings). Phase 0 stub. */
export function IssueDetail({ issueId, className }: { issueId: string; className?: string }) {
  return (
    <div className={className} data-stub="issue-detail">
      Issue {issueId}
    </div>
  );
}

/** Photo viewer with pan, zoom, mask overlay and annotation tools. Phase 0 stub. */
export function PhotoViewer({
  layerId,
  photoId,
  className,
}: {
  layerId: string;
  photoId: string;
  className?: string;
}) {
  return (
    <div className={className} data-stub="photo-viewer">
      Photo {layerId}/{photoId}
    </div>
  );
}

/**
 * Annotation overlay for a video window: draw a box or polygon on the current frame, pick class
 * and severity, track across frames. Mounted inside VideoWindow. Phase 0 stub.
 */
export function VideoAnnotator({ layerId }: { layerId: string }) {
  return <div data-stub="video-annotator" data-layer={layerId} />;
}
