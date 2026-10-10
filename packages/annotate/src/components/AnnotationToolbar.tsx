import { getActiveScene, onActiveScene } from '@aio/engine';
import { useWorkspace, workspace, type Workspace } from '@aio/workspace';
import { useEffect, useState, useSyncExternalStore } from 'react';
import type { StoreApi } from 'zustand/vanilla';
import { annotateUi, beginSighting, useAnnotateReadOnly, useAnnotateUi } from '../runtime';
import { installIssueOverlay, startSceneTool, type SceneTool } from '../tools/scene';
import { SightingPicker } from './SightingPicker';
import { AnnotateStyles } from './styles';

const TOOLS: { id: SceneTool; label: string; title: string }[] = [
  { id: 'point', label: 'Pin', title: 'Mesh point' },
  { id: 'polyline', label: 'Line', title: 'Surface polyline (Enter or double-click to finish)' },
  { id: 'polygon', label: 'Area', title: 'Surface polygon (Enter or double-click to close)' },
  { id: 'cloud-point', label: 'Cloud pt', title: 'Point-cloud point' },
  { id: 'cloud-box', label: 'Cloud box', title: 'Point-cloud box: click two corners' },
];

let overlayUsers = 0;
let uninstallOverlay: (() => void) | null = null;

/**
 * Install the 3D issue pins once for the app, however many components ask for them. `store` is
 * the workspace as the 3D view sees it (one survey date while it shows one): the pins of a date
 * follow that date's layers there. Every caller passes the same store.
 */
export function useIssueOverlay(store: StoreApi<Workspace> = workspace): void {
  useEffect(() => {
    overlayUsers += 1;
    uninstallOverlay ??= installIssueOverlay(store);
    return () => {
      overlayUsers -= 1;
      if (overlayUsers === 0) {
        uninstallOverlay?.();
        uninstallOverlay = null;
      }
    };
  }, [store]);
}

/**
 * 3D annotation tools for the stage toolbar: pins, surface lines and areas on meshes, points and
 * boxes on point clouds. Also shows issue pins in the active scene.
 */
export function AnnotationToolbar({
  className,
  store,
}: {
  className?: string;
  /** The workspace as the 3D view sees it, for the issue pins (`useIssueOverlay`). */
  store?: StoreApi<Workspace>;
}) {
  useIssueOverlay(store);
  const [tool, setTool] = useState<SceneTool | null>(null);
  // An external store: the scene may be published before this component subscribes.
  const scene = useSyncExternalStore(onActiveScene, getActiveScene, getActiveScene);
  const attach = useAnnotateUi((s) => s.attachToSelected);
  const selection = useWorkspace((s) => s.selection);
  const readOnly = useAnnotateReadOnly();

  useEffect(() => {
    if (!scene || !tool) return;
    return startSceneTool(scene, tool, (s, at) => {
      beginSighting(s, at);
    });
  }, [scene, tool]);

  if (readOnly) return null;
  return (
    <div
      className={`ann-toolbar ${className ?? ''}`}
      role="toolbar"
      aria-label="3D annotation tools"
      style={{ position: 'static' }}
    >
      <AnnotateStyles />
      {TOOLS.map((t) => (
        <button
          key={t.id}
          type="button"
          className="ann-btn ghost"
          aria-pressed={tool === t.id}
          disabled={!scene}
          title={t.title}
          onClick={() => {
            setTool(tool === t.id ? null : t.id);
          }}
        >
          {t.label}
        </button>
      ))}
      <span className="sep" />
      <button
        type="button"
        className="ann-btn ghost"
        aria-pressed={attach}
        disabled={selection?.kind !== 'issue'}
        title="New shapes join the selected issue instead of creating one"
        onClick={() => {
          annotateUi.setState({ attachToSelected: !attach });
        }}
      >
        Add to selected
      </button>
      <SightingPicker kinds={['mesh', 'pointcloud']} />
    </div>
  );
}
