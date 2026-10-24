/**
 * Ask AI on the Inspect screen: one button runs the check remembered for this project on the
 * scope in view (this photo, the picks, all photos, or frames of a clip or walk). Which AI looks
 * is not asked here: the Settings default and what is installed decide (`resolveBackend`). A run
 * on this computer starts at once; a cloud run first shows the one-line confirm under the bar,
 * built from the same check and scope Send then starts. When nothing can look, the button is off
 * with the reason and a way to Settings.
 */
import { useAnnotateReadOnly } from '@aio/annotate';
import type { Layer, ProjectManifest } from '@aio/schema';
import { Icon, useT, type PhotoPick } from '@aio/ui';
import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import type { DetectItem } from '../../detections/convert';
import { shell, useCall } from '../../shell';
import { cloudConfirm, reasonKey, resolveBackend, type Availability } from './backend';
import { checkOptions, sameCheck, type AskCheck } from './checks';
import { classMapFor } from './classMap';
import { CloudConfirm } from './CloudConfirm';
import { clipItems, walkItems, WALK_EVERY } from './frames';
import { cloudConfirmSkipped, lastCheck, useAskAiPrefs } from './prefs';
import { startAskRun, useAskAiRun } from './runs';
import './askAi.css';

export type AskScope = 'photo' | 'selected' | 'all' | 'frames';

/** Intervals offered for a clip's frames, in seconds. */
const CLIP_EVERY = [2, 5, 10, 30] as const;
const WALK_DEFAULT = 2;
const CLIP_DEFAULT = 10;
const EVERYTHING: AskCheck = { kind: 'everything' };

type FrameSource =
  | { kind: 'walk'; id: string; name: string; durationS: number }
  | { kind: 'clip'; id: string; name: string; durationMs: number };

const photoItem = (p: PhotoPick): DetectItem => ({
  kind: 'photo',
  layer: p.layerId,
  photo: p.photoId,
});

function frameSources(
  layers: readonly Layer[],
  durations: Readonly<Record<string, number>>,
): FrameSource[] {
  return layers.flatMap((l): FrameSource[] => {
    if (l.kind === 'walk')
      return [{ kind: 'walk', id: l.id, name: l.name, durationS: l.durationS }];
    const ms = durations[l.id];
    if (l.kind === 'video' && ms !== undefined)
      return [{ kind: 'clip', id: l.id, name: l.name, durationMs: ms }];
    return [];
  });
}

