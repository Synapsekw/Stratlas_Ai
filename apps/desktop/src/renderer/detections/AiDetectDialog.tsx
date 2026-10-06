/**
 * AI-assisted detection (BLD-6): choose photos or video frames, see the route, the cost estimate
 * and exactly what will be sent (AI-6), then send in batches. Results land as draft detections
 * for the review; a provider error stops the run with the provider's own message.
 */
import {
  DEFAULT_BATCH,
  detectInstructions,
  detectUserText,
  estimateDetect,
  modelLabel,
  PROVIDER_LABELS,
  routeFor,
  SEND_MAX_PX,
  type DetectPromptInput,
} from '@aio/ai';
import type { Layer } from '@aio/schema';
import { formatCount, Icon, useFocusTrap, useT } from '@aio/ui';
import { useWorkspace } from '@aio/workspace';
import { useEffect, useMemo, useRef, useState } from 'react';
import { bridge, useCall, useShell } from '../shell';
import { MediaThumb } from '../thumbs/Thumb';
import { promptTaxonomy, sampleTimes, toDraftDetections, type DetectItem } from './convert';
import { frameThumb, prepareItem } from './prepare';
import { startDetectRun, type DetectRunner, type RunProgress } from './runner';
import { detections, dispatch, noteAssessed } from './store';
import { aiPassName } from '@aio/annotate/detections';

export type DetectScope = 'selected' | 'current' | 'unreviewed' | 'frames';

const PREVIEW_IMAGES = 12;
/** Sizes assumed for the estimate when a photo has not been opened yet. */
const PHOTO_GUESS = { width: 2560, height: 1708 };
const FRAME_GUESS = { width: 1920, height: 1080 };
const MAX_FRAMES = 500;

