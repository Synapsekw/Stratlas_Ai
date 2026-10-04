import type { AioBridge } from '@aio/schema';
import { workspace } from '@aio/workspace';
import { useEffect, useRef, useState } from 'react';
import { setActiveMap } from './capture';
import type { MapController } from './controller';
import type { MapDrawSeam } from './draw';
import { ALL_ISSUES, type MapIssueDisplay } from './overlays';

export interface MapViewProps {
  className?: string;
  /** Show the project's flight paths and video footprint (default true). */
  showFlights?: boolean;
  /** Drawing on the map (map sightings): clicks, double click and a preview of the shape. */
  draw?: MapDrawSeam;
  /** Issue markers: pins filter and heat map (default: every issue, clustered). */
  issues?: MapIssueDisplay;
}

type Status = 'loading' | 'ready' | 'no-packs' | 'error';

const MESSAGES: Record<Exclude<Status, 'ready'>, string> = {
  loading: 'Loading map',
  'no-packs': 'No map packs installed. Add a pack in Settings, Maps.',
  error: 'The map could not start. See the log for details.',
};

function bridge(): AioBridge | undefined {
  return (globalThis as { aio?: AioBridge }).aio;
}

/**
 * Offline 2D map (MapLibre + PMTiles packs over aio://) with project rasters, flight paths and the
 * live video footprint, sharing selection and playhead through @aio/workspace. Owner: stream S5.
 */
export function MapView({ className, showFlights = true, draw, issues }: MapViewProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<Status>('loading');
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
    setStatus('loading');
    void (async () => {
      try {
        const packs = await aio.invoke('packs:list', {});
        if (gone()) return;
        if (!packs.length) {
          setStatus('no-packs');
          return;
        }
        // MapLibre loads lazily so @aio/maps stays importable without a DOM or WebGL.
        const { createMapController } = await import('./controller');
        if (gone()) return;
        const ctl = createMapController(el, {
          packs,
          store: workspace,
          showFlights,
          draw: () => drawRef.current,
          issues: () => issuesRef.current,
        });
        life.ctl = ctl;
        ctlRef.current = ctl;
        setActiveMap(ctl);
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
      if (life.ctl) setActiveMap(null);
      life.observer?.disconnect();
      life.ctl?.dispose();
    };
  }, [showFlights]);

  return (
    <div className={className} style={{ position: 'relative', minHeight: 0 }} aria-label="Map">
      <div ref={ref} style={{ position: 'absolute', inset: 0 }} />
      {status !== 'ready' && (
        <div
          role="status"
          style={{
            position: 'absolute',
            inset: 0,
            display: 'grid',
            placeItems: 'center',
            color: 'var(--fg-2)',
            font: 'var(--t-13) var(--f-ui)',
            pointerEvents: 'none',
          }}
        >
          {MESSAGES[status]}
        </div>
      )}
    </div>
  );
}
