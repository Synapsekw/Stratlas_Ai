/**
 * Files on this computer (M9 T6): each layer's state (here, not here, downloading, streaming),
 * its fetch policy on this machine, Download, Cancel and Resume, and the download cache use.
 * `useLayerFiles` holds the state; the layer placeholder (workspace/LayerPlaceholder.tsx) and this
 * panel share one instance.
 */
import type { FetchPolicy, IpcEvent, LayerBlobStatus } from '@aio/schema';
import { formatBytes, t, useT } from '@aio/ui';
import { workspace } from '@aio/workspace';
import { useCallback, useEffect, useRef, useState } from 'react';
import { bridge } from '../shell';
import './files.css';
import { POLICIES, newJobId, rowView, type Progress } from './filesModel';

export interface LayerFilesModel {
  layers: LayerBlobStatus[];
  cache: { bytes: number; capBytes: number } | null;
  /** Download progress per layer while a job runs. */
  progress: Readonly<Record<string, Progress>>;
  /** The last error per layer (a failed download). */
  errors: Readonly<Record<string, string>>;
  download(layer: string): Promise<void>;
  cancel(layer: string): void;
  setPolicy(layer: string, policy: FetchPolicy): Promise<void>;
  refresh(): Promise<void>;
}

/** A layer that failed to load because its file was missing loads again once the file is here. */
function reloadLayer(id: string): void {
  const ws = workspace.getState();
  ws.setLayerVisible(id, ws.isLayerVisible(id));
}

async function readStatus(projectId: string) {
  const r = await bridge.call('blobs:status', { projectId });
  return r.ok && r.value.ok ? { layers: r.value.layers, cache: r.value.cache } : null;
}

export function useLayerFiles(projectId: string | null): LayerFilesModel {
  const [layers, setLayers] = useState<LayerBlobStatus[]>([]);
  const [cache, setCache] = useState<LayerFilesModel['cache']>(null);
  const [progress, setProgress] = useState<Record<string, Progress>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const jobs = useRef(new Map<string, string>());
  const before = useRef(new Map<string, LayerBlobStatus['state']>());

  const apply = useCallback((r: Awaited<ReturnType<typeof readStatus>>) => {
    if (!r) return;
    for (const l of r.layers) {
      const was = before.current.get(l.layer);
      const loads = (st: LayerBlobStatus['state'] | undefined) =>
        st === 'present' || st === 'streaming';
      if (was && !loads(was) && loads(l.state)) reloadLayer(l.layer);
      before.current.set(l.layer, l.state);
    }
    setLayers(r.layers);
    setCache(r.cache);
  }, []);

  const refresh = useCallback(async () => {
    if (projectId) apply(await readStatus(projectId));
  }, [projectId, apply]);

  // state starts empty per project: the caller keys the component by project
  useEffect(() => {
    const aio = window.aio as typeof window.aio | undefined;
    if (!projectId || !aio) return;
    let live = true;
    const load = () =>
      readStatus(projectId).then((r) => {
        if (live) apply(r);
      });
    void load();
    const off = aio.on('blobs:progress', (e: IpcEvent<'blobs:progress'>) => {
      if (e.projectId !== projectId || !e.layer) return;
      const layer = e.layer;
      setProgress((p) => ({ ...p, [layer]: { done: e.done, total: e.total, state: e.state } }));
      if (e.state !== 'running') void load();
    });
    return () => {
      live = false;
      off();
    };
  }, [projectId, apply]);

  const download = useCallback(
    async (layer: string) => {
      if (!projectId) return;
      const jobId = newJobId();
      jobs.current.set(layer, jobId);
      setErrors((e) => Object.fromEntries(Object.entries(e).filter(([k]) => k !== layer)));
      const r = await bridge.call('blobs:fetch', { jobId, projectId, layer });
      jobs.current.delete(layer);
      const error = !r.ok ? r.error : r.value.ok ? null : r.value.error;
      if (error && error !== 'Download cancelled.') setErrors((e) => ({ ...e, [layer]: error }));
      await refresh();
    },
    [projectId, refresh],
  );

  const cancel = useCallback((layer: string) => {
    const jobId = jobs.current.get(layer);
    if (jobId) void bridge.call('blobs:cancel', { jobId });
  }, []);

  const setPolicy = useCallback(
    async (layer: string, policy: FetchPolicy) => {
      if (!projectId) return;
      await bridge.call('blobs:policy', { projectId, layer, policy });
      await refresh();
    },
    [projectId, refresh],
  );

  return { layers, cache, progress, errors, download, cancel, setPolicy, refresh };
}

