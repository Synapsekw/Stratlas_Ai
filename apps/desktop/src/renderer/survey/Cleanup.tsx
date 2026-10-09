/**
 * Terrain cleanups (M11 G8, PRD SRV-11): polygons where a surface is replaced by an interpolation
 * from the polygon's edge (TIN or thin-plate), drawn with the area tool or copied from a
 * measurement (**Copy as cleanup**), listed in `survey/cleanups.json` with on and off toggles, and
 * run into a new cleaned surface `<survey>-clean`. The delivered surface never changes; a
 * comparison uses the cleaned one only when a person picks it. Crops are in `Crop.tsx`.
 * **DTM filter** makes a bare-ground surface from a point cloud layer with a preset (PDAL), disabled
 * with the reason when the project has no cloud or the pipeline pack has no PDAL.
 */
import { Icon } from '@aio/ui';
import { useWorkspace } from '@aio/workspace';
import { useEffect, useMemo, useState } from 'react';
import { bridge } from '../shell';
import { CropSection } from './Crop';
import { startTool, useMeasure } from './measureStore';
import { editFrom, ringOf, useFocusCapture } from './qaHelpers';
import {
  addEdit,
  cloudLayers,
  DTM_PRESETS,
  dtmFilterBlock,
  openQaPanel,
  patchEdit,
  prepareCapture,
  runCleanup,
  runDtmFilter,
  surfaceOfCapture,
  useQa,
  type DtmPreset,
  type PipelineTools,
} from './qaStore';

