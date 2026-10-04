import type { AioBridge, ImportItem } from '@aio/schema';
import { Icon, type IconName } from '@aio/ui';
import { useWorkspace } from '@aio/workspace';
import { useEffect, useState } from 'react';
import { useShell } from '../shell';
import { heightsLine, offsetFromTakeoff, promptChoice, type HeightsPrompt } from './heights';
import { builder, useBuilder } from './state';

const STATUS: Record<ImportItem['status'], { icon: IconName; label: string }> = {
  imported: { icon: 'check', label: 'Imported' },
  skipped: { icon: 'minus', label: 'Skipped' },
  'needs-pipeline': { icon: 'warn', label: 'Needs pipeline pack' },
  queued: { icon: 'clock', label: 'Queued' },
  error: { icon: 'warn', label: 'Failed' },
};

function droppedPaths(e: DragEvent): string[] {
  const aio = (window as { aio?: AioBridge }).aio;
  const files = [...(e.dataTransfer?.files ?? [])];
  return files.map((f) => aio?.pathForFile?.(f) ?? '').filter(Boolean);
}

const hasFiles = (e: DragEvent) => [...(e.dataTransfer?.types ?? [])].includes('Files');

/**
 * Drag and drop anywhere on the window imports raw files into the open project; the progress and
 * the per-file outcome show in a panel at the bottom right.
 */
export function ImportLayer() {
  const [over, setOver] = useState(false);
  const projectName = useWorkspace((s) => s.project?.manifest.name ?? null);

  useEffect(() => {
    let depth = 0;
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth++;
      setOver(true);
    };
    const leave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setOver(false);
    };
    const overFn = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    };
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      setOver(false);
      void builder.getState().importFiles(droppedPaths(e));
    };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragleave', leave);
    window.addEventListener('dragover', overFn);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('dragover', overFn);
      window.removeEventListener('drop', drop);
    };
  }, []);

  return (
    <>
      {over && (
        <div className="b-drop" aria-hidden="true">
          <div>
            <Icon name="import" size={20} />
            <h3>{projectName ? `Import into ${projectName}` : 'Open a project to import'}</h3>
            <p>
              Photos, video with its SRT, GLB or OBJ models, GeoTIFF orthos and DSMs, point clouds
            </p>
          </div>
        </div>
      )}
      <ImportStatus />
    </>
  );
}

const num = (v: string) => (v.trim() === '' ? Number.NaN : Number(v));

/**
 * Camera heights before an import whose drones logged relative altitude (height above the
 * take-off point): the take-off height H, proposed from the model under the take-off point, or
 * absolute altitude with a datum offset that becomes the project's (data-conventions section 3a).
 */
