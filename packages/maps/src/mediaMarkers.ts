import {
  hasPos,
  MarkerLayer,
  panoMarkerStatus,
  panoOpenable,
  type MarkerMember,
  type MarkerSite,
  type MarkerView,
} from '@aio/engine';
import { correctedPhoto, photoCorrection } from '@aio/geo';
import type { AssetRef, PanoRef, PhotoRef, Vec3 } from '@aio/schema';
import type { Workspace } from '@aio/workspace';
import type { Map as MapLibreMap } from 'maplibre-gl';
import type { FrameProjection } from './geo';
import { photoMapClickHandler } from './photoPins';

/*
 * Photos and 360s on the map as the 3D view draws them: a plate with the kind's glyph (the same
 * marker layer and stylesheet as the 3D markers, so both themes match), a hover tip with the
 * thumbnail, and a click that opens the item: a photo beside the map (the app's photo map click
 * handler), a 360 through the 360 handler (else the workspace enters it in the 3D view).
 */

/**
 * Markers over a MapLibre map: positions through the frame projection, a layout on every map
 * render, and a click a marker took kept from MapLibre (its `click` never fires for that press).
 * `busy`: another tool owns the pointer (a pick, a drawing), so markers take no hover or clicks.
 */
export function mapMarkerView(
  map: MapLibreMap,
  proj: FrameProjection,
  busy?: () => boolean,
): MarkerView {
  const container = map.getContainer();
  /** Drops the click stop of the last claimed press. */
  let drop: (() => void) | null = null;
  return {
    host: container,
    surface: map.getCanvas(),
    project: (pos) => {
      const p = map.project(proj.toLonLat(pos));
      return { x: p.x, y: p.y };
    },
    onFrame: (cb) => {
      const on = () => {
        cb();
      };
      map.on('render', on);
      return () => {
        map.off('render', on);
      };
    },
    requestFrame: () => {
      map.triggerRepaint();
    },
    claimClick: () => {
      // MapLibre listens for `click` on its canvas container (bubbling): stop this press's click
      // on the way down, at the map container
      drop?.();
      const stop = (e: Event) => {
        e.stopPropagation();
        off();
      };
      // a press that sends no click must not swallow a later one: the next press or a moment
      // later drops the stop
      const off = () => {
        container.removeEventListener('click', stop, true);
        container.removeEventListener('pointerdown', off, true);
        clearTimeout(timer);
        if (drop === off) drop = null;
      };
      const timer = setTimeout(off, 400);
      container.addEventListener('click', stop, true);
      container.addEventListener('pointerdown', off, true);
      drop = off;
    },
    ...(busy ? { busy } : {}),
  };
}

type PanoOpenHandler = (layerId: string, id: string) => void;

let onPanoOpen: PanoOpenHandler | null = null;

/** The app opens a 360 clicked on the map. Unset: the workspace asks the 3D view to enter it. */
export function setMapPanoOpenHandler(h: PanoOpenHandler | null): void {
  onPanoOpen = h;
}

interface Placed<T> {
  layerId: string;
  item: T;
  pos: Vec3;
}

export interface MapMediaMarkersOptions {
  map: MapLibreMap;
  proj: FrameProjection;
  /** A project asset's URL. */
  url(src: AssetRef): string;
  /** Another tool owns the map's pointer now (a pick, a drawing): markers take no clicks. */
  busy?: () => boolean;
}

