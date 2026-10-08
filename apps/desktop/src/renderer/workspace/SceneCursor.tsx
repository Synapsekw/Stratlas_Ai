import type { SceneHandle } from '@aio/engine';
import { crsLabel, formatEastNorth, localToProject } from '@aio/ui';
import { useWorkspace, workspace } from '@aio/workspace';
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import {
  SiteSettingsButton,
  siteCursorText,
  siteCursorTitle,
  useSiteDisplay,
} from '../survey/SiteSettings';

export function CursorReadout({ text }: { text: string | null }) {
  const crs = useWorkspace((s) => (s.project ? crsLabel(s.project.manifest.crs) : ''));
  // M11 G1: the site's display CRS, heights and unit once the site has settings
  const site = useSiteDisplay((s) => (s.exists && s.settings ? siteCursorTitle() : null));
  return (
    <div className="cursor-ro" aria-live="off" data-testid="cursor-readout">
      <span style={{ pointerEvents: 'auto' }}>
        <SiteSettingsButton />
      </span>
      <br />
      {site ?? crs}
      <br />
      {text ?? 'Point at the scene for coordinates'}
    </div>
  );
}

/**
 * Project coordinates under the pointer in a 3D view, at most once per frame. `scene` returns
 * the view to raycast (the active scene, or a second view comparing dates).
 */
export function useSceneCursor(scene: () => SceneHandle | null): {
  cursor: string | null;
  onMove: (e: ReactPointerEvent<HTMLDivElement>) => void;
  onLeave: () => void;
} {
  const [cursor, setCursor] = useState<string | null>(null);
  const pending = useRef<{ x: number; y: number } | null>(null);
  const raf = useRef<number | null>(null);
  const sceneRef = useRef(scene);
  useEffect(() => {
    sceneRef.current = scene;
  }, [scene]);

  useEffect(
    () => () => {
      if (raf.current !== null) cancelAnimationFrame(raf.current);
    },
    [],
  );

  const onMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    pending.current = {
      x: ((e.clientX - r.left) / r.width) * 2 - 1,
      y: -(((e.clientY - r.top) / r.height) * 2 - 1),
    };
    if (raf.current !== null) return;
    raf.current = requestAnimationFrame(() => {
      raf.current = null;
      const p = pending.current;
      const h = sceneRef.current();
      const project = workspace.getState().project;
      if (!p || !h || !project) return;
      const hit = h.raycast(p.x, p.y);
      if (!hit) {
        setCursor(null);
        return;
      }
      const [e2, n, el] = localToProject(project.manifest.origin, [
        hit.point.x,
        hit.point.y,
        hit.point.z,
      ]);
      setCursor(siteCursorText(e2, n, el) ?? `${formatEastNorth(e2, n)} · EL ${el.toFixed(1)} m`);
    });
  };

  return {
    cursor,
    onMove,
    onLeave: () => {
      setCursor(null);
    },
  };
}
