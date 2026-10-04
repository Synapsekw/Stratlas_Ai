import type { AioBridge, ImportItem } from '@aio/schema';
import { Icon, type IconName } from '@aio/ui';
import { useWorkspace } from '@aio/workspace';
import { useEffect, useState } from 'react';
import { useShell } from '../shell';
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

function ImportStatus() {
  const importing = useBuilder((s) => s.importing);
  const result = useBuilder((s) => s.importResult);
  if (!importing && !result) return null;
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
