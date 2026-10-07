import '@cesium/engine/Source/Widget/CesiumWidget.css';
import type { GlobeSite, RasterPackInfo, TilesetEntry } from '@aio/schema';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { GlobeCamera } from '../camera';
import type { SiteGeoref } from '../geodesy';
import { sitesBounds, type IssuePin } from '../sites';
import { GlobeController, type GlobePick } from './controller';
import type { GlobeTier } from './setup';

export interface GlobeIssuePins {
  projectId: string;
  georef: SiteGeoref;
  pins: readonly IssuePin[];
}

export interface GlobeTilesets {
  projectId: string;
  georef: SiteGeoref;
  entries: readonly TilesetEntry[];
}

export interface GlobeViewProps {
  /** Where the app serves its copy of Cesium's workers and assets (`<renderer>/cesium/`). */
  baseUrl: string;
  tier: GlobeTier;
  sites: readonly GlobeSite[];
  imagery: readonly RasterPackInfo[];
  terrain: readonly RasterPackInfo[];
  exaggeration: number;
  issuePins: GlobeIssuePins | null;
  /** The open project's 3D Tiles (`tilesets.json`). */
  tilesets: GlobeTilesets | null;
  /** Where to start: a remembered camera, a site to fly to, or every site. */
  start: { camera: GlobeCamera } | { site: readonly [number, number] } | null;
  reducedMotion: () => boolean;
  onPick: (pick: GlobePick | null) => void;
  /** The geodesic read-out is on: clicks put points instead of picking. */
  measuring: boolean;
  onMeasure?: (points: [number, number][]) => void;
  /** The credit lines of what is drawn, whenever they change. */
  onCredits?: (lines: string[]) => void;
  onReady?: (c: GlobeController) => void;
  /** The camera when the Globe closes, to come back to the same view. */
  onClose?: (camera: GlobeCamera) => void;
}

const NOWHERE: SiteGeoref = { crs: { epsg: 4326 }, origin: [0, 0, 0], heightOffset: 0 };

/**
 * The Globe in a React element. The CesiumWidget is built once per mount and destroyed with its
 * WebGL context on unmount; props update the scene in place.
 */
export function GlobeView(props: GlobeViewProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [ctl, setCtl] = useState<GlobeController | null>(null);
  const latest = useRef(props);
  useLayoutEffect(() => {
    latest.current = props;
  });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let live = true;
    let made: GlobeController | undefined;
    const p = latest.current;
    void GlobeController.create({
      container: el,
      baseUrl: p.baseUrl,
      tier: p.tier,
      reducedMotion: () => latest.current.reducedMotion(),
      onPick: (pick) => {
        latest.current.onPick(pick);
      },
      onCredits: (lines) => {
        latest.current.onCredits?.(lines);
      },
      onMeasure: (points) => {
        latest.current.onMeasure?.(points);
      },
    }).then((c) => {
      if (!live) {
        c.destroy();
        return;
      }
      made = c;
      Object.assign(el, { __aioGlobe: c });
      setCtl(c);
      const start = latest.current.start;
      if (start && 'camera' in start) c.setCamera(start.camera);
      else if (start && 'site' in start) void c.flyToSite(start.site);
      else c.flyHome(sitesBounds(latest.current.sites));
      latest.current.onReady?.(c);
    });
    return () => {
      live = false;
      Reflect.deleteProperty(el, '__aioGlobe');
      if (made) {
        latest.current.onClose?.(made.camera());
        made.destroy();
      }
    };
    // the widget is built once per mount; the tier and base URL are read at creation
  }, []);

  useEffect(() => {
    ctl?.setSites(props.sites);
  }, [ctl, props.sites]);
  useEffect(() => {
    ctl?.setPacks(props.imagery, props.terrain);
  }, [ctl, props.imagery, props.terrain]);
  useEffect(() => {
    ctl?.setExaggeration(props.exaggeration);
  }, [ctl, props.exaggeration]);
  useEffect(() => {
    const ip = props.issuePins;
    if (!ctl) return;
    if (ip) ctl.setIssuePins(ip.projectId, ip.georef, ip.pins);
    else ctl.setIssuePins('', NOWHERE, []);
  }, [ctl, props.issuePins]);

  useEffect(() => {
    ctl?.setMeasuring(props.measuring);
  }, [ctl, props.measuring]);
  useEffect(() => {
    const ts = props.tilesets;
    if (!ctl) return;
    void ctl.setTilesets(ts?.projectId ?? '', ts?.georef ?? NOWHERE, ts?.entries ?? []);
  }, [ctl, props.tilesets]);

  return <div ref={ref} className="aio-globe" data-testid="globe-canvas" />;
}
