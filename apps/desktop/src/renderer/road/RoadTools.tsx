import { PhotoViewer } from '@aio/annotate';
import { frameProjection } from '@aio/maps';
import type { SurveyMeasurement } from '@aio/schema';
import { Button, Icon, isShortcut, matchShortcut, useT } from '@aio/ui';
import { localToEN } from '@aio/volumetric';
import { useWorkspace, workspace } from '@aio/workspace';
import { useEffect, useMemo } from 'react';
import { authorName } from '../author';
import { MeasureCard } from '../survey/card';
import {
  addMeasurement,
  loadMeasurements,
  measureStore,
  newMeasurementId,
  useMeasure,
} from '../survey/measureStore';
import { isTyping } from '../keys';
import { shell } from '../shell';
import { pciRating } from './model';
import { densityLegend } from './overlays';
import { roadStore, setRoad, useRoad, type MeasureMode } from './store';
import { roadCardModel, roadMeasurement } from './roadReading';
import { filteredDefects, focusDefect, useFilteredDefects } from './useRoadMap';

const SIZES = ['10', '20', '50'];

/** The orthomosaic and centreline switches and what the defects are coloured by. */
export function RoadLayerControls() {
  const centreline = useRoad((s) => s.centreline);
  const colorBy = useRoad((s) => s.colorBy);
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
    <>
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
    </>
  );
}

/** The area overlay (none, PCI grid or density) with what each needs, and its opacity. */
export function RoadOverlayControls() {
  const overlay = useRoad((s) => s.overlay);
  const sev = useRoad((s) => s.pciSeverity);
  const size = useRoad((s) => s.densitySize);
  const measure = useRoad((s) => s.densityMeasure);
  const opacity = useRoad((s) => s.opacity);
  const road = useRoad((s) => s.road);
  const sizes = Object.keys(road?.density.sizes ?? {});
  return (
    <>
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
    </>
  );
}

export function toggleMeasure(mode: MeasureMode = 'line'): void {
  const m = roadStore.getState().measure;
  setRoad({ measure: m.mode ? { mode: null, vertices: [] } : { mode, vertices: [] } });
}

type OpenProject = ReturnType<typeof workspace.getState>['project'];

/** Save is offered in a writable project that has surveys, on a CRS the map can place. */
export function canSaveRoadMeasure(project: OpenProject, readOnly: boolean): boolean {
  if (!project || readOnly || project.manifest.captures.length === 0) return false;
  return frameProjection(project.manifest.crs, project.manifest.origin) !== null;
}

/**
 * Save the current road measure as a site-scoped `distance` or `area` measurement, placed in the
 * project frame (height from the survey surface when one is chosen, else 0).
 */
export function saveRoadMeasure(): SurveyMeasurement | null {
  const project = workspace.getState().project;
  const m = roadStore.getState().measure;
  const ms = measureStore.getState();
  if (!m.mode || !project || !canSaveRoadMeasure(project, ms.readOnly)) return null;
  const proj = frameProjection(project.manifest.crs, project.manifest.origin);
  if (!proj) return null;
  const origin = project.manifest.origin;
  const mode = m.mode;
  const need = mode === 'line' ? 2 : 3;
  if (m.vertices.length < need) return null;
  const saved: SurveyMeasurement = {
    ...roadMeasurement(
      mode,
      m.vertices,
      ([lon, lat]) => {
        const [x, , z] = proj.toLocal(lon, lat);
        const [e, n] = localToEN(origin, [x, z]);
        return [e, n, ms.surface?.heightAt(e, n) ?? 0];
      },
      newMeasurementId(),
    ),
    createdAt: new Date().toISOString(),
  };
  const by = authorName();
  if (by) saved.createdBy = by;
  addMeasurement(saved);
  setRoad({ measure: { mode, vertices: [] } });
  return saved;
}

