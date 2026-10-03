import { useWorkspace } from '@aio/workspace';

export interface SceneViewProps {
  className?: string;
}

/**
 * The fused 3D stage. Owner: stream S3. Reads the open project from @aio/workspace, creates a
 * layer for each manifest layer through the registered adapters, consumes camera requests and
 * redraws on every container resize.
 *
 * Phase 0 stub: renders a labelled placeholder so the shell can be laid out.
 */
export function SceneView({ className }: SceneViewProps) {
  const project = useWorkspace((s) => s.project);
  return (
    <div className={className} data-stub="scene-view" role="img" aria-label="3D scene">
      {project ? `3D scene: ${project.manifest.name}` : 'No project open'}
    </div>
  );
}
