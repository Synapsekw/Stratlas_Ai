import { useWorkspace } from '@aio/workspace';
import { useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { chainageBins, pciRating } from './model';
import { setFilter, useRoad } from './store';
import { jumpToKm } from './useRoadMap';

const BIN_KM = 0.25;
const PAD = 14;

/**
 * The bottom strip of the road workspace, in place of the timeline: chainage along the road with
 * defect counts per 250 m by severity and the PCI of each section. Click to jump the map along the
 * road; drag to filter the defects to a chainage range.
 */
export function ChainageRuler() {
  const road = useRoad((s) => s.road);
  const rows = useRoad((s) => s.rows);
  const range = useRoad((s) => s.filter.kmRange);
  const sev = useRoad((s) => s.pciSeverity);
  const manifest = useWorkspace((s) => s.project?.manifest);
  const selectedId = useWorkspace((s) => (s.selection?.kind === 'issue' ? s.selection.id : null));
  const ref = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const [drag, setDrag] = useState<{ from: number; to: number } | null>(null);
  const down = useRef<{ x: number; km: number } | null>(null);

  const lengthKm = road?.centreline.lengthKm ?? 0;
  const bins = useMemo(() => chainageBins(rows, lengthKm, BIN_KM), [rows, lengthKm]);
  const max = Math.max(1, ...bins.map((b) => b.total));
  const levels = useMemo(() => {
    const model = manifest?.severityModels[0];
    return [...(model?.levels ?? [])].sort((a, b) => a.value - b.value);
  }, [manifest]);
  const selected = rows.find((r) => r.id === selectedId);

  if (!road) return null;
  const pct = (km: number) => `${(km / lengthKm) * 100}%`;
  const kmAt = (clientX: number) => {
    const el = ref.current;
    if (!el) return 0;
    const r = el.getBoundingClientRect();
    const k = ((clientX - r.left) / Math.max(1, r.width)) * lengthKm;
    return Math.min(lengthKm, Math.max(0, k));
  };

  const onDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    down.current = { x: e.clientX, km: kmAt(e.clientX) };
  };
  const onMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const k = kmAt(e.clientX);
    setHover(k);
    const d = down.current;
    if (d && Math.abs(e.clientX - d.x) > 4) setDrag({ from: d.km, to: k });
  };
  const onUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = down.current;
    down.current = null;
    if (!d) return;
    if (drag) {
      const a = Math.min(drag.from, drag.to);
      const b = Math.max(drag.from, drag.to);
      setFilter({ kmRange: [a, b] });
      setDrag(null);
      jumpToKm((a + b) / 2, Math.max(160, (b - a) * 1000 * 1.1));
    } else {
      jumpToKm(kmAt(e.clientX));
    }
  };

  const ticks: number[] = [];
  for (let k = 0; k <= lengthKm + 1e-9; k += 0.5) ticks.push(k);
  const shown = drag
    ? ([Math.min(drag.from, drag.to), Math.max(drag.from, drag.to)] as const)
    : range;
  const sections = road.pci.sections;

  return (
    <div className="rr-ruler" aria-label="Chainage">
      <div className="rr-ruler-h">
        <b>Chainage</b>
        <span className="mono faint">
          0 to {lengthKm.toFixed(2)} km · {BIN_KM * 1000} m bins
        </span>
        <span className="rr-sp" />
        {hover !== null && <span className="mono">km {hover.toFixed(3)}</span>}
        {range ? (
          <span className="rr-range">
            <span className="mono">
              km {range[0].toFixed(2)} to {range[1].toFixed(2)}
            </span>
            <button
              type="button"
              className="btn sm ghost"
              onClick={() => {
                setFilter({ kmRange: null });
              }}
            >
              Clear range
            </button>
          </span>
        ) : (
          <span className="faint">Click to go there, drag to filter a range</span>
        )}
      </div>
      <div
        className="rr-track"
        ref={ref}
        role="slider"
        aria-label="Chainage, km"
        aria-valuemin={0}
        aria-valuemax={lengthKm}
        aria-valuenow={selected?.km ?? 0}
        tabIndex={0}
        style={{ marginInline: PAD }}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerLeave={() => {
          setHover(null);
        }}
        onKeyDown={(e) => {
          const step = e.shiftKey ? 0.5 : 0.1;
          const now = selected?.km ?? hover ?? 0;
          if (e.key === 'ArrowRight') jumpToKm(Math.min(lengthKm, now + step));
          else if (e.key === 'ArrowLeft') jumpToKm(Math.max(0, now - step));
          else return;
          e.preventDefault();
        }}
      >
        <div className="rr-bars">
          {bins.map((b) => (
            <div
              key={b.fromKm}
              className="rr-bin"
              style={{ left: pct(b.fromKm), width: pct(b.toKm - b.fromKm) }}
              title={`km ${b.fromKm.toFixed(2)} to ${b.toKm.toFixed(2)}: ${b.total} defects`}
            >
              {[...levels].reverse().map((l) => {
                const n = b.bySeverity[l.value] ?? 0;
                return n ? (
                  <i key={l.value} style={{ height: `${(n / max) * 100}%`, background: l.color }} />
                ) : null;
              })}
            </div>
          ))}
        </div>
        <div className="rr-pci" aria-label="PCI by section">
          {sections.map((s) => {
            const v = s.pci[sev];
            const rating = pciRating(road.pci.ratings, v);
            return (
              <i
                key={s.fromKm}
                style={{
                  left: pct(s.fromKm),
                  width: pct(Math.min(lengthKm, s.toKm) - s.fromKm),
                  background: rating?.color ?? 'transparent',
                }}
                title={`km ${s.fromKm.toFixed(2)}: PCI ${v === null ? 'n/a' : Math.round(v)}${rating ? ` ${rating.label}` : ''}`}
              />
            );
          })}
        </div>
        <div className="rr-axis">
          {ticks.map((k) => (
            <span key={k} style={{ left: pct(k) }}>
              {Number.isInteger(k) ? `km ${k}` : ''}
            </span>
          ))}
        </div>
        {shown && (
          <div
            className="rr-sel-range"
            style={{ left: pct(shown[0]), width: pct(shown[1] - shown[0]) }}
          />
        )}
        {selected && <div className="rr-mark" style={{ left: pct(selected.km) }} />}
        {hover !== null && <div className="rr-hover" style={{ left: pct(hover) }} />}
      </div>
    </div>
  );
}
