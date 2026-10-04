import { PhotoViewer } from '@aio/annotate';
import { Icon } from '@aio/ui';
import { useWorkspace, workspace } from '@aio/workspace';
import { useEffect, useMemo } from 'react';
import { isTyping } from '../keys';
import { shell } from '../shell';
import { PopTool, Tool } from '../workspace/StageTools';
import { pciRating } from './model';
import { densityLegend } from './overlays';
import { roadStore, setRoad, useRoad, type MeasureMode } from './store';
import { focusDefect, measureText, useFilteredDefects } from './useRoadMap';

const SIZES = ['10', '20', '50'];

function RoadLayers() {
  const centreline = useRoad((s) => s.centreline);
  const overlay = useRoad((s) => s.overlay);
  const sev = useRoad((s) => s.pciSeverity);
  const size = useRoad((s) => s.densitySize);
  const measure = useRoad((s) => s.densityMeasure);
  const opacity = useRoad((s) => s.opacity);
  const colorBy = useRoad((s) => s.colorBy);
  const road = useRoad((s) => s.road);
  const sizes = Object.keys(road?.density.sizes ?? {});
  // joined ids: a stable selector value
  const orthoIds = useWorkspace((s) =>
    (s.project?.manifest.layers ?? [])
      .filter((l) => l.kind === 'raster')
      .map((l) => l.id)
      .join('|'),
  );
  const ortho = orthoIds ? orthoIds.split('|') : [];
  const orthoOn = useWorkspace((s) => ortho.some((id) => !s.hidden[id]));
  return (
    <div className="pop-form rr-layers">
      <label className="pop-row">
        <span className="pop-grow">Orthomosaic</span>
        <input
          type="checkbox"
          checked={orthoOn}
          onChange={() => {
            for (const id of ortho) workspace.getState().setLayerVisible(id, !orthoOn);
          }}
        />
      </label>
      <label className="pop-row">
        <span className="pop-grow">Centreline and chainage</span>
        <input
          type="checkbox"
          checked={centreline}
          onChange={() => {
            setRoad({ centreline: !centreline });
          }}
        />
      </label>
      <div className="rr-pop-h">Defects coloured by</div>
      <div className="seg pop-seg" role="group" aria-label="Colour defects by">
        {(['severity', 'class'] as const).map((k) => (
          <button
            key={k}
            type="button"
            aria-pressed={colorBy === k}
            onClick={() => {
              setRoad({ colorBy: k });
            }}
          >
            {k === 'severity' ? 'Severity' : 'Type'}
          </button>
        ))}
      </div>
      <div className="rr-pop-h">Area overlay</div>
      <div className="seg pop-seg" role="group" aria-label="Area overlay">
        {(
          [
            ['none', 'None'],
            ['pci', 'PCI grid'],
            ['density', 'Density'],
          ] as const
        ).map(([k, label]) => (
          <button
            key={k}
            type="button"
            aria-pressed={overlay === k}
            onClick={() => {
              setRoad({ overlay: k });
            }}
          >
            {label}
          </button>
        ))}
      </div>
      {overlay === 'pci' && (
        <>
          <div className="rr-pop-h">Severity assumed</div>
          <div className="seg pop-seg" role="group" aria-label="PCI severity assumed">
            {(['low', 'medium', 'high'] as const).map((k) => (
              <button
                key={k}
                type="button"
                aria-pressed={sev === k}
                onClick={() => {
                  setRoad({ pciSeverity: k });
                }}
              >
                {k[0]?.toUpperCase()}
                {k.slice(1)}
              </button>
            ))}
          </div>
        </>
      )}
      {overlay === 'density' && (
        <>
          <div className="rr-pop-h">Cell size</div>
          <div className="seg pop-seg" role="group" aria-label="Density cell size">
            {SIZES.filter((s) => sizes.includes(s)).map((s) => (
              <button
                key={s}
                type="button"
                aria-pressed={size === s}
                onClick={() => {
                  setRoad({ densitySize: s });
                }}
              >
                {s} m
              </button>
            ))}
          </div>
          <div className="seg pop-seg" role="group" aria-label="Density measure">
            {(
              [
                ['count', 'Defect count'],
                ['pct', '% of pavement'],
              ] as const
            ).map(([k, label]) => (
              <button
                key={k}
                type="button"
                aria-pressed={measure === k}
                onClick={() => {
                  setRoad({ densityMeasure: k });
                }}
              >
                {label}
              </button>
            ))}
          </div>
        </>
      )}
      {overlay !== 'none' && (
        <label className="pop-row">
          <span className="pop-grow">Opacity</span>
          <input
            type="range"
            min={20}
            max={95}
            value={Math.round(opacity * 100)}
            aria-label="Overlay opacity"
            onChange={(e) => {
              setRoad({ opacity: Number(e.target.value) / 100 });
            }}
          />
        </label>
      )}
    </div>
  );
}

