import type { AioBridge } from '@aio/schema';
import { useEffect, useRef, useState } from 'react';
import { MAP_SURFACE } from './ink';
import type { PickerController } from './picker';

export interface LocationPickerProps {
  className?: string;
  /** Called with [lon, lat] for each click on the map. */
  onPick: (lngLat: [number, number]) => void;
  /** Points to draw (numbered), e.g. the chosen origin or georeference targets. */
  points?: readonly [number, number][];
  /** Start view; default the most detailed installed pack. */
  center?: [number, number];
  zoom?: number;
}

type Status = 'loading' | 'ready' | 'no-packs' | 'error';

const MESSAGES: Record<Exclude<Status, 'ready'>, string> = {
  loading: 'Loading map',
  'no-packs': 'No map packs installed. Add a pack in Settings, Maps, or type the coordinates.',
  error: 'The map could not start.',
};

/** Offline map for picking a location with a click (wizard origin, georeference targets). */
export function LocationPicker({ className, onPick, points, center, zoom }: LocationPickerProps) {
  const ref = useRef<HTMLDivElement>(null);
  const ctl = useRef<PickerController | null>(null);
  const pick = useRef(onPick);
  const [status, setStatus] = useState<Status>('loading');
  useEffect(() => {
    pick.current = onPick;
  }, [onPick]);

  useEffect(() => {
    const el = ref.current;
    const aio = (globalThis as { aio?: AioBridge }).aio;
    if (!el || !aio) {
      setStatus('error');
      return;
    }
    const life: { disposed: boolean; observer: ResizeObserver | null } = {
      disposed: false,
      observer: null,
    };
    const gone = () => life.disposed;
    void (async () => {
      try {
        const packs = await aio.invoke('packs:list', {});
        if (gone()) return;
        if (!packs.length) {
          setStatus('no-packs');
          return;
        }
        const { createLocationPicker } = await import('./picker');
        if (gone()) return;
        const c = createLocationPicker(el, {
          packs,
          ...(center ? { center } : {}),
          ...(zoom !== undefined ? { zoom } : {}),
          onPick: (p) => {
            pick.current(p);
          },
        });
        ctl.current = c;
        life.observer = new ResizeObserver(() => {
          c.resize();
        });
        life.observer.observe(el);
        setStatus('ready');
      } catch (e) {
        console.error('Location map failed to start', e);
        if (!gone()) setStatus('error');
      }
    })();
    return () => {
      life.disposed = true;
      life.observer?.disconnect();
      ctl.current?.dispose();
      ctl.current = null;
    };
    // The start view is read once; later changes go through flyTo below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    ctl.current?.setPoints(points ?? []);
  }, [points, status]);

  return (
    <div
      className={['aio-map', className].filter(Boolean).join(' ')}
      dir="ltr"
      data-surface="dark"
      style={{ ...MAP_SURFACE, position: 'relative', minHeight: 0 }}
    >
      <div ref={ref} style={{ position: 'absolute', inset: 0 }} data-testid="location-picker" />
      {status !== 'ready' && (
        <div
          role="status"
          style={{
            position: 'absolute',
            inset: 0,
            display: 'grid',
            placeItems: 'center',
            padding: 16,
            textAlign: 'center',
            fontSize: 12,
          }}
        >
          {MESSAGES[status]}
        </div>
      )}
    </div>
  );
}
