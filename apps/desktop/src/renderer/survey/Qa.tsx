/**
 * Survey QA (M11 G8, PRD SRV-10): **Check against points** for any delivered DSM or cloud (a CSV of
 * checkpoints or the M10 GCP file of a run), the compare-to-previous check, the site's QA level,
 * the RMSE table and histogram, and the hold: a failed check puts the survey on hold (a banner;
 * measurements on it are marked "survey on hold") until a person releases it with a note.
 *
 * `SurveyQaTool` is the stage toolbar's entry (QA, cleanup and crop, surveys, elevation history);
 * `SurveyQaMount` loads the project's QA state and shows the banner and the open panel.
 */
import type { QaLevel, SurveyQa } from '@aio/schema';
import { Icon } from '@aio/ui';
import { useWorkspace } from '@aio/workspace';
import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { bridge, useCall, useShell } from '../shell';
import { timeline } from '../workspace/timeline';
import { PopTool } from '../workspace/StageTools';
import { CleanupPanel } from './Cleanup';
import { ElevationHistory } from './ElevationHistory';
import { saveSiteSettings, useMeasure } from './measureStore';
import { useFocusCapture } from './qaHelpers';
import {
  isHeld,
  LEVEL_LABELS,
  loadQa,
  openQaPanel,
  releaseHold,
  RMSE_LIMIT,
  runQa,
  useQa,
  type Checkpoints,
  type QaPanel,
} from './qaStore';
import { SurveyPicker } from './SurveyPicker';
import './qa.css';

const LEVELS: QaLevel[] = ['strict', 'moderate', 'lenient', 'off'];

const cm = (m: number) => `${(m * 100).toFixed(1)} cm`;

const ENTRIES: {
  panel: Exclude<QaPanel, null>;
  label: string;
  icon: 'shield' | 'brush' | 'clock' | 'point';
}[] = [
  { panel: 'qa', label: 'Check against points', icon: 'shield' },
  { panel: 'cleanup', label: 'Cleanup and crop', icon: 'brush' },
  { panel: 'surveys', label: 'Surveys', icon: 'clock' },
  { panel: 'history', label: 'Elevation history', icon: 'point' },
];

/** The stage toolbar's survey QA entry. */
export function SurveyQaTool() {
  const panel = useQa((s) => s.panel);
  const [open, setOpen] = useState(false);
  return (
    <PopTool
      icon="shield"
      label="Survey QA and cleanup"
      pressed={panel !== null}
      open={open}
      onOpenChange={setOpen}
    >
      <div className="pop-form qa-menu" data-testid="survey-qa-tools">
        {ENTRIES.map((e) => (
          <button
            key={e.panel}
            type="button"
            className="btn sm"
            aria-pressed={panel === e.panel}
            data-testid={`survey-qa-open-${e.panel}`}
            onClick={() => {
              openQaPanel(panel === e.panel ? null : e.panel);
              setOpen(false);
            }}
          >
            <Icon name={e.icon} size={12} /> {e.label}
          </button>
        ))}
      </div>
    </PopTool>
  );
}

/** Loads the project's QA state; shows the hold banner of the survey in focus and the open panel. */
export function SurveyQaMount() {
  const project = useWorkspace((s) => s.project);
  const pkg = useShell((s) => s.pkg);
  const panel = useQa((s) => s.panel);
  const projectId = project?.id ?? null;
  const root = project?.root ?? null;

  useEffect(() => {
    void loadQa(projectId, root, pkg !== null);
  }, [projectId, root, pkg]);

  if (!projectId) return null;
  return createPortal(
    <>
      <HoldBanner />
      {panel && (
        <aside className="qa-side" aria-label="Survey QA" data-testid="survey-qa-side">
          {panel === 'qa' && <QaPanelView />}
          {panel === 'cleanup' && <CleanupPanel />}
          {panel === 'surveys' && <SurveyPicker />}
          {panel === 'history' && <ElevationHistory />}
        </aside>
      )}
    </>,
    document.body,
  );
}

function useCaptureLabel(capture: string | null): string {
  const captures = useWorkspace((s) => s.project?.manifest.captures);
  return captures?.find((c) => c.id === capture)?.label ?? capture ?? '';
}

