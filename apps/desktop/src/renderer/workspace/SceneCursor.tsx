import type { SceneHandle } from '@aio/engine';
import { formatQuantity } from '@aio/geo';
import { defaultSurveySettings, spaceFrame, type Crs, type Vec3 } from '@aio/schema';
import { crsLabel, formatEastNorth, formatLocal, localToProject } from '@aio/ui';
import { useWorkspace, workspace } from '@aio/workspace';
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { useActiveSpace } from '../spaces/activeSpace';
import { stationReadout } from '../survey/designsStore';
import { measureFrameNow } from '../survey/measureFrame';
import type { Frame } from '../survey/measureScene';
import {
  SiteSettingsButton,
  siteCursorText,
  siteCursorTitle,
  useSiteDisplay,
} from '../survey/SiteSettings';

/** The elevation without site settings: the metric defaults, through the shared formatter. */
export function elevationText(el: number): string {
  return formatQuantity(el, 'distance', defaultSurveySettings().units, 1);
}

/** The frame's name under the readout: the active space's, so a chamber is not "UTM". */
export function cursorFrameLabel(crs: Crs): string {
  return crsLabel(crs);
}

/**
 * What the cursor reads in a local space (a confined-space drone's): plain metres from its
 * origin on X, Y and Z, no easting, northing or site CRS. Null for a georeferenced frame.
 */
export function cursorReadoutText(frame: Frame, scenePoint: Vec3): string {
  if (frame.local) return formatLocal(frame.toSite(scenePoint));
  const [e, n, el] = frame.toSite(scenePoint);
  return `${formatEastNorth(e, n)} · EL ${elevationText(el)}`;
}

/** `wide`: the other bottom corner of the pane is free, so the readout may run across it. */
export function CursorReadout({ text, wide = false }: { text: string | null; wide?: boolean }) {
  const manifest = useWorkspace((s) => s.project?.manifest ?? null);
  const { spaceId } = useActiveSpace();
  const frameCrs = manifest ? (spaceFrame(manifest, spaceId)?.crs ?? manifest.crs) : null;
  const crs = frameCrs ? cursorFrameLabel(frameCrs) : '';
  const local = frameCrs !== null && 'local' in frameCrs;
  // M11 G1: the site's display CRS, heights and unit once the site has settings (not in a local space)
  const site = useSiteDisplay((s) => (!local && s.exists && s.settings ? siteCursorTitle() : null));
  return (
    <div
      className={wide ? 'cursor-ro wide' : 'cursor-ro'}
      aria-live="off"
      data-testid="cursor-readout"
    >
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
      const frame = measureFrameNow();
      if (frame?.local) {
        setCursor(cursorReadoutText(frame, [hit.point.x, hit.point.y, hit.point.z]));
        return;
      }
      const [e2, n, el] = localToProject(project.manifest.origin, [
        hit.point.x,
        hit.point.y,
        hit.point.z,
      ]);
      // the station and offset on the active alignment are read in the project CRS (G6)
      const station = stationReadout(e2, n);
      const at = siteCursorText(e2, n, el) ?? `${formatEastNorth(e2, n)} · EL ${elevationText(el)}`;
      setCursor(station ? `${at} · ${station}` : at);
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