/** One layer's state line with its action (shared by the panel and the placeholder). */
export function LayerFileRow({
  status,
  name,
  model,
  withPolicy = false,
}: {
  status: LayerBlobStatus;
  name: string;
  model: LayerFilesModel;
  withPolicy?: boolean;
}) {
  useT();
  const view = rowView(status, model.progress[status.layer]);
  const error = model.errors[status.layer];
  const line =
    view.text === 'blobs.downloading' || view.text === 'blobs.partial'
      ? t(view.text, { done: formatBytes(view.done), total: formatBytes(view.bytes) })
      : t(view.text, { size: formatBytes(view.bytes) });
  return (
    <li className="files-row" data-testid="files-row" data-layer={status.layer}>
      <div className="files-row-h">
        <b className="files-name">{name}</b>
        <span className="files-state" data-testid="files-state" data-state={status.state}>
          {line}
        </span>
      </div>
      {view.fraction !== null && (
        <progress
          className="files-bar"
          max={1}
          value={view.fraction}
          aria-label={t('blobs.progress', { name })}
        />
      )}
      {error && <p className="files-err">{error}</p>}
      <div className="files-acts">
        {withPolicy && (
          <label className="files-policy">
            <span>{t('blobs.policy')}</span>
            <select
              value={status.policy}
              data-testid="files-policy"
              onChange={(e) => {
                void model.setPolicy(status.layer, e.target.value as FetchPolicy);
              }}
            >
              {POLICIES.map((p) => (
                <option key={p} value={p}>
                  {t(`blobs.policy.${p}`)}
                </option>
              ))}
            </select>
          </label>
        )}
        {view.action === 'cancel' && (
          <button
            type="button"
            className="btn sm"
            onClick={() => {
              model.cancel(status.layer);
            }}
          >
            {t('blobs.cancel')}
          </button>
        )}
        {(view.action === 'download' || view.action === 'resume') && (
          <button
            type="button"
            className="btn sm primary"
            onClick={() => {
              void model.download(status.layer);
            }}
          >
            {t(view.action === 'resume' ? 'blobs.resume' : 'blobs.download')}
          </button>
        )}
      </div>
    </li>
  );
}

/** Every layer with files: state, policy on this machine, Download; and the cache use. */
export function Files({
  model,
  names,
  onClose,
}: {
  model: LayerFilesModel;
  names: Readonly<Record<string, string>>;
  onClose: () => void;
}) {
  useT();
  return (
    <section className="files-panel" aria-label={t('blobs.title')} data-testid="files-panel">
      <header className="files-panel-h">
        <b>{t('blobs.title')}</b>
        <button type="button" className="btn sm ghost" onClick={onClose}>
          {t('blobs.close')}
        </button>
      </header>
      <ul className="files-list">
        {model.layers.map((l) => (
          <LayerFileRow
            key={l.layer}
            status={l}
            name={names[l.layer] ?? l.layer}
            model={model}
            withPolicy
          />
        ))}
      </ul>
      {model.cache && (
        <p className="files-cache faint">
          {t('blobs.cache', {
            used: formatBytes(model.cache.bytes),
            cap: formatBytes(model.cache.capBytes),
          })}
        </p>
      )}
    </section>
  );
}
