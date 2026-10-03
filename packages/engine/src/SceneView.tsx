import { useWorkspace, workspace } from '@aio/workspace';
import { useEffect, useRef, useState } from 'react';
import { engineConfig } from './config';
import { FONT_UI, PALETTE } from './palette';
import { setActiveScene } from './registry';
import { Stage } from './stage/Stage';

export interface SceneViewProps {
  className?: string;
}

/**
 * The fused 3D stage. Owner: stream S3. Reads the open project from @aio/workspace, creates a
 * layer for each manifest layer through the registered adapters, consumes camera requests and
 * redraws on every container resize. Publishes its SceneHandle with setActiveScene.
 */
const NO_WEBGL = '3D view needs WebGL, which is not available on this device.';

function webglAvailable(): boolean {
  try {
    return document.createElement('canvas').getContext('webgl2') !== null;
  } catch {
    return false;
  }
}

export function SceneView({ className }: SceneViewProps) {
  const host = useRef<HTMLDivElement>(null);
  const [error] = useState<string | null>(() => (webglAvailable() ? null : NO_WEBGL));
  const project = useWorkspace((s) => s.project);

  useEffect(() => {
    const el = host.current;
    if (!el || error) return;
    let stage: Stage;
    try {
      const cfg = engineConfig();
      stage = new Stage({
        container: el,
        store: workspace,
        resolveUrl: cfg.resolveUrl,
        devTools: cfg.devTools,
      });
    } catch (e) {
      console.error('3D view could not start', e);
      return;
    }
    setActiveScene(stage);
    return () => {
      setActiveScene(null);
      stage.dispose();
    };
  }, [error]);

  return (
    <div
      ref={host}
      className={className}
      data-scene-view=""
      style={{
        position: 'relative',
        overflow: 'hidden',
        minWidth: 0,
        minHeight: 0,
        background: '#15191d',
      }}
    >
      {(error ?? !project) && (
        <div
          role="status"
          style={{
            position: 'absolute',
            inset: 0,
            display: 'grid',
            placeItems: 'center',
            pointerEvents: 'none',
            font: `400 13px ${FONT_UI}`,
            color: PALETTE.ovDimCss,
          }}
        >
          {error ?? 'No project open'}
        </div>
      )}
    </div>
  );
}
