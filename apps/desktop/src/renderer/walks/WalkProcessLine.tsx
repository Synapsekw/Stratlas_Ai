import type { WalkFile, WalkLayer } from '@aio/schema';
import { Icon, useT } from '@aio/ui';
import { useWorkspace } from '@aio/workspace';
import { useId, useState } from 'react';
import { useProcessingTools } from '../processingTools';
import { useJobs, useShell } from '../shell';
import { jobForWalk, packOffersWalkProcess, walkStatus, walkStatusText } from './walkModel';
import type { WalkStatus } from './walkModel';
import { locateOriginal, processWalk, useWalks } from './walks';
import { walkFolderId, walkRecordKey } from './walkStore';
import './walks.css';

export interface WalkProcessLineProps {
  /** The walk layer the line sits under (its test ids carry it). */
  layerId: string;
  /** The walk's `walk.json`: its name, original file and camera layout. */
  record: WalkFile;
  status: WalkStatus;
  /** The pipeline pack runs `walk.process`. */
  offered: boolean;
  /** A package: the status shows, nothing is started. */
  readOnly: boolean;
  /** Start processing, from this original or (none) from the playback copy; an error or null. */
  onProcess: (src: string | undefined) => Promise<string | null>;
  /** **Locate...**: the picked original, why it is not the one, or null when the dialog closed. */
  onLocate: () => Promise<{ path: string } | { error: string } | null>;
}

/**
 * A walk's processing, under its row in the Datasets list: the status, **Process walk** for a
 * walk not processed (or whose processing failed), and for a camera file the choice of its
 * original.
 */
export function WalkProcessLine({
  layerId,
  record,
  status,
  offered,
  readOnly,
  onProcess,
  onLocate,
}: WalkProcessLineProps) {
  const t = useT();
  const [choosing, setChoosing] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const titleId = useId();
  const hintId = useId();
  const canProcess = !readOnly && (status.kind === 'not-processed' || status.kind === 'failed');
  const text = walkStatusText(status);

  const start = async (src?: string) => {
    setBusy(true);
    const error = await onProcess(src);
    setBusy(false);
    if (!error) setChoosing(false);
  };
  const locate = async () => {
    setBusy(true);
    const r = await onLocate();
    setBusy(false);
    if (!r) return;
    if ('error' in r) {
      setNote(r.error);
      return;
    }
    await start(r.path);
  };

  return (
    <div className="walk-proc-wrap">
      <div className="walk-proc" data-testid={`walk-status-${layerId}`} data-kind={status.kind}>
        <span className="walk-proc-text" title={text}>
          {text}
        </span>
        {status.kind === 'processing' && (
          <span className="walk-meter" aria-hidden="true">
            <span style={{ inlineSize: `${String(status.pct)}%` }} />
          </span>
        )}
        {canProcess && (
          <button
            type="button"
            className="walk-proc-act"
            data-testid={`walk-process-${layerId}`}
            disabled={!offered || busy || choosing}
            aria-describedby={offered ? undefined : hintId}
            onClick={() => {
              // a stitched video is its own original; a camera file's original is asked for
              if (record.source.layout === 'equirect') void start();
              else {
                setNote(null);
                setChoosing(true);
              }
            }}
          >
            {t('walk.process')}
          </button>
        )}
      </div>
      {canProcess && !offered && (
        <div className="walk-proc-hint" id={hintId}>
          {t('walk.process.needsPack')}
        </div>
      )}
      {choosing && (
        <div
          className="walk-locate"
          role="group"
          aria-labelledby={titleId}
          data-testid={`walk-locate-${layerId}`}
        >
          <p className="walk-locate-h" id={titleId}>
            {t('walk.locate.title', { name: record.name })}
          </p>
          <p className="walk-locate-note" data-tone={note ? 'error' : undefined} role="status">
            {note ?? t('walk.locate.note', { file: record.source.file })}
          </p>
          <div className="walk-locate-acts">
            <button
              type="button"
              className="btn sm"
              data-testid="walk-locate-pick"
              disabled={busy}
              onClick={() => void locate()}
            >
              {t('walk.locate.pick')}
            </button>
            <button
              type="button"
              className="btn sm ghost"
              data-testid="walk-locate-without"
              disabled={busy}
              onClick={() => void start()}
            >
              {t('walk.locate.without')}
            </button>
            <button
              type="button"
              className="btn icon sm ghost"
              aria-label={t('walk.locate.cancel')}
              title={t('walk.locate.cancel')}
              disabled={busy}
              onClick={() => {
                setChoosing(false);
              }}
            >
              <Icon name="x" size={14} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * The processing line of a walk row, wired to the walk list, its `walk.process` job and the
 * pipeline pack. Nothing until main has listed the walk's record (a walk whose files are gone
 * says so in its badge instead).
 */
export function WalkRowProcess({ layer }: { layer: WalkLayer }) {
  const root = useWorkspace((s) => s.project?.root);
  const readOnly = useShell((s) => s.pkg !== null);
  const folder = walkFolderId(layer);
  const record = useWalks((s) => s.records[walkRecordKey(layer)]);
  const processed = useWalks((s) => s.processed[folder]);
  const startError = useWalks((s) => s.startErrors[layer.id]);
  const job = useJobs((s) => (root === undefined ? undefined : jobForWalk(s.jobs, root, folder)));
  const offered = useProcessingTools((s) => packOffersWalkProcess(s.status));
  if (!record) return null;
  const status: WalkStatus = startError
    ? { kind: 'failed', message: startError }
    : walkStatus(record, processed, job);
  return (
    <WalkProcessLine
      layerId={layer.id}
      record={record}
      status={status}
      offered={offered}
      readOnly={readOnly}
      onProcess={(src) => processWalk(layer.id, { walk: folder, ...(src ? { src: [src] } : {}) })}
      onLocate={() => locateOriginal(record)}
    />
  );
}