export function toggleMeasure(mode: MeasureMode = 'line'): void {
  const m = roadStore.getState().measure;
  setRoad({ measure: m.mode ? { mode: null, vertices: [] } : { mode, vertices: [] } });
}

/** The road group on the stage toolbar (map and split): road layers, overlays and measure. */
export function RoadToolGroup() {
  const overlay = useRoad((s) => s.overlay);
  const measuring = useRoad((s) => s.measure.mode !== null);
  const closeup = useRoad((s) => s.closeup);
  return (
    <>
      <Tool
        icon="photo"
        label="Close-up of the selected defect"
        keys="C"
        pressed={closeup}
        onClick={() => {
          setRoad({ closeup: !closeup });
        }}
      />
      <PopTool icon="road" label="Road layers" pressed={overlay !== 'none'} wide>
        <RoadLayers />
      </PopTool>
      <Tool
        icon="filter"
        label="PCI grid"
        keys="P"
        pressed={overlay === 'pci'}
        onClick={() => {
          setRoad({ overlay: overlay === 'pci' ? 'none' : 'pci' });
        }}
      />
      <Tool
        icon="raster"
        label="Defect density"
        keys="D"
        pressed={overlay === 'density'}
        onClick={() => {
          setRoad({ overlay: overlay === 'density' ? 'none' : 'density' });
        }}
      />
      <Tool
        icon="ruler"
        label="Measure on the map"
        keys="M"
        pressed={measuring}
        onClick={() => {
          toggleMeasure();
        }}
      />
    </>
  );
}

/** The measure readout under the stage toolbar while measuring on the map. */
export function MeasureBar() {
  const m = useRoad((s) => s.measure);
  if (!m.mode) return null;
  const value = measureText(m.mode, m.vertices);
  return (
    <div className="ann-subbar overlay-box rr-measure" role="group" aria-label="Measure">
      <div className="seg" role="group" aria-label="Measure mode">
        {(
          [
            ['line', 'Distance'],
            ['polygon', 'Area'],
          ] as const
        ).map(([k, label]) => (
          <button
            key={k}
            type="button"
            aria-pressed={m.mode === k}
            onClick={() => {
              setRoad({ measure: { mode: k, vertices: m.vertices } });
            }}
          >
            {label}
          </button>
        ))}
      </div>
      <span className="mono rr-measure-v" data-testid="measure-value">
        {value ?? (m.mode === 'line' ? 'Click two or more points' : 'Click three or more points')}
      </span>
      <button
        type="button"
        className="btn sm ghost"
        disabled={!m.vertices.length}
        onClick={() => {
          setRoad({ measure: { mode: m.mode, vertices: [] } });
        }}
      >
        Clear
      </button>
      <button
        type="button"
        className="btn sm"
        onClick={() => {
          setRoad({ measure: { mode: null, vertices: [] } });
        }}
      >
        Done
      </button>
    </div>
  );
}