/** `aio://project/<id>/<path>` has its thumbnail at `aio://thumb/<id>/<path>`. */
const thumbOf = (full: string): string | undefined =>
  full.startsWith('aio://project/')
    ? full.replace(/^aio:\/\/project\//, 'aio://thumb/')
    : undefined;

/** The placed photos and 360s of the visible layers as map markers, one layer per kind. */
export class MapMediaMarkers {
  private photos: Placed<PhotoRef>[] = [];
  private panos: Placed<PanoRef>[] = [];
  private readonly photoSites: MarkerSite[] = [];
  private readonly panoSites: MarkerSite[] = [];
  private readonly photoSel = new Set<number>();
  private readonly panoSel = new Set<number>();
  private readonly photoLayer: MarkerLayer;
  private readonly panoLayer: MarkerLayer;
  private ws: Workspace | null = null;

  constructor(private readonly o: MapMediaMarkersOptions) {
    const view = mapMarkerView(o.map, o.proj, o.busy);
    this.photoLayer = new MarkerLayer({
      view,
      kind: 'photo',
      sites: this.photoSites,
      member: (i) => this.photoMember(i),
      open: (i, how) => {
        this.openPhoto(i, how?.split !== false);
      },
      selected: () => this.photoSel,
    });
    this.panoLayer = new MarkerLayer({
      view,
      kind: 'pano',
      sites: this.panoSites,
      member: (i) => this.panoMember(i),
      open: (i, how) => {
        this.openPano(i, how?.split !== false);
      },
      selected: () => this.panoSel,
    });
  }

  /** Redraw from the workspace (project, shown layers, corrections, selection). */
  update(s: Workspace): void {
    this.ws = s;
    const photos: Placed<PhotoRef>[] = [];
    const panos: Placed<PanoRef>[] = [];
    for (const l of s.project?.manifest.layers ?? []) {
      if (s.hidden[l.id]) continue;
      if (l.kind === 'photos') {
        for (const item of l.items) {
          const c = correctedPhoto(item, photoCorrection(s.orientation, l.id, item.id));
          if (c.pos) photos.push({ layerId: l.id, item, pos: c.pos });
        }
      } else if (l.kind === 'panoramas') {
        for (const item of l.items.filter(hasPos))
          panos.push({ layerId: l.id, item, pos: item.pos });
      }
    }
    this.photos = photos;
    this.panos = panos;
    this.photoSites.splice(0, Infinity, ...photos.map((p, i) => ({ pos: p.pos, members: [i] })));
    this.panoSites.splice(0, Infinity, ...panos.map((p, i) => ({ pos: p.pos, members: [i] })));
    const sel = s.selection;
    const mine = (list: Placed<PhotoRef | PanoRef>[], kind: 'photo' | 'pano', out: Set<number>) => {
      out.clear();
      if (sel?.kind !== kind) return;
      const i = list.findIndex(
        (p) => p.item.id === sel.id && (sel.layer === undefined || sel.layer === p.layerId),
      );
      if (i >= 0) out.add(i);
    };
    mine(photos, 'photo', this.photoSel);
    mine(panos, 'pano', this.panoSel);
    this.photoLayer.refresh();
    this.panoLayer.refresh();
  }

  /** The photo or 360 under a pointer (a merged plate: its first item), or null. */
  at(
    clientX: number,
    clientY: number,
  ): { kind: 'photo' | 'pano'; layerId: string; id: string } | null {
    const ph = this.photoLayer.memberAt(clientX, clientY);
    const p = ph ? this.photos[ph.index] : undefined;
    if (p) return { kind: 'photo', layerId: p.layerId, id: p.item.id };
    const pa = this.panoLayer.memberAt(clientX, clientY);
    const q = pa ? this.panos[pa.index] : undefined;
    return q ? { kind: 'pano', layerId: q.layerId, id: q.item.id } : null;
  }

  private photoMember(i: number): MarkerMember {
    const p = this.photos[i];
    if (!p) return { id: '' };
    const full = this.o.url(p.item.src);
    return { id: p.item.id, takenAt: p.item.takenAt, full, thumb: thumbOf(full) };
  }

  private panoMember(i: number): MarkerMember {
    const p = this.panos[i];
    if (!p) return { id: '' };
    const open = panoOpenable(p.item);
    const full = open ? this.o.url(p.item.src) : undefined;
    return {
      id: p.item.id,
      label: p.item.name,
      takenAt: p.item.capturedAt,
      status: panoMarkerStatus(p.item),
      full,
      thumb: full ? thumbOf(full) : undefined,
    };
  }

  /** A plain click opens the photo beside the map; a modified click (or no handler) selects it. */
  private openPhoto(i: number, plain: boolean): void {
    const p = this.photos[i];
    if (!p) return;
    const handler = plain ? photoMapClickHandler() : null;
    if (handler) handler({ kind: 'pin', layerId: p.layerId, photoId: p.item.id });
    else this.ws?.select({ kind: 'photo', id: p.item.id, layer: p.layerId });
  }

  /** A plain click enters the 360; a modified click selects it. */
  private openPano(i: number, plain: boolean): void {
    const p = this.panos[i];
    if (!p) return;
    if (!plain || !panoOpenable(p.item)) {
      this.ws?.select({ kind: 'pano', id: p.item.id, layer: p.layerId });
      return;
    }
    if (onPanoOpen) onPanoOpen(p.layerId, p.item.id);
    else this.ws?.openPano(p.layerId, p.item.id);
  }

  dispose(): void {
    this.photoLayer.dispose();
    this.panoLayer.dispose();
  }
}
