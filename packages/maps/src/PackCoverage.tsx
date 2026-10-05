import { useEffect, useRef, useState } from 'react';
import type { CoverageMap } from './coverageMap';
import { MAP_SURFACE } from './ink';
import type { Bbox, MapPack } from './packs';

export interface PackCoverageProps {
  packs: readonly MapPack[];
  /** Pack outlined in the accent colour. */
  highlight?: string | null;
  /** The region being added, dashed. */
  draft?: Bbox | null;
  /** Drag on the map to draw a box (calls onDraw); panning is off meanwhile. */
  drawing?: boolean;
  onDraw?: (bbox: Bbox) => void;
  /** Fly to this box when it changes. */
  focus?: Bbox | null;
  className?: string;
}

/**
 * Small world map of the installed packs (Settings, Maps): regional packs outlined, the
 * highlighted one in the accent colour, a draft region dashed, and drag-to-draw for a new
 * region. Uses the installed packs themselves, so it works offline.
 */
export function PackCoverage({
  packs,
  highlight = null,
  draft = null,
  drawing = false,
  onDraw,
  focus = null,
  className,
}: PackCoverageProps) {
  const ref = useRef<HTMLDivElement>(null);
  const ctl = useRef<CoverageMap | null>(null);
  const onDrawRef = useRef(onDraw);
  const [failed, setFailed] = useState(false);
  const stateRef = useRef({ packs, highlight, draft, drawing });

  useEffect(() => {
    onDrawRef.current = onDraw;
    stateRef.current = { packs, highlight, draft, drawing };
  });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let disposed = false;
    let observer: ResizeObserver | null = null;
    void import('./coverageMap')
      .then(({ createCoverageMap }) => {
        if (disposed) return;
        const map = createCoverageMap(el, stateRef.current, (box) => {
          onDrawRef.current?.(box);
        });
        ctl.current = map;
        observer = new ResizeObserver(() => {
          map.resize();
        });
        observer.observe(el);
      })
      .catch((e: unknown) => {
        console.error('Coverage map failed to start', e);
        if (!disposed) setFailed(true);
      });
    return () => {
      disposed = true;
      observer?.disconnect();
      ctl.current?.dispose();
      ctl.current = null;
    };
  }, []);

  useEffect(() => {
    ctl.current?.update({ packs, highlight, draft, drawing });
  }, [packs, highlight, draft, drawing]);

  useEffect(() => {
    if (focus) ctl.current?.fit(focus);
  }, [focus]);

  return (
    <div
      className={['aio-map', className].filter(Boolean).join(' ')}
      dir="ltr"
      data-surface="dark"
      style={{ ...MAP_SURFACE, position: 'relative', minHeight: 0 }}
      aria-label="Map pack coverage"
      data-testid="pack-coverage"
    >
      <div ref={ref} style={{ position: 'absolute', inset: 0 }} />
      {failed && (
        <div
          role="status"
          style={{
            position: 'absolute',
            inset: 0,
            display: 'grid',
            placeItems: 'center',
            font: 'var(--t-12) var(--f-ui)',
          }}
        >
          The coverage map could not start.
        </div>
      )}
    </div>
  );
}