/** Legend of the area overlay, bottom left of the map. */
export function RoadLegend() {
  const road = useRoad((s) => s.road);
  const overlay = useRoad((s) => s.overlay);
  const sev = useRoad((s) => s.pciSeverity);
  const size = useRoad((s) => s.densitySize);
  const measure = useRoad((s) => s.densityMeasure);
  const legend = useMemo(
    () => (road && overlay === 'density' ? densityLegend(road, size, measure) : []),
    [road, overlay, size, measure],
  );
  if (!road || overlay === 'none') return null;
  if (overlay === 'pci') {
    const v = road.pci.network[sev];
    const rating = pciRating(road.pci.ratings, v);
    return (
      <div className="rr-legend overlay-box" aria-label="PCI legend">
        <b>
          PCI · {road.pci.standard} · {sev[0]?.toUpperCase()}
          {sev.slice(1)} severity
        </b>
        {road.pci.ratings.map((r, i) => {
          const upper = road.pci.ratings[i - 1]?.min;
          return (
            <span key={r.label} className="rr-leg-row">
              <i style={{ background: r.color }} />
              {r.label}
              <span className="mono faint">
                {upper === undefined ? `${r.min} to 100` : `${r.min} to ${upper - 1}`}
              </span>
            </span>
          );
        })}
        <span className="faint">
          Network PCI {v === null ? 'n/a' : Math.round(v)}
          {rating ? ` · ${rating.label}` : ''}
        </span>
      </div>
    );
  }
  return (
    <div className="rr-legend overlay-box" aria-label="Density legend">
      <b>Defect density · {size} m cells</b>
      {legend.map((l) => (
        <span key={l.from} className="rr-leg-row">
          <i style={{ background: l.color }} />
          <span className="mono">
            {l.to === null ? `${l.from}+` : `${l.from} to ${l.to}`}
            {measure === 'pct' ? '%' : ''}
          </span>
        </span>
      ))}
      <span className="faint">{measure === 'pct' ? '% of pavement' : 'defects per cell'}</span>
    </div>
  );
}

const humanize = (key: string) => {
  const t = key.replace(/_/g, ' ');
  return (t[0]?.toUpperCase() ?? '') + t.slice(1);
};

