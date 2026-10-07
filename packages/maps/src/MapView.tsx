import type { AioBridge } from '@aio/schema';
import { workspace, type Workspace } from '@aio/workspace';
import { useEffect, useRef, useState } from 'react';
import type { StoreApi } from 'zustand/vanilla';
import { setActiveMap } from './capture';
import { MAP_SURFACE } from './ink';
import type { IssueColorBy, MapController } from './controller';
import type { MapDrawSeam } from './draw';
import { ALL_ISSUES, type MapIssueDisplay } from './overlays';
import type { MapOverlay } from './vector';

export interface MapViewProps {
  className?: string;
  /** Show the project's flight paths and video footprint (default true). */
  showFlights?: boolean;
  /** Drawing on the map (map sightings): clicks, double click and a preview of the shape. */
  draw?: MapDrawSeam;
  /** Issue markers: pins filter and heat map (default: every issue, clustered). */
  issues?: MapIssueDisplay;
  /** GeoJSON overlays drawn under the issues (road centreline, PCI units, density cells). */
  overlays?: readonly MapOverlay[];
  /** Show only these issues (default: all). */
  issueFilter?: ReadonlySet<string> | null;
  /** Colour issues by their severity (default) or by their class. */
  issueColorBy?: IssueColorBy;
  /** Show the 3D camera's view wedge (default true). */
  cameraWedge?: boolean;
  /**
   * The workspace the map follows (default: the app's). A map of one survey date passes a scoped
   * view of it (`scopedStore`). Read when the map starts.
   */
  store?: StoreApi<Workspace>;
  /** The map frame capture and the agent use this map (default true); a second map passes false. */
  primary?: boolean;
  /** Called with the controller once the map runs and with null when it goes (linked views). */
  onController?: (controller: MapController | null) => void;
}

type Status = 'loading' | 'ready' | 'error';

const MESSAGES: Record<Exclude<Status, 'ready'>, string> = {
  loading: 'Loading map',
  error: 'The map could not start. See the log for details.',
};

/**
 * MapLibre loads lazily so @aio/maps stays importable without a DOM or WebGL. Module level on
 * purpose: Vite's preload keeps the loader closure in a stylesheet's load listener for good, and a
 * closure made inside a map's start would keep that map (and its detached DOM) alive with it.
 */
const loadController = () => import('./controller');

function bridge(): AioBridge | undefined {
  return (globalThis as { aio?: AioBridge }).aio;
}

/**
 * Offline 2D map (MapLibre + PMTiles packs over aio://) with project rasters, flight paths and the
 * live video footprint, sharing selection and playhead through @aio/workspace. Owner: stream S5.
 */
export function MapView({
  className,
  showFlights = true,
  draw,
  issues,
  overlays,
  issueFilter = null,
  issueColorBy = 'severity',
  cameraWedge = true,
  store,
  primary = true,
  onController,
}: MapViewProps) {
  const ref = useRef<HTMLDivElement>(null);
  // read when the map starts; later changes do not restart it
  const init = useRef({ store, primary, onController });
  useEffect(() => {
    init.current.onController = onController;
  }, [onController]);
  const [status, setStatus] = useState<Status>('loading');
  const [noPacks, setNoPacks] = useState(false);
  // The controller reads the latest seam on each click.
  const drawRef = useRef<MapDrawSeam | null>(draw ?? null);
  const ctlRef = useRef<MapController | null>(null);
  const issuesRef = useRef<MapIssueDisplay>(issues ?? ALL_ISSUES);
  useEffect(() => {
    issuesRef.current = issues ?? ALL_ISSUES;
    ctlRef.current?.updateIssues();
  }, [issues, issues?.show, issues?.minSeverity, issues?.heat]);
  useEffect(() => {
    drawRef.current = draw ?? null;
    ctlRef.current?.updateDraw();
  }, [draw, draw?.mode, draw?.vertices]);
  // Overlays, filter and colouring, applied when the map starts and on change.
  const [started, setStarted] = useState(0);
  useEffect(() => {
    ctlRef.current?.setOverlays(overlays ?? []);
  }, [overlays, started]);
  useEffect(() => {
    ctlRef.current?.setIssueFilter(issueFilter);
  }, [issueFilter, started]);
  useEffect(() => {
    ctlRef.current?.setIssueColor(issueColorBy);
  }, [issueColorBy, started]);
  useEffect(() => {
    ctlRef.current?.setCameraWedge(cameraWedge);
  }, [cameraWedge, started]);

  useEffect(() => {
    const el = ref.current;
    const aio = bridge();
    if (!el || !aio) {
      setStatus('error');
      return;
    }
    // Mutable holder: the async start below must see the cleanup's writes.
    const life: { disposed: boolean; ctl: MapController | null; observer: ResizeObserver | null } =
      { disposed: false, ctl: null, observer: null };
    const gone = () => life.disposed;
    // one object for the map's life; its onController follows the latest prop
    const cfg = init.current;
    setStatus('loading');
    void (async () => {
      try {
        const packs = await aio.invoke('packs:list', {});
        if (gone()) return;
        // Without a pack the map still runs: the project's own rasters, overlays and issues draw
        // on an empty background (a first start, the demo project).
        setNoPacks(packs.length === 0);
        const { createMapController } = await loadController();
        if (gone()) return;
        const ctl = createMapController(el, {
          packs,
          store: cfg.store ?? workspace,
          showFlights,
          draw: () => drawRef.current,
          issues: () => issuesRef.current,
        });
        life.ctl = ctl;
        ctlRef.current = ctl;
        if (cfg.primary) setActiveMap(ctl);
        cfg.onController?.(ctl);
        setStarted((n) => n + 1);
        life.observer = new ResizeObserver(() => {
          ctl.resize();
        });
        life.observer.observe(el);
        setStatus('ready');
      } catch (e) {
        console.error('Map failed to start', e);
        if (!gone()) setStatus('error');
      }
    })();
    return () => {
      life.disposed = true;
      ctlRef.current = null;
      if (life.ctl) {
        cfg.onController?.(null);
        if (cfg.primary) setActiveMap(null);
      }
      life.observer?.disconnect();
      life.ctl?.dispose();
    };
  }, [showFlights]);

  return (
    <div
      className={['aio-map', className].filter(Boolean).join(' ')}
      // Geographic content keeps left-to-right layout in a right-to-left UI.
      dir="ltr"
      data-surface="dark"
      style={{ ...MAP_SURFACE, position: 'relative', minHeight: 0 }}
      aria-label="Map"
    >
      <div ref={ref} style={{ position: 'absolute', inset: 0 }} />
      {status !== 'ready' && (
        <div
          role="status"
          style={{
            position: 'absolute',
            inset: 0,
            display: 'grid',
            placeItems: 'center',
            font: 'var(--t-13) var(--f-ui)',
            pointerEvents: 'none',
          }}
        >
          {MESSAGES[status]}
        </div>
      )}
      {status === 'ready' && noPacks && (
        <div
          role="note"
          data-testid="map-no-packs"
          style={{
            position: 'absolute',
            bottom: 8,
            left: '50%',
            transform: 'translateX(-50%)',
            whiteSpace: 'nowrap',
            padding: '4px 8px',
            borderRadius: 4,
            background: 'var(--scrim)',
            color: 'var(--fg-2)',
            font: 'var(--t-12) var(--f-ui)',
            pointerEvents: 'none',
          }}
        >
          No map pack installed: project layers only. Add a pack in Settings, Offline maps.
        </div>
      )}
    </div>
  );
}