function FramePreview({ url, t }: { url: string; t: number }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    frameThumb(url, t).then(
      (s) => {
        if (live) setSrc(s);
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [url, t]);
  return <div className="m-thumb">{src && <img src={src} alt="" />}</div>;
}

/** The vision route from Settings, or null when none is set. */
function visionRoute(
  routes: Parameters<typeof routeFor>[0],
): { provider: string; model: string } | null {
  try {
    return routeFor(routes, 'vision');
  } catch {
    return null;
  }
}

export function AiDetectDialog({
  projectId,
  layers,
  selected,
  current,
  unreviewed,
  durations,
  videoUrl,
  onClose,
}: {
  projectId: string;
  layers: readonly Layer[];
  selected: readonly DetectItem[];
  current: DetectItem | null;
  unreviewed: readonly DetectItem[];
  /** Clip lengths in ms by video layer id. */
  durations: Readonly<Record<string, number>>;
  videoUrl: (layerId: string) => string | null;
  onClose: () => void;
}) {
  const t = useT();
  const manifest = useWorkspace((s) => s.project?.manifest);
  const routes = useShell((s) => s.settings.routes);
  const clips = layers.filter((l): l is Extract<Layer, { kind: 'video' }> => l.kind === 'video');
  const [scope, setScope] = useState<DetectScope>(
    selected.length > 0
      ? 'selected'
      : current
        ? 'current'
        : unreviewed.length > 0
          ? 'unreviewed'
          : 'frames',
  );
  const [clip, setClip] = useState(clips[0]?.id ?? '');
  const [everyS, setEveryS] = useState(10);
  const [batch, setBatch] = useState(DEFAULT_BATCH);
  const [hint, setHint] = useState('');
  const [progress, setProgress] = useState<RunProgress | null>(null);
  const [retry, setRetry] = useState<DetectItem[] | null>(null);
  const runner = useRef<DetectRunner | null>(null);
  const dlg = useRef<HTMLDivElement>(null);
  useFocusTrap(dlg, true);
  const status = useCall('ai:status', { projectId, task: 'vision' }, projectId);

  const route = visionRoute(routes);
  const taxonomy = useMemo(
    () => promptTaxonomy(manifest?.severityModels ?? [], manifest?.classCatalogues ?? []),
    [manifest],
  );
  const prompt: DetectPromptInput = { ...taxonomy, hint };

  const frames = useMemo<DetectItem[]>(() => {
    const ms = durations[clip];
    if (!clip || ms === undefined) return [];
    return sampleTimes(ms / 1000, everyS, MAX_FRAMES).map((tt) => ({
      kind: 'frame',
      layer: clip,
      t: tt,
    }));
  }, [clip, everyS, durations]);

  const items: readonly DetectItem[] =
    retry ??
    (scope === 'selected'
      ? selected
      : scope === 'current'
        ? current
          ? [current]
          : []
        : scope === 'unreviewed'
          ? unreviewed
          : frames);

  const estimate = route
    ? estimateDetect({
        provider: route.provider,
        model: route.model,
        images: items.map((i) => (i.kind === 'photo' ? PHOTO_GUESS : FRAME_GUESS)),
        prompt,
        batchSize: batch,
      })
    : null;

  const ready = status?.ok ? status.value.ready : false;
  const blocked = status?.ok
    ? status.value.ready
      ? null
      : (status.value.message ?? t('det.ai.notReady'))
    : status
      ? status.error
      : null;
  const noClasses = taxonomy.classes.length === 0;
  const running = progress?.phase === 'running';
  const canSend = ready && !noClasses && items.length > 0 && !running;

  const send = () => {
    if (!canSend || !manifest) return;
    // a run id that sorts by time: the pass file is ai-<run>.json
    const stamp = new Date()
      .toISOString()
      .replace(/[-:]/g, '')
      .replace(/\..*$/, '')
      .replace('T', '-');
    const runId = `${stamp}-${globalThis.crypto.randomUUID().slice(0, 6)}`;
    const pass = aiPassName(runId);
    noteAssessed(
      pass,
      items.flatMap((i) => (i.kind === 'photo' ? [i.photo] : [])),
    );
    setRetry(null);
    runner.current = startDetectRun(
      {
        runId,
        pass,
        projectId,
        items,
        classes: taxonomy.classes,
        severity: taxonomy.severity,
        hint,
        batchSize: batch,
      },
      {
        detect: async (req) => {
          const r = await bridge.call('ai:detect', req);
          return r.ok ? r.value : { ok: false, error: r.error };
        },
        cancel: (id) => {
          void bridge.call('ai:cancel', { runId: id });
        },
        prepare: (item) => prepareItem(projectId, layers, item),
        convert: (res, byKey, sizes) =>
          toDraftDetections({
            results: res.results,
            items: byKey,
            sizes,
            models: manifest.severityModels,
            catalogues: manifest.classCatalogues,
            provider: res.provider,
            model: res.model,
            promptVersion: res.promptVersion,
            runId,
            pass,
            now: new Date().toISOString(),
            existing: detections.getState().review.detections,
            newId: () => globalThis.crypto.randomUUID(),
          }),
        add: (list, run) => {
          dispatch({
            type: 'add',
            detections: list,
            label: t('det.ai.undoLabel'),
            ...(run ? { run } : {}),
          });
        },
        progress: setProgress,
        now: () => new Date().toISOString(),
      },
    );
    void runner.current.done.then((p) => {
      if (p.remaining.length > 0) setRetry(p.remaining);
    });
  };

  const close = () => {
    if (running) return;
    onClose();
  };

  const providerName =
    route && route.provider in PROVIDER_LABELS
      ? PROVIDER_LABELS[route.provider as keyof typeof PROVIDER_LABELS]
      : (route?.provider ?? '');
  const previewItems = items.slice(0, PREVIEW_IMAGES);
  const cost =
    estimate?.costUsd === undefined
      ? t('det.ai.costUnknown')
      : estimate.costUsd < 0.01
        ? t('det.ai.costUnderCent')
        : t('det.ai.cost', { usd: estimate.costUsd.toFixed(2) });

  return (
    <div
      className="dlg-scrim"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div
        ref={dlg}
        className="dlg wide det-ai"
        role="dialog"
        aria-modal="true"
        aria-labelledby="det-ai-h"
        data-testid="det-ai-dialog"
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Escape') close();
        }}
      >
        <div className="dlg-h">
          <Icon name="agent" size={16} />
          <h2 id="det-ai-h">{t('det.ai.title')}</h2>
          {route && (
            <span className="sub mono">
              {providerName} · {modelLabel(route.model)}
            </span>
          )}
          <button
            type="button"
            className="btn ghost icon sm"
            aria-label={t('det.close')}
            disabled={running}
            onClick={close}
          >
            <Icon name="x" size={14} />
          </button>
        </div>

        {progress ? (
          <div className="dlg-b" data-testid="det-ai-progress">
            <section className="dlg-sec">
              <h3 className="caps">{t(`det.ai.phase.${progress.phase}`)}</h3>
              <div className="det-bar" aria-hidden="true">
                <i
                  style={{
                    width: `${String(progress.images ? (100 * progress.imagesDone) / progress.images : 0)}%`,
                  }}
                />
              </div>
              <p>
                {t('det.ai.progress', {
                  done: progress.imagesDone,
                  total: progress.images,
                  found: progress.found,
                })}
              </p>
              <p className="mono">
                {t('det.ai.usage', {
                  input: formatCount(progress.inputTokens),
                  output: formatCount(progress.outputTokens),
                  usd: progress.costUsd.toFixed(3),
                })}
                {!progress.costKnown && ` ${t('det.ai.lowerBound')}`}
              </p>
              {progress.skipped > 0 && <p>{t('det.ai.skipped', { count: progress.skipped })}</p>}
              {progress.error && (
                <p className="ann-error det-ai-error" role="alert" data-testid="det-ai-error">
                  {progress.error}
                </p>
              )}
              {progress.warnings.length > 0 && (
                <details>
                  <summary>{t('det.ai.warnings', { count: progress.warnings.length })}</summary>
                  <ul className="det-warn">
                    {progress.warnings.slice(0, 50).map((w, i) => (
                      <li key={i}>{w}</li>
                    ))}
                  </ul>
                </details>
              )}
            </section>
          </div>
        ) : (
          <div className="dlg-b">
            {noClasses && <p className="ann-error">{t('det.ai.noClasses')}</p>}
            {blocked && (
              <p className="ann-error" role="alert" data-testid="det-ai-blocked">
                {blocked}
              </p>
            )}
            <section className="dlg-sec">
              <h3 className="caps">{t('det.ai.what')}</h3>
              <div className="det-scope" role="radiogroup" aria-label={t('det.ai.what')}>
                {(
                  [
                    ['selected', selected.length],
                    ['current', current ? 1 : 0],
                    ['unreviewed', unreviewed.length],
                    ['frames', frames.length],
                  ] as const
                ).map(([s, n]) => (
                  <label key={s} className="ann-check">
                    <input
                      type="radio"
                      name="det-scope"
                      checked={scope === s && !retry}
                      disabled={s === 'frames' ? clips.length === 0 : n === 0}
                      onChange={() => {
                        setRetry(null);
                        setScope(s);
                      }}
                    />
                    {t(`det.ai.scope.${s}`, { count: n })}
                  </label>
                ))}
              </div>
              {scope === 'frames' && clips.length > 0 && (
                <div className="det-row">
                  <select
                    className="ann-select"
                    value={clip}
                    aria-label={t('det.ai.clip')}
                    onChange={(e) => {
                      setClip(e.target.value);
                    }}
                  >
                    {clips.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                  <label className="ann-check">
                    {t('det.ai.every')}
                    <input
                      className="ann-input det-num"
                      type="number"
                      min={1}
                      max={600}
                      value={everyS}
                      onChange={(e) => {
                        setEveryS(Math.max(1, Number(e.target.value) || 1));
                      }}
                    />
                    {t('det.ai.seconds')}
                  </label>
                </div>
              )}
              <div className="det-row">
                <label className="ann-check">
                  {t('det.ai.batch')}
                  <select
                    className="ann-select"
                    value={batch}
                    onChange={(e) => {
                      setBatch(Number(e.target.value));
                    }}
                  >
                    {[1, 2, 4, 8].map((n) => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ))}
                  </select>
                </label>
                <input
                  className="ann-input grow"
                  placeholder={t('det.ai.hint')}
                  aria-label={t('det.ai.hint')}
                  value={hint}
                  maxLength={2000}
                  onChange={(e) => {
                    setHint(e.target.value);
                  }}
                />
              </div>
            </section>

            <section className="dlg-sec" data-testid="det-ai-estimate">
              <h3 className="caps">{t('det.ai.estimate')}</h3>
              {estimate ? (
                <p>
                  {t('det.ai.estimateLine', {
                    images: items.length,
                    count: estimate.requests,
                    input: formatCount(estimate.inputTokens),
                    output: formatCount(estimate.outputTokens),
                  })}{' '}
                  <b>{cost}</b>
                </p>
              ) : (
                <p>{t('det.ai.noRoute')}</p>
              )}
              <p className="ann-faint">{t('det.ai.estimateNote')}</p>
            </section>

            <section className="dlg-sec det-preview" data-testid="det-ai-preview">
              <h3 className="caps">{t('det.ai.preview')}</h3>
              <p>{t('det.ai.previewLead', { provider: providerName, size: SEND_MAX_PX })}</p>
              <div className="det-prev-grid">
                {previewItems.map((it) => {
                  const layer = layers.find((l) => l.id === it.layer);
                  const photo =
                    it.kind === 'photo' && layer?.kind === 'photos'
                      ? layer.items.find((p) => p.id === it.photo)
                      : undefined;
                  const url = it.kind === 'frame' ? videoUrl(it.layer) : null;
                  return (
                    <figure key={`${it.layer}:${it.kind === 'photo' ? it.photo : String(it.t)}`}>
                      {photo ? (
                        <MediaThumb projectId={projectId} asset={photo.src} icon="photo" />
                      ) : url && it.kind === 'frame' ? (
                        <FramePreview url={url} t={it.t} />
                      ) : null}
                      <figcaption className="mono">
                        {it.kind === 'photo' ? it.photo : `${it.t.toFixed(1)} s`}
                      </figcaption>
                    </figure>
                  );
                })}
              </div>
              {items.length > PREVIEW_IMAGES && (
                <p className="ann-faint">
                  {t('det.ai.more', { count: items.length - PREVIEW_IMAGES })}
                </p>
              )}
              <details>
                <summary>{t('det.ai.text')}</summary>
                <pre className="det-pre">{detectInstructions(prompt)}</pre>
                <pre className="det-pre">
                  {detectUserText(Math.min(batch, Math.max(1, items.length)), hint)}
                </pre>
              </details>
            </section>
          </div>
        )}

        <div className="dlg-f">
          {progress?.phase === 'running' ? (
            <>
              <span className="grow" />
              <button
                type="button"
                className="btn"
                onClick={() => {
                  runner.current?.stop();
                }}
              >
                {t('det.ai.stop')}
              </button>
            </>
          ) : progress ? (
            <>
              <span className="grow" />
              {retry && retry.length > 0 && (
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    setProgress(null);
                  }}
                >
                  {t('det.ai.sendRest', { count: retry.length })}
                </button>
              )}
              <button
                type="button"
                className="btn primary"
                data-testid="det-ai-close"
                onClick={onClose}
              >
                {t('det.ai.review')}
              </button>
            </>
          ) : (
            <>
              <span className="grow ann-faint">{t('det.ai.draftNote')}</span>
              <button type="button" className="btn ghost" onClick={onClose}>
                {t('det.cancel')}
              </button>
              <button
                type="button"
                className="btn primary"
                data-testid="det-ai-send"
                disabled={!canSend}
                onClick={send}
              >
                <Icon name="send" size={12} />
                {t('det.ai.send', { count: items.length })}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