function HeightsCard({ p }: { p: HeightsPrompt }) {
  const [source, setSource] = useState<'relative' | 'absolute'>('relative');
  const [takeoff, setTakeoff] = useState(p.takeoffH.toFixed(1));
  const [offset, setOffset] = useState(() => {
    const o = offsetFromTakeoff(p.plan, p.takeoffH);
    return o === null ? '0' : o.toFixed(2);
  });
  const h = num(takeoff);
  const off = num(offset);
  const valid = source === 'relative' ? Number.isFinite(h) : Number.isFinite(off);
  const lowest = p.plan.takeoff?.relAltM ?? 0;
  const abs = p.plan.takeoffAbsAlt;
  return (
    <section className="b-import" aria-label="Camera heights" data-testid="import-heights">
      <header>
        <Icon name="import" size={14} />
        Camera heights for {String(p.plan.files)} {p.plan.files === 1 ? 'file' : 'files'}
      </header>
      <div className="b-heights">
        <p className="small">
          The drone logged its height above the take-off point. Give the take-off point&apos;s
          height in the project, or use its absolute altitude with a datum offset.
        </p>
        <label className="b-heights-opt">
          <input
            type="radio"
            name="heights-source"
            checked={source === 'relative'}
            onChange={() => {
              setSource('relative');
            }}
          />
          <span>Relative altitude + take-off height</span>
        </label>
        {source === 'relative' && (
          <div className="b-heights-field">
            <label>
              Take-off height H (m)
              <input
                type="number"
                step="0.1"
                value={takeoff}
                aria-label="Take-off height"
                onChange={(e) => {
                  setTakeoff(e.target.value);
                }}
              />
            </label>
            {p.takeoffFrom === 'terrain' ? (
              <p className="faint small">
                Model height under the take-off point (y {(p.takeoffH - p.originH).toFixed(1)} m).
              </p>
            ) : (
              <p className="notice warn small" data-testid="takeoff-warning">
                <Icon name="warn" size={14} />
                No model under the take-off point: the project origin height (y 0) is assumed. Check
                it, or heights will be off by the take-off point&apos;s elevation.
              </p>
            )}
            {lowest > 2 && (
              <p className="faint small">
                The logs start {lowest.toFixed(0)} m above the take-off point; its position is taken
                from the lowest logged position.
              </p>
            )}
          </div>
        )}
        {p.plan.absolute > 0 && (
          <label className="b-heights-opt">
            <input
              type="radio"
              name="heights-source"
              checked={source === 'absolute'}
              onChange={() => {
                setSource('absolute');
              }}
            />
            <span>Absolute altitude + datum offset</span>
          </label>
        )}
        {source === 'absolute' && (
          <div className="b-heights-field">
            <label>
              Offset (m)
              <input
                type="number"
                step="0.01"
                value={offset}
                aria-label="Datum offset"
                onChange={(e) => {
                  setOffset(e.target.value);
                }}
              />
            </label>
            <p className="faint small">
              Project height = absolute altitude + offset, saved as the project&apos;s vertical
              datum for later imports.
              {abs !== null &&
                ` The aircraft logged its take-off point at absolute altitude ${abs.toFixed(1)} m.`}
            </p>
          </div>
        )}
        <div className="b-heights-actions">
          <button
            type="button"
            className="btn ghost sm"
            onClick={() => {
              builder.getState().cancelHeights();
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            className="btn primary sm"
            disabled={!valid}
            onClick={() => {
              void builder
                .getState()
                .confirmHeights(promptChoice(p, { source, takeoffH: h, offsetM: off }));
            }}
          >
            Import
          </button>
        </div>
      </div>
    </section>
  );
}

function ImportStatus() {
  const importing = useBuilder((s) => s.importing);
  const result = useBuilder((s) => s.importResult);
  const prompt = useBuilder((s) => s.heightsPrompt);
  if (prompt && !importing) return <HeightsCard p={prompt} />;
  if (!importing && !result) return null;
  const heights = result?.heights ? heightsLine(result.heights) : null;
  const counts = result
    ? result.items.reduce<Record<string, number>>(
        (m, i) => ({ ...m, [i.status]: (m[i.status] ?? 0) + 1 }),
        {},
      )
    : {};
  return (
    <section className="b-import" aria-label="Import" data-testid="import-panel">
      <header>
        <Icon name="import" size={14} />
        {importing
          ? `Importing ${String(importing.done)} of ${String(importing.total)}`
          : result?.error
            ? 'Import failed'
            : `Imported ${String(counts.imported ?? 0)} of ${String(result?.items.length ?? 0)} files`}
        {!importing && (
          <button
            type="button"
            className="btn ghost sm"
            onClick={() => {
              builder.getState().dismissImport();
            }}
          >
            Close
          </button>
        )}
      </header>
      {importing && (
        <>
          <div className="b-progress">
            <i
              style={{ width: `${String((importing.done / Math.max(1, importing.total)) * 100)}%` }}
            />
          </div>
          {importing.file && (
            <p className="faint small" style={{ margin: '0 12px 10px' }}>
              {importing.file}
            </p>
          )}
        </>
      )}
      {result?.error && (
        <p className="notice danger" style={{ margin: 12 }}>
          <Icon name="warn" size={14} />
          {result.error}
        </p>
      )}
      {heights && (
        <p
          className={
            heights.warn ? 'notice warn small b-heights-line' : 'faint small b-heights-line'
          }
          data-testid="import-heights-line"
        >
          {heights.warn && <Icon name="warn" size={14} />}
          {heights.text}
        </p>
      )}
      {result && result.items.length > 0 && (
        <ul>
          {result.items.map((it, i) => (
            <li key={`${it.file}-${String(i)}`} className={it.status}>
              <Icon name={STATUS[it.status].icon} size={14} />
              <span>{it.file}</span>
              <span className="st">{STATUS[it.status].label}</span>
              {it.message && <p>{it.message}</p>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Shown on the stage of a project with no layers yet. */
export function EmptyProjectHint() {
  const project = useWorkspace((s) => s.project);
  const screen = useShell((s) => s.screen);
  const importing = useBuilder((s) => s.importing);
  if (!project || project.manifest.layers.length > 0 || screen !== 'scene' || importing)
    return null;
  return (
    <div className="b-empty" data-testid="empty-project">
      <div>
        <Icon name="import" size={20} />
        <h3>Add raw data to {project.manifest.name}</h3>
        <p>
          Drop files anywhere on the window, or pick them. Photos are placed by their GPS and gimbal
          angles, video by its DJI SRT telemetry, models and orthos where you align them.
        </p>
        <button
          type="button"
          className="btn primary"
          onClick={() => void builder.getState().pickAndImport()}
        >
          <Icon name="plus" size={14} />
          Import files
        </button>
      </div>
    </div>
  );
}