/** The measure readout under the stage toolbar while measuring on the map. */
export function MeasureBar() {
  const t = useT();
  const m = useRoad((s) => s.measure);
  const settings = useMeasure((s) => s.settings);
  const readOnly = useMeasure((s) => s.readOnly);
  const project = useWorkspace((s) => s.project);
  const projectId = project?.id ?? null;
  const hasSurveys = (project?.manifest.captures.length ?? 0) > 0;
  // the site's measurements are read here so a save lands in the file the survey tools write
  useEffect(() => {
    if (hasSurveys && projectId) void loadMeasurements(projectId);
  }, [hasSurveys, projectId]);
  if (!m.mode) return null;
  const model = roadCardModel(m.mode, m.vertices, settings);
  const canSave = model !== null && canSaveRoadMeasure(project, readOnly);
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
      <div className="rr-measure-v">
        {model ? (
          <MeasureCard model={model} variant="live" testId="measure-card" />
        ) : (
          <span className="faint">
            {m.mode === 'line' ? 'Click two or more points' : 'Click three or more points'}
          </span>
        )}
      </div>
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
      {canSave && (
        <Button
          variant="primary"
          size="sm"
          data-testid="measure-save"
          onClick={() => {
            saveRoadMeasure();
          }}
        >
          {t('road.measure.save')}
        </Button>
      )}
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

/** What the area overlay's legend says: the PCI ratings or the density classes. */
function LegendRows({ kind }: { kind: 'pci' | 'density' }) {
  const road = useRoad((s) => s.road);
  const sev = useRoad((s) => s.pciSeverity);
  const size = useRoad((s) => s.densitySize);
  const measure = useRoad((s) => s.densityMeasure);
  const legend = useMemo(
    () => (road && kind === 'density' ? densityLegend(road, size, measure) : []),
    [road, kind, size, measure],
  );
  if (!road) return null;
  if (kind === 'pci') {
    const v = road.pci.network[sev];
    const rating = pciRating(road.pci.ratings, v);
    return (
      <>
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
      </>
    );
  }
  return (
    <>
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
    </>
  );
}

/**
 * Legend of the area overlay: bottom left of the map, or (`inline`) in the Road workbench, where
 * it is a plain block under the overlay choice (the map's own legend carries the label).
 */
export function RoadLegend({ inline = false }: { inline?: boolean }) {
  const road = useRoad((s) => s.road);
  const overlay = useRoad((s) => s.overlay);
  if (!road || overlay === 'none') return null;
  const label = overlay === 'pci' ? 'PCI legend' : 'Density legend';
  return inline ? (
    <div className="rr-legend-inline" data-testid="road-legend">
      <LegendRows kind={overlay} />
    </div>
  ) : (
    <div className="rr-legend overlay-box" aria-label={label}>
      <LegendRows kind={overlay} />
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
 * Right step through the filtered defects. They run before the stage's own keys: the listener is
 * added once per road, ahead of the stage's (Stage.tsx calls this hook first), and reads the
 * store when a key comes. Added again for every change of the defect list, as it was, it ran
 * after the stage's keys from the first filter on, and M in split view measured in 3D.
 */
export function useRoadKeys(active: boolean): void {
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
      const id = matchShortcut('road', e);
      if (id === 'road.pci') setRoad({ overlay: s.overlay === 'pci' ? 'none' : 'pci' });
      else if (id === 'road.closeup' && onMap) setRoad({ closeup: !s.closeup });
      else if (id === 'road.density')
        setRoad({ overlay: s.overlay === 'density' ? 'none' : 'density' });
      else if (id === 'road.measure' && onMap) toggleMeasure();
      else if (isShortcut('scene.escape', e) && s.measure.mode)
        setRoad({ measure: { mode: null, vertices: [] } });
      else if (isShortcut('scene.drawUndo', e) && s.measure.mode)
        setRoad({ measure: { mode: s.measure.mode, vertices: s.measure.vertices.slice(0, -1) } });
      else if (id === 'road.next' || id === 'road.prev') {
        const rows = filteredDefects(s);
        if (!rows.length) return;
        const sel = workspace.getState().selection;
        const i = sel?.kind === 'issue' ? rows.findIndex((r) => r.id === sel.id) : -1;
        const d = id === 'road.next' ? 1 : -1;
        const next = rows[i < 0 ? 0 : (i + d + rows.length) % rows.length];
        if (next) focusDefect(next);
      } else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [active]);
}