export function AskAiBar({
  projectId,
  projectRoot,
  manifest,
  current,
  selected,
  all,
  durations,
}: {
  projectId: string;
  projectRoot: string;
  manifest: ProjectManifest;
  current: PhotoPick | null;
  selected: readonly PhotoPick[];
  all: readonly PhotoPick[];
  /** Clip lengths in ms by video layer id, from useMedia. */
  durations: Readonly<Record<string, number>>;
}): ReactElement {
  const t = useT();
  const readOnly = useAnnotateReadOnly();
  const prefs = useAskAiPrefs((p) => p);
  const running = useAskAiRun((s) => s.run?.phase === 'running' || s.run?.phase === 'queued');
  const models = useCall('inference:models', {}, projectId);
  const dets = useCall('detectors:list', { projectId }, projectId);
  const status = useCall('ai:status', { projectId, task: 'vision' }, projectId);

  const layers = manifest.layers;
  const classes = useMemo(
    () =>
      manifest.classCatalogues.flatMap((c) => c.classes.map((k) => ({ id: k.id, label: k.label }))),
    [manifest],
  );
  const assetTypes = useMemo(
    () => [...new Set(manifest.classCatalogues.map((c) => c.assetType))],
    [manifest],
  );

  // what can look, once the three answers are in
  const avail = useMemo<Availability | null>(() => {
    if (!models || !dets || !status) return null;
    const local: Availability['local'] = models.ok
      ? {
          available: models.value.runtime.available,
          models: models.value.models,
          ...(models.value.runtime.problem !== undefined
            ? { problem: models.value.runtime.problem }
            : {}),
        }
      : { available: false, models: [], problem: models.error };
    const route = status.ok ? status.value.route : undefined;
    const message = status.ok ? status.value.message : status.error;
    return {
      detectors: dets.ok ? dets.value.items : [],
      local,
      cloud: {
        ready: status.ok && status.value.ready,
        ...(message !== undefined ? { message } : {}),
        ...(route ? { provider: route.provider, model: route.model } : {}),
      },
    };
  }, [models, dets, status]);

  // the check: picked here, else the one last asked for in this project, else everything
  const options = useMemo(
    () => checkOptions(classes, avail?.detectors ?? [], prefs.backend),
    [classes, avail, prefs.backend],
  );
  const [picked, setPicked] = useState<AskCheck | null>(null);
  const remembered = useMemo(() => lastCheck(projectId), [projectId]);
  const option =
    options.find((o) => picked !== null && sameCheck(o.check, picked)) ??
    options.find((o) => remembered !== null && sameCheck(o.check, remembered)) ??
    options[0];
  const check: AskCheck = option?.check ?? EVERYTHING;
  const [menuOpen, setMenuOpen] = useState(false);

  // the scope: the picks when there are some, else this photo, until the person chooses
  const [chosen, setChosen] = useState<AskScope | null>(null);
  const fallback: AskScope = selected.length > 0 ? 'selected' : 'photo';
  const scope: AskScope =
    chosen === null || (chosen === 'selected' && selected.length === 0) ? fallback : chosen;
  const [framesOpen, setFramesOpen] = useState(false);
  const sources = useMemo(() => frameSources(layers, durations), [layers, durations]);
  const [sourceId, setSourceId] = useState<string | null>(null);
  const source = sources.find((s) => s.id === sourceId) ?? sources[0];
  const everyOptions: readonly number[] = source?.kind === 'walk' ? WALK_EVERY : CLIP_EVERY;
  const [everyPick, setEveryPick] = useState<number | null>(null);
  const everyS =
    everyPick !== null && everyOptions.includes(everyPick)
      ? everyPick
      : source?.kind === 'walk'
        ? WALK_DEFAULT
        : CLIP_DEFAULT;

  const frameItems = useMemo<DetectItem[]>(() => {
    if (!source) return [];
    return source.kind === 'walk'
      ? walkItems({ id: source.id, durationS: source.durationS }, { everyS })
      : clipItems(source.id, source.durationMs, everyS);
  }, [source, everyS]);
  const items = useMemo<DetectItem[]>(
    () =>
      scope === 'photo'
        ? current
          ? [photoItem(current)]
          : []
        : scope === 'selected'
          ? selected.map(photoItem)
          : scope === 'all'
            ? all.map(photoItem)
            : frameItems,
    [scope, current, selected, all, frameItems],
  );

  const backend = avail
    ? resolveBackend({
        pref: prefs.backend,
        check,
        items,
        layers,
        avail,
        localModel: prefs.localModel,
        classMapOf: (id) => {
          const m = avail.local.models.find((x) => x.id === id);
          return m ? classMapFor(projectId, m, classes) : {};
        },
        assetTypes,
      })
    : null;
  const why =
    backend?.kind === 'none'
      ? [t(reasonKey(backend.reason)), backend.message].filter(Boolean).join(' ')
      : null;

  // the cloud confirm, rebuilt from whatever is in view while it is open
  const [asking, setAsking] = useState(false);
  const cloudProvider = backend?.kind === 'cloud' ? backend.provider : null;
  const cloudModel = backend?.kind === 'cloud' ? backend.model : null;
  const confirm = useMemo(
    () =>
      asking && cloudProvider !== null && cloudModel !== null
        ? cloudConfirm({
            backend: { provider: cloudProvider, model: cloudModel },
            items,
            manifest,
            check,
            batchSize: prefs.cloudBatch,
          })
        : null,
    [asking, cloudProvider, cloudModel, items, manifest, check, prefs.cloudBatch],
  );
  // the confirm belongs to a cloud run: it goes when the run would no longer go to the cloud
  if (asking && avail && cloudProvider === null) setAsking(false);

  const [error, setError] = useState<string | null>(null);
  const off = readOnly || running || !backend || backend.kind === 'none' || items.length === 0;

  const start = async (confirmed: boolean) => {
    if (!backend || backend.kind === 'none') return;
    setError(null);
    try {
      await startAskRun({
        projectId,
        projectRoot,
        manifest,
        items,
        check,
        what: option?.label ?? '',
        backend,
        prefs,
        ...(confirmed ? { confirmed: true } : {}),
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const ask = () => {
    if (off) return;
    setMenuOpen(false);
    setFramesOpen(false);
    if (backend.kind === 'cloud' && !cloudConfirmSkipped(projectId)) setAsking(true);
    else void start(false);
  };

  // menus close on a click elsewhere and on Escape
  const bar = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menuOpen && !framesOpen) return;
    const down = (e: MouseEvent) => {
      if (e.target instanceof Node && bar.current?.contains(e.target)) return;
      setMenuOpen(false);
      setFramesOpen(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      setMenuOpen(false);
      setFramesOpen(false);
    };
    document.addEventListener('mousedown', down);
    document.addEventListener('keydown', key, true);
    return () => {
      document.removeEventListener('mousedown', down);
      document.removeEventListener('keydown', key, true);
    };
  }, [menuOpen, framesOpen]);

  const pickScope = (s: AskScope) => {
    setChosen(s);
    // Frames opens its popover; pressed again while open, it closes it
    setFramesOpen((open) => s === 'frames' && (!open || scope !== 'frames'));
    setMenuOpen(false);
  };
  const scopeButton = (s: AskScope, label: string, disabled: boolean) => (
    <button
      type="button"
      aria-pressed={scope === s}
      data-testid={`ask-ai-scope-${s}`}
      disabled={readOnly || disabled}
      onClick={() => {
        pickScope(s);
      }}
    >
      {label}
    </button>
  );

  const title = readOnly ? t('inspect.readOnly') : (why ?? undefined);
  return (
    <div className="ask-bar" ref={bar}>
      <div className="ask-bar-row">
        <div className="ask-btn-group">
          <button
            type="button"
            className="btn sm ask-btn"
            data-testid="ask-ai"
            disabled={off}
            title={title}
            onClick={ask}
          >
            <Icon name="agent" size={14} className="ask-spark" />
            {t('askAi.button')}
          </button>
          <button
            type="button"
            className="btn sm ask-caret"
            data-testid="ask-ai-checks"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-label={t('askAi.checks')}
            title={option ? `${t('askAi.checks')}: ${option.label}` : t('askAi.checks')}
            disabled={readOnly || running}
            onClick={() => {
              setMenuOpen((o) => !o);
              setFramesOpen(false);
            }}
          >
            <Icon name="chev-d" size={12} />
          </button>
          {menuOpen && (
            <div className="ask-menu" role="menu" aria-label={t('askAi.checks')}>
              <div className="ask-menu-head caps">{t('askAi.checks')}</div>
              {options.map((o, n) => (
                <button
                  key={`${o.check.kind}:${o.label}`}
                  type="button"
                  role="menuitemradio"
                  className="ask-menu-item"
                  aria-checked={o === option}
                  data-testid={`ask-ai-check-${String(n)}`}
                  onClick={() => {
                    setPicked(o.check);
                    setMenuOpen(false);
                  }}
                >
                  <Icon name="check" size={12} className="ask-tick" />
                  {o.label}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="ask-scope">
          <span className="caps">{t('askAi.scope')}</span>
          <div className="seg" role="group" aria-label={t('askAi.scope')}>
            {scopeButton('photo', t('askAi.scope.photo'), current === null)}
            {scopeButton(
              'selected',
              t('askAi.scope.selected', { count: selected.length }),
              selected.length === 0,
            )}
            {scopeButton('all', t('askAi.scope.all', { count: all.length }), all.length === 0)}
            {scopeButton('frames', t('askAi.scope.frames'), sources.length === 0)}
          </div>
          {framesOpen && source && (
            <div className="ask-frames" data-testid="ask-ai-frames">
              <label>
                {t('askAi.frames.source')}
                <select
                  data-testid="ask-ai-frames-source"
                  value={source.id}
                  onChange={(e) => {
                    setSourceId(e.target.value);
                  }}
                >
                  {sources.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </label>
              <div className="ask-frames-every">
                <div className="seg" role="group" aria-label={t('askAi.frames.every', { s: '' })}>
                  {everyOptions.map((n) => (
                    <button
                      key={n}
                      type="button"
                      aria-pressed={everyS === n}
                      data-testid={`ask-ai-frames-every-${String(n)}`}
                      title={t('askAi.frames.every', { s: n })}
                      onClick={() => {
                        setEveryPick(n);
                      }}
                    >
                      {n}
                    </button>
                  ))}
                </div>
                <span>{t('askAi.frames.every', { s: everyS })}</span>
              </div>
              <span className="mono" data-testid="ask-ai-frames-count">
                {t('askAi.frames.count', { count: frameItems.length })}
              </span>
            </div>
          )}
        </div>
      </div>

      {readOnly ? (
        <p className="ask-note ann-faint" data-testid="ask-ai-readonly">
          {t('inspect.readOnly')}
        </p>
      ) : (
        backend?.kind === 'none' &&
        backend.reason !== 'nothing' && (
          <p className="ask-note" data-testid="ask-ai-blocked">
            <span>{t('askAi.none', { reason: why ?? '' })}</span>
            <button
              type="button"
              className="btn link sm"
              data-testid="ask-ai-settings"
              onClick={() => {
                shell.getState().openSettingsPage('ai');
              }}
            >
              {t('askAi.openSettings')}
            </button>
          </p>
        )
      )}
      {error !== null && (
        <p className="ask-note err" role="alert" data-testid="ask-ai-error">
          {t('askAi.run.failed', { error })}
        </p>
      )}
      {confirm && !readOnly && (
        <CloudConfirm
          projectId={projectId}
          layers={layers}
          confirm={confirm}
          onSend={() => {
            setAsking(false);
            void start(true);
          }}
          onCancel={() => {
            setAsking(false);
          }}
        />
      )}
    </div>
  );
}
