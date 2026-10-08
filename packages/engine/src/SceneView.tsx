import { useWorkspace, workspace, type Workspace } from '@aio/workspace';
import { useEffect, useRef, useState } from 'react';
import type { StoreApi } from 'zustand/vanilla';
import { engineConfig } from './config';
import { FONT_UI, PALETTE } from './palette';
import { setActiveScene } from './registry';
import { Stage } from './stage/Stage';
import type { EngineStage } from './types';

export interface SceneViewProps {
  className?: string;
  /**
   * The workspace the stage follows (default: the app's). A view of one survey date passes a
   * scoped view of it (`scopedStore`). Read once, when the stage is created.
   */
  store?: StoreApi<Workspace>;
  /**
   * Publish the stage as the active scene that tools, the agent and the annotation work on
   * (default true). A second 3D view (comparing dates) passes false.
   */
  primary?: boolean;
  /** Called with the stage once it exists and with null when it goes. */
  onStage?: (stage: EngineStage | null) => void;
}

/**
 * The fused 3D stage. Owner: stream S3. Reads the open project from @aio/workspace, creates a
 * layer for each manifest layer through the registered adapters, consumes camera requests and
 * redraws on every container resize. Publishes its SceneHandle with setActiveScene.
 */
const NO_WEBGL = '3D view needs WebGL, which is not available on this device.';

let webgl: boolean | undefined;

/** Asked once per app: the probe's context is let go at once (it was one more context per open). */
export function webglAvailable(): boolean {
  if (webgl !== undefined) return webgl;
  try {
    const gl = document.createElement('canvas').getContext('webgl2');
    webgl = gl !== null;
    gl?.getExtension('WEBGL_lose_context')?.loseContext();
  } catch {
    webgl = false;
  }
  return webgl;
}

export function SceneView({ className, store, primary = true, onStage }: SceneViewProps) {
  const host = useRef<HTMLDivElement>(null);
  const [error] = useState<string | null>(() => (webglAvailable() ? null : NO_WEBGL));
  const project = useWorkspace((s) => s.project);
  // read at creation: changing them later does not recreate the stage
  const init = useRef({ store, primary, onStage });
  useEffect(() => {
    init.current.onStage = onStage;
  }, [onStage]);

  useEffect(() => {
    const el = host.current;
    if (!el || error) return;
    // one object for the stage's life; its onStage follows the latest prop
    const cfg = init.current;
    const { store: source, primary: publish } = cfg;
    let stage: Stage;
    try {
      const cfg = engineConfig();
      stage = new Stage({
        container: el,
        store: source ?? workspace,
        resolveUrl: cfg.resolveUrl,
        devTools: cfg.devTools,
      });
    } catch (e) {
      console.error('3D view could not start', e);
      return;
    }
    if (publish) setActiveScene(stage);
    cfg.onStage?.(stage);
    return () => {
      cfg.onStage?.(null);
      if (publish) setActiveScene(null);
      stage.dispose();
    };
  }, [error]);

  return (
    <div
      ref={host}
      className={className}
      data-scene-view={primary ? '' : 'compare'}
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
