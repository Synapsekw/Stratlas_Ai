/**
 * Frame capture of the live 2D map for the agent (capture_frame and "attach the current frame").
 * MapLibre draws into a WebGL canvas without a preserved drawing buffer, so the frame is read in
 * the map's own `render` event, right after a repaint it asks for.
 */
import type { MapController } from './controller';

let active: MapController | null = null;
const activeListeners = new Set<(c: MapController | null) => void>();

/** The map view that is on screen (MapView sets and clears it). */
export function setActiveMap(controller: MapController | null): void {
  active = controller;
  for (const l of activeListeners) l(controller);
}

/** The map view on screen, for tools that draw on it (Set camera direction), or null. */
export function getActiveMap(): MapController | null {
  return active;
}

/** Follow the map view on screen; returns the unsubscribe. */
export function onActiveMap(listener: (c: MapController | null) => void): () => void {
  activeListeners.add(listener);
  return () => {
    activeListeners.delete(listener);
  };
}

/** Longest edge of the captured frame, as for the other windows. */
const MAX_EDGE = 1568;

function toJpeg(source: HTMLCanvasElement): string | null {
  const { width, height } = source;
  if (!width || !height) return null;
  const k = Math.min(1, MAX_EDGE / Math.max(width, height));
  const out = document.createElement('canvas');
  out.width = Math.round(width * k);
  out.height = Math.round(height * k);
  const g = out.getContext('2d');
  if (!g) return null;
  g.drawImage(source, 0, 0, out.width, out.height);
  return out.toDataURL('image/jpeg', 0.85);
}

/** A JPEG data URL of the map as shown now, or null when no map is on screen. */
export function captureMap(timeoutMs = 2000): Promise<string | null> {
  const map = active?.map;
  if (!map) return Promise.resolve(null);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (v: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(v);
    };
    const onRender = () => {
      try {
        finish(toJpeg(map.getCanvas()));
      } catch {
        finish(null);
      }
    };
    const timer = setTimeout(() => {
      map.off('render', onRender);
      finish(null);
    }, timeoutMs);
    map.once('render', onRender);
    map.triggerRepaint();
  });
}