/** **DTM filter**: a point cloud layer and a preset to a new bare-ground surface. */
function DtmFilterSection() {
  const project = useWorkspace((s) => s.project);
  const busy = useQa((s) => s.busy);
  const [tools, setTools] = useState<PipelineTools | null>(null);
  const [layer, setLayer] = useState<string | null>(null);
  const [preset, setPreset] = useState<DtmPreset>('equipment');
  useEffect(() => {
    let live = true;
    void bridge.call('app:setupStatus', {}).then((r) => {
      if (live) setTools(r.ok ? r.value.pipeline : { found: false });
    });
    return () => {
      live = false;
    };
  }, []);
  if (!project) return null;
  const clouds = cloudLayers(project.manifest);
  const block = dtmFilterBlock(project.manifest, tools);
  const source = layer ?? clouds[0]?.id ?? '';
  const hint = DTM_PRESETS.find((p) => p.id === preset)?.hint;
  return (
    <fieldset className="qa-dtm" data-testid="dtm-filter">
      <legend>DTM from a point cloud</legend>
      {clouds.length > 0 && (
        <>
          <label className="sv-field">
            <span>Point cloud</span>
            <select
              className="sv-input"
              value={source}
              disabled={block !== null}
              data-testid="dtm-filter-layer"
              onChange={(e) => {
                setLayer(e.target.value);
              }}
            >
              {clouds.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          <label className="sv-field">
            <span>Remove</span>
            <select
              className="sv-input"
              value={preset}
              disabled={block !== null}
              data-testid="dtm-filter-preset"
              onChange={(e) => {
                const p = DTM_PRESETS.find((x) => x.id === e.target.value);
                if (p) setPreset(p.id);
              }}
            >
              {DTM_PRESETS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
          {hint && <p className="faint small">{hint}.</p>}
        </>
      )}
      <button
        type="button"
        className="btn sm"
        disabled={block !== null || busy !== null || !source}
        title={block ?? undefined}
        aria-describedby={block ? 'dtm-filter-why' : undefined}
        data-testid="dtm-filter-run"
        onClick={() => {
          void runDtmFilter(source, preset);
        }}
      >
        {busy ?? 'Make a DTM'}
      </button>
      {block && (
        <p className="faint small" id="dtm-filter-why" data-testid="dtm-filter-why">
          {block}
        </p>
      )}
    </fieldset>
  );
}

export function CleanupPanel() {
  const project = useWorkspace((s) => s.project);
  const focus = useFocusCapture();
  const surfaces = useQa((s) => s.surfaces);
  const edits = useQa((s) => s.edits.edits);
  const busy = useQa((s) => s.busy);
  const message = useQa((s) => s.message);
  const readOnly = useQa((s) => s.readOnly);
  const measurements = useMeasure((s) => s.file.measurements);
  const [method, setMethod] = useState<'tin' | 'thin-plate'>('tin');
  const own = useMemo(() => surfaces.filter((s) => s.capture), [surfaces]);
  const preferred = focus ? surfaceOfCapture(surfaces, focus) : null;
  const [picked, setPicked] = useState<string | null>(null);
  const surface = picked ?? preferred?.id ?? own[0]?.id ?? null;
  const mine = edits.filter((e) => e.surface === surface);
  const polygons = measurements.filter((m) => m.family === 'polygon' && m.points.length >= 3);

  if (!project) return null;
  return (
    <section className="sv-card qa-card" aria-label="Cleanup and crop" data-testid="cleanup-panel">
      <div className="sv-head">
        <h2>Cleanup and crop</h2>
        <button
          type="button"
          className="btn sm ghost"
          aria-label="Close"
          onClick={() => {
            openQaPanel(null);
          }}
        >
          <Icon name="x" size={12} />
        </button>
      </div>
      {focus && !preferred && !readOnly && (
        <div className="sv-row sv-wrap">
          <span className="faint small qa-grow">The survey in focus has no prepared surface.</span>
          <button
            type="button"
            className="btn sm"
            disabled={busy !== null}
            data-testid="cleanup-prepare"
            onClick={() => {
              void prepareCapture(project.manifest, focus);
            }}
          >
            {busy ?? 'Prepare its surface'}
          </button>
        </div>
      )}
      {!readOnly && <DtmFilterSection />}
      {own.length === 0 ? (
        <p className="faint small">
          No survey has a prepared surface yet. Run <b>Check against points</b> or prepare the
          surfaces first.
        </p>
      ) : (
        <label className="sv-field">
          <span>Surface</span>
          <select
            className="sv-input"
            value={surface ?? ''}
            data-testid="cleanup-surface"
            onChange={(e) => {
              setPicked(e.target.value);
            }}
          >
            {own.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
      )}
      {surface && (
        <>
          <ul className="qa-edits" data-testid="cleanup-list">
            {mine.length === 0 && <li className="faint small">No cleanups or crops yet.</li>}
            {mine.map((e, k) => (
              <li key={e.id} className="sv-row">
                <label className="sv-check qa-grow">
                  <input
                    type="checkbox"
                    checked={e.enabled}
                    disabled={readOnly}
                    data-testid={`cleanup-enabled-${e.id}`}
                    onChange={(ev) => {
                      void patchEdit(e.id, { enabled: ev.target.checked });
                    }}
                  />
                  {k + 1}. {e.kind === 'crop' ? 'Crop' : 'Cleanup'}: {e.label ?? e.id}
                </label>
                {e.kind === 'cleanup' && (
                  <select
                    className="sv-input"
                    aria-label="Fill"
                    value={e.method ?? 'tin'}
                    disabled={readOnly}
                    onChange={(ev) => {
                      void patchEdit(e.id, {
                        method: ev.target.value === 'thin-plate' ? 'thin-plate' : 'tin',
                      });
                    }}
                  >
                    <option value="tin">TIN</option>
                    <option value="thin-plate">Thin-plate</option>
                  </select>
                )}
              </li>
            ))}
          </ul>
          {!readOnly && (
            <>
              <div className="sv-row sv-wrap">
                <button
                  type="button"
                  className="btn sm"
                  onClick={() => {
                    startTool('area');
                  }}
                >
                  <Icon name="polygon" size={12} /> Draw an area
                </button>
                <span className="faint small">then copy it below as a cleanup or a crop.</span>
              </div>
              <label className="sv-field">
                <span>Fill a cleanup from its edge</span>
                <select
                  className="sv-input"
                  value={method}
                  data-testid="cleanup-method"
                  onChange={(e) => {
                    setMethod(e.target.value === 'thin-plate' ? 'thin-plate' : 'tin');
                  }}
                >
                  <option value="tin">TIN (flat between the edge points)</option>
                  <option value="thin-plate">Thin-plate (follows the curve of the ground)</option>
                </select>
              </label>
              <ul className="qa-edits" aria-label="Polygon measurements">
                {polygons.length === 0 && (
                  <li className="faint small">No area or volume measurements to copy.</li>
                )}
                {polygons.map((m) => (
                  <li key={m.id} className="sv-row">
                    <span className="qa-grow small">{m.label}</span>
                    <button
                      type="button"
                      className="btn sm"
                      data-testid={`cleanup-copy-${m.id}`}
                      onClick={() => {
                        void addEdit(editFrom('cleanup', surface, ringOf(m), m.label, method));
                      }}
                    >
                      Copy as cleanup
                    </button>
                  </li>
                ))}
              </ul>
              <CropSection surface={surface} polygons={polygons} />
              <button
                type="button"
                className="btn sm primary"
                disabled={busy !== null || mine.length === 0}
                data-testid="cleanup-run"
                onClick={() => {
                  void runCleanup(surface);
                }}
              >
                {busy ?? 'Make the cleaned surface'}
              </button>
            </>
          )}
          {message && (
            <p className={message.kind === 'error' ? 'qa-error' : 'qa-ok'} role="status">
              {message.text}
            </p>
          )}
        </>
      )}
    </section>
  );
}