/** The banner over the stage while the survey in focus is on hold. */
function HoldBanner() {
  const capture = useFocusCapture();
  const qa = useQa((s) => (capture ? s.qa[capture] : undefined));
  const label = useCaptureLabel(capture);
  const count = useMeasure(
    (s) =>
      s.file.measurements.filter((m) => m.scope.kind === 'site' || m.scope.capture === capture)
        .length,
  );
  if (!capture || !qa || !isHeld(qa)) return null;
  return (
    <div className="qa-banner" role="alert" data-testid="qa-hold-banner" data-surface="dark">
      <Icon name="warn" size={14} />
      <span className="qa-banner-text">
        <b>{label} is on hold.</b> {qa.hold?.reason ?? 'A QA check failed.'}
        {count > 0 &&
          ` ${String(count)} ${count === 1 ? 'measurement is' : 'measurements are'} marked "survey on hold".`}
      </span>
      <button
        type="button"
        className="btn sm"
        data-testid="qa-banner-review"
        onClick={() => {
          openQaPanel('qa');
        }}
      >
        Review and release
      </button>
    </div>
  );
}

/** "Survey on hold" on a measurement whose survey is held (the measurement panel shows it). */
export function HoldNote({ capture }: { capture: string | null }) {
  const focus = useFocusCapture();
  const on = capture ?? focus;
  const held = useQa((s) => (on ? isHeld(s.qa[on]) : false));
  if (!held) return null;
  return (
    <p className="qa-hold-note" data-testid="qa-hold-note">
      <Icon name="warn" size={12} /> Survey on hold: its QA check failed and no one has released it
      yet.
    </p>
  );
}