/** The PCI sample unit clicked on the map: its PCI under each severity and its deducts. */
export function PciUnitCard() {
  const road = useRoad((s) => s.road);
  const id = useRoad((s) => s.pciUnit);
  const overlay = useRoad((s) => s.overlay);
  const unit = useMemo(() => road?.pci.units.find((u) => u.id === id), [road, id]);
  if (!road || !unit || overlay !== 'pci') return null;
  return (
    <div className="rr-unit overlay-box" aria-label="PCI sample unit">
      <header>
        <b>Sample unit {unit.id}</b>
        <span className="rr-sp" />
        <button
          type="button"
          className="tool"
          aria-label="Close the sample unit"
          onClick={() => {
            setRoad({ pciUnit: null });
          }}
        >
          <Icon name="x" size={14} />
        </button>
      </header>
      <span className="faint">
        km {unit.km.toFixed(3)} · {unit.pavementM2.toFixed(1)} m² of pavement
      </span>
      <div className="rr-unit-pci">
        {(['low', 'medium', 'high'] as const).map((k) => {
          const v = unit.pci[k];
          const r = pciRating(road.pci.ratings, v);
          return (
            <div key={k}>
              <b className="mono" style={{ color: r?.color }}>
                {v === null ? 'n/a' : Math.round(v)}
              </b>
              <span>
                {k[0]?.toUpperCase()}
                {k.slice(1)}
              </span>
            </div>
          );
        })}
      </div>
      {unit.deducts.length ? (
        <table className="rr-unit-t">
          <thead>
            <tr>
              <th>Distress ({road.pci.headline} severity)</th>
              <th>Density</th>
              <th>Deduct</th>
            </tr>
          </thead>
          <tbody>
            {unit.deducts.map((d) => (
              <tr key={d.distress}>
                <td>{humanize(d.distress)}</td>
                <td className="mono">{d.densityPct.toFixed(2)}%</td>
                <td className="mono">{d.deduct.toFixed(1)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <span className="faint">No distresses mapped in this unit.</span>
      )}
    </div>
  );
}

/** The close-up of the selected defect with its outline, docked beside the map. */
export function CloseupDock() {
  const rows = useFilteredDefects();
  const all = useRoad((s) => s.rows);
  const id = useWorkspace((s) => (s.selection?.kind === 'issue' ? s.selection.id : null));
  const row = all.find((r) => r.id === id);
  const index = rows.findIndex((r) => r.id === id);
  if (!row?.photo) return null;
  const step = (d: number) => {
    if (!rows.length) return;
    const next = rows[(index + d + rows.length) % rows.length];
    if (next) focusDefect(next);
  };
  return (
    <aside className="pane rr-closeup" aria-label="Close-up">
      <header className="rr-cu-h">
        <i className="rr-sevbar" style={{ background: row.severityColor }} />
        <div className="rr-cu-t">
          <b>
            <span className="mono">{row.code}</span> · {row.classLabel}
          </b>
          <span>
            {row.severityLabel} · km {row.km.toFixed(3)}
            {row.areaM2 !== null && ` · ${row.areaM2.toFixed(2)} m²`}
            {row.extentM !== null && ` · ${row.extentM.toFixed(1)} m extent`}
          </span>
        </div>
        <span className="rr-sp" />
        <button
          type="button"
          className="tool"
          aria-label="Previous defect"
          onClick={() => {
            step(-1);
          }}
        >
          <Icon name="back" />
        </button>
        <span className="mono faint">
          {index >= 0 ? index + 1 : '-'} / {rows.length}
        </span>
        <button
          type="button"
          className="tool"
          aria-label="Next defect"
          onClick={() => {
            step(1);
          }}
        >
          <Icon name="fwd" />
        </button>
        <button
          type="button"
          className="tool"
          aria-label="Close the close-up"
          onClick={() => {
            setRoad({ closeup: false });
          }}
        >
          <Icon name="x" />
        </button>
      </header>
      <PhotoViewer
        layerId={row.photo.layer}
        photoId={row.photo.photo}
        className="rr-cu-view"
        editOutlines={false}
      />
    </aside>
  );
}

/**
 * Road keys on the stage: P PCI grid, D density, M measure and C close-up on the map, Left and
 * Right step through the filtered defects. They run before the stage's own keys.
 */
export function useRoadKeys(active: boolean): void {
  const rows = useFilteredDefects();
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
      if (isTyping(e.target)) return;
      const k = e.key.toLowerCase();
      // the ruler uses the arrows itself, the list up and down
      const el = e.target instanceof HTMLElement ? e.target : null;
      if (el?.closest('.rr-track') && k.startsWith('arrow')) return;
      if (el?.closest('.rr-list') && (k === 'arrowup' || k === 'arrowdown')) return;
      const s = roadStore.getState();
      const onMap = shell.getState().stageMode !== '3d';
      if (k === 'p') setRoad({ overlay: s.overlay === 'pci' ? 'none' : 'pci' });
      else if (k === 'c' && onMap) setRoad({ closeup: !s.closeup });
      else if (k === 'd') setRoad({ overlay: s.overlay === 'density' ? 'none' : 'density' });
      else if (k === 'm' && onMap) toggleMeasure();
      else if (k === 'escape' && s.measure.mode) setRoad({ measure: { mode: null, vertices: [] } });
      else if (k === 'backspace' && s.measure.mode)
        setRoad({ measure: { mode: s.measure.mode, vertices: s.measure.vertices.slice(0, -1) } });
      else if ((k === 'arrowright' || k === 'arrowleft') && rows.length) {
        const sel = workspace.getState().selection;
        const i = sel?.kind === 'issue' ? rows.findIndex((r) => r.id === sel.id) : -1;
        const d = k === 'arrowright' ? 1 : -1;
        const next = rows[i < 0 ? 0 : (i + d + rows.length) % rows.length];
        if (next) focusDefect(next);
      } else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [active, rows]);
}