function QaPanelView() {
  const project = useWorkspace((s) => s.project);
  const focus = useFocusCapture();
  const settings = useMeasure((s) => s.settings);
  const busy = useQa((s) => s.busy);
  const message = useQa((s) => s.message);
  const readOnly = useQa((s) => s.readOnly);
  const all = useQa((s) => s.qa);
  const [capture, setCapture] = useState<string | null>(focus);
  const [mode, setMode] = useState<'csv' | 'gcp' | 'none'>('csv');
  const [csv, setCsv] = useState('');
  const [gcpRun, setGcpRun] = useState('');
  const [levelError, setLevelError] = useState<string | null>(null);
  const runs = useCall('photo:runs', { projectId: project?.id ?? '' }, project?.id ?? null);
  const runIds = runs?.ok && runs.value.ok ? runs.value.runs.map((r) => r.id) : [];
  const captures = useMemo(
    () => [...(project?.manifest.captures ?? [])].sort((a, b) => a.date.localeCompare(b.date)),
    [project],
  );
  if (!project) return null;
  const sel = capture ?? focus;
  const qa = sel ? all[sel] : undefined;
  const level = settings.qa.level;
  const checkpoints: Checkpoints =
    mode === 'csv' && csv.trim()
      ? { csv: csv.trim() }
      : mode === 'gcp' && gcpRun
        ? { gcp: `photogrammetry/${gcpRun}/gcp.json` }
        : null;

  return (
    <section className="sv-card qa-card" aria-label="Check against points" data-testid="qa-panel">
      <div className="sv-head">
        <h2>Check against points</h2>
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
      <label className="sv-field">
        <span>Survey</span>
        <select
          className="sv-input"
          value={sel ?? ''}
          data-testid="qa-capture"
          onChange={(e) => {
            setCapture(e.target.value);
            timeline.getState().focusSurvey(e.target.value);
          }}
        >
          {captures.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
              {isHeld(all[c.id]) ? ' (on hold)' : ''}
            </option>
          ))}
        </select>
      </label>
      <fieldset className="qa-mode" disabled={readOnly}>
        <legend className="sv-field">
          <span>Checkpoints</span>
        </legend>
        <label className="sv-check">
          <input
            type="radio"
            checked={mode === 'csv'}
            onChange={() => {
              setMode('csv');
            }}
          />
          CSV file
        </label>
        <label className="sv-check">
          <input
            type="radio"
            checked={mode === 'gcp'}
            disabled={runIds.length === 0}
            onChange={() => {
              setMode('gcp');
            }}
          />
          Ground control of a processing run
        </label>
        <label className="sv-check">
          <input
            type="radio"
            checked={mode === 'none'}
            onChange={() => {
              setMode('none');
            }}
          />
          None (compare to the previous survey only)
        </label>
      </fieldset>
      {mode === 'csv' && (
        <div className="sv-row">
          <input
            className="sv-input qa-grow"
            placeholder="Checkpoint CSV: name, easting, northing, elevation"
            value={csv}
            data-testid="qa-csv-path"
            aria-label="Checkpoint CSV file"
            onChange={(e) => {
              setCsv(e.target.value);
            }}
          />
          <button
            type="button"
            className="btn sm"
            disabled={readOnly}
            onClick={() => {
              void bridge
                .call('dialog:openFile', {
                  title: 'Checkpoints',
                  filters: [{ name: 'Checkpoints', extensions: ['csv', 'txt'] }],
                })
                .then((r) => {
                  if (r.ok && r.value.path) setCsv(r.value.path);
                });
            }}
          >
            Choose...
          </button>
        </div>
      )}
      {mode === 'gcp' && (
        <select
          className="sv-input"
          value={gcpRun}
          aria-label="Processing run"
          onChange={(e) => {
            setGcpRun(e.target.value);
          }}
        >
          <option value="">Pick a run</option>
          {runIds.map((id) => (
            <option key={id} value={id}>
              {id}
            </option>
          ))}
        </select>
      )}
      <label className="sv-field">
        <span>QA level (site settings)</span>
        <select
          className="sv-input"
          value={level}
          disabled={readOnly}
          data-testid="qa-level"
          onChange={(e) => {
            const next = e.target.value as QaLevel;
            const rest = { ...settings.qa };
            delete rest.rmseM;
            void saveSiteSettings({ ...settings, qa: { ...rest, level: next } }).then(
              setLevelError,
            );
          }}
        >
          {LEVELS.map((l) => (
            <option key={l} value={l}>
              {LEVEL_LABELS[l]}
              {l !== 'off' ? `: RMSE up to ${cm(RMSE_LIMIT[l])}` : ': no verdict'}
            </option>
          ))}
        </select>
      </label>
      {levelError && <p className="qa-error">{levelError}</p>}
      <div className="sv-row">
        <button
          type="button"
          className="btn sm primary"
          disabled={readOnly || !sel || busy !== null || (mode !== 'none' && !checkpoints)}
          data-testid="qa-run"
          onClick={() => {
            if (sel) void runQa(project.manifest, sel, level, checkpoints);
          }}
        >
          {busy ?? 'Check the survey'}
        </button>
      </div>
      {message && (
        <p className={message.kind === 'error' ? 'qa-error' : 'qa-ok'} role="status">
          {message.text}
        </p>
      )}
      {qa && <QaResult qa={qa} readOnly={readOnly} />}
    </section>
  );
}

const STATUS_LABEL: Record<SurveyQa['status'], string> = {
  pass: 'Passed',
  fail: 'On hold',
  hold: 'On hold',
  released: 'Released',
  unchecked: 'Measured, no verdict',
};

function QaResult({ qa, readOnly }: { qa: SurveyQa; readOnly: boolean }) {
  const cp = qa.checkpoints;
  return (
    <div className="qa-result" data-testid="qa-result">
      <div className="sv-row">
        <span className={`qa-pill qa-${qa.status}`} data-testid="qa-status">
          {STATUS_LABEL[qa.status]}
        </span>
        <span className="faint small">
          {LEVEL_LABELS[qa.level]}, checked {new Date(qa.checkedAt).toLocaleString()}
        </span>
      </div>
      {cp && (
        <>
          <dl className="qa-stats">
            <dt>RMSE</dt>
            <dd className="mono" data-testid="qa-rmse">
              {cm(cp.rmseM)}
            </dd>
            <dt>Mean</dt>
            <dd className="mono">{cm(cp.meanM)}</dd>
            <dt>Largest</dt>
            <dd className="mono">{cm(cp.maxAbsM)}</dd>
            <dt>Points</dt>
            <dd className="mono">
              {cp.count} of {cp.points.length}
            </dd>
          </dl>
          <Histogram values={cp.points.flatMap((p) => (p.dz === null ? [] : [p.dz]))} />
          <table className="qa-table" data-testid="qa-points">
            <thead>
              <tr>
                <th scope="col">Point</th>
                <th scope="col">Surface minus surveyed</th>
              </tr>
            </thead>
            <tbody>
              {cp.points.map((p) => (
                <tr key={p.name} className={p.dz !== null && Math.abs(p.dz) > 0.1 ? 'qa-far' : ''}>
                  <td>{p.name}</td>
                  <td className="mono">{p.dz === null ? 'no surface' : cm(p.dz)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      {qa.previous && (
        <p className="small" data-testid="qa-previous">
          {(qa.previous.changedShare * 100).toFixed(1)}% of the area changed by more than{' '}
          {qa.previous.thresholdM.toFixed(2)} m since the previous survey.
        </p>
      )}
      {(qa.status === 'hold' || qa.status === 'fail') && <Release qa={qa} readOnly={readOnly} />}
      {qa.status === 'released' && qa.release && (
        <p className="small" data-testid="qa-released">
          Released {new Date(qa.release.at).toLocaleString()}
          {qa.release.by ? ` by ${qa.release.by}` : ''}: {qa.release.note}
        </p>
      )}
    </div>
  );
}

function Release({ qa, readOnly }: { qa: SurveyQa; readOnly: boolean }) {
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  return (
    <div className="qa-release">
      <p className="small">
        <b>On hold:</b> {qa.hold?.reason ?? 'A QA check failed.'}
      </p>
      {readOnly ? (
        <p className="faint small">This project is a read-only package.</p>
      ) : (
        <>
          <label className="sv-field">
            <span>Release note</span>
            <textarea
              className="sv-input"
              rows={2}
              value={note}
              maxLength={2000}
              data-testid="qa-release-note"
              placeholder="Why this survey can be used, for example: checked against the GNSS log."
              onChange={(e) => {
                setNote(e.target.value);
              }}
            />
          </label>
          <button
            type="button"
            className="btn sm"
            disabled={saving || !note.trim()}
            data-testid="qa-release"
            onClick={() => {
              setSaving(true);
              void releaseHold(qa.capture, note.trim()).then((err) => {
                setSaving(false);
                if (!err) setNote('');
              });
            }}
          >
            Release the survey
          </button>
        </>
      )}
    </div>
  );
}

/** dz of the checkpoints in 2 cm bins. */
function Histogram({ values }: { values: number[] }) {
  if (values.length === 0) return null;
  const bin = 0.02;
  const lo = Math.floor(Math.min(...values) / bin);
  const hi = Math.floor(Math.max(...values) / bin);
  const n = Math.min(60, hi - lo + 1);
  const counts = new Array<number>(n).fill(0);
  for (const v of values) {
    const k = Math.min(n - 1, Math.floor(v / bin) - lo);
    counts[k] = (counts[k] ?? 0) + 1;
  }
  const max = Math.max(...counts);
  const w = 280;
  const h = 60;
  const bw = w / n;
  return (
    <figure className="qa-hist" aria-label="Checkpoint differences">
      <svg viewBox={`0 0 ${String(w)} ${String(h + 14)}`} role="img">
        {counts.map((c, k) => (
          <rect
            key={k}
            x={k * bw + 1}
            width={Math.max(1, bw - 2)}
            y={h - (c / max) * h}
            height={(c / max) * h}
            className={Math.abs((lo + k + 0.5) * bin) > 0.1 ? 'qa-bar far' : 'qa-bar'}
          >
            <title>{`${cm((lo + k) * bin)} to ${cm((lo + k + 1) * bin)}: ${String(c)}`}</title>
          </rect>
        ))}
        <text x={0} y={h + 12} className="qa-axis">
          {cm(lo * bin)}
        </text>
        <text x={w} y={h + 12} className="qa-axis" textAnchor="end">
          {cm((hi + 1) * bin)}
        </text>
      </svg>
    </figure>
  );
}
