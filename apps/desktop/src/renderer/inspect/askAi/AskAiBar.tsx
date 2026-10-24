/**
 * Ask AI on the Inspect screen: one button runs the check remembered for this project on the
 * scope in view (this photo, the picks, all photos, or frames of a clip or walk). Which AI looks
 * is not asked here: the Settings default and what is installed decide (`resolveBackend`). A run
 * on this computer starts at once; a cloud run first shows the one-line confirm under the bar,
 * built from the same check and scope Send then starts. When nothing can look (or the detectors
 * cannot run: no Analytics pack, a Mac, a graphics card refused), the button is off with the
 * reason, in its tip and on the line under the bar, with a way to Settings. What can look follows
 * the AI settings and the models installed while the screen is open.
 */
import { useAnnotateReadOnly } from '@aio/annotate';
import type { Layer, ProjectManifest } from '@aio/schema';
import { Icon, Tip, useT, type PhotoPick } from '@aio/ui';
import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { analyticsPack, useAnalyticsPack } from '../../analyticsPack';
import type { DetectItem } from '../../detections/convert';
import { shell, useCall, useShell } from '../../shell';
import { useModelsRevision } from './modelsRevision';
import { cloudConfirm, reasonKey, resolveBackend, type Availability } from './backend';
import { checkOptions, sameCheck, type AskCheck } from './checks';
import { classMapFor } from './classMap';
import { CloudConfirm } from './CloudConfirm';
import { clipItems, frameCap, walkItems, WALK_EVERY } from './frames';
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
  // off until a run has ended, a stopping one included
  const running = useAskAiRun(
    (s) => s.run?.phase === 'running' || s.run?.phase === 'queued' || s.run?.phase === 'stopping',
  );
  // what can look is read again when the AI settings or the local models change
  const aiKey = useShell((s) =>
    JSON.stringify([
      s.settings.cloudAi,
      s.settings.offlineOnly === true,
      s.settings.routes,
      s.settings.localModel,
      s.settings.inference?.provider,
    ]),
  );
  const modelsRev = useModelsRevision();
  const models = useCall('inference:models', {}, `${projectId}|${String(modelsRev)}|${aiKey}`);
  const dets = useCall('detectors:list', { projectId }, projectId);
  // The project's own cloud AI policy is `aiPolicy` in its manifest.json, which main reads on each
  // `ai:status` (the schema strips it from the manifest here): a reloaded manifest asks again.
  const statusKey = useMemo(() => ({ projectId, aiKey, manifest }), [projectId, aiKey, manifest]);
  const status = useCall('ai:status', { projectId, task: 'vision' }, statusKey);

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

  // the detectors run in the Analytics pack, on an NVIDIA card: checked once some are listed
  const hasDetectors = (avail?.detectors.length ?? 0) > 0;
  useEffect(() => {
    if (hasDetectors) void analyticsPack.getState().load();
  }, [hasDetectors]);
  const pack = useAnalyticsPack((s) => s.status);
  const packError = useAnalyticsPack((s) => s.error);
  const hardware = useAnalyticsPack((s) => s.hardware);
  const hardwareError = useAnalyticsPack((s) => s.hardwareError);
  const refused = hardware && !hardware.ok ? hardware : null;
  const tooBusy = refused?.code === 'tooBusy' ? refused.reason : null;
  /** Why no detector can run here; `checking` while the pack and the card are read. */
  const packBlock: { reason: string; checking?: true } | null = !hasDetectors
    ? null
    : pack === null || (hardware === null && hardwareError === null)
      ? packError !== null
        ? { reason: packError }
        : { reason: t('askAi.detectors.checking'), checking: true }
      : refused?.code === 'mac'
        ? { reason: refused.reason }
        : !pack.installed
          ? { reason: pack.unusable[0]?.reason ?? t('detect.preset.pack.missing') }
          : hardwareError !== null
            ? { reason: t('detect.preset.settings.hw.failed') }
            : refused && tooBusy === null
              ? { reason: refused.reason }
              : null;

  const resolve = (a: Availability) =>
    resolveBackend({
      pref: prefs.backend,
      check,
      items,
      layers,
      avail: a,
      localModel: prefs.localModel,
      classMapOf: (id) => {
        const m = a.local.models.find((x) => x.id === id);
        return m ? classMapFor(projectId, m, classes) : {};
      },
      assetTypes,
    });
  const listed = avail ? resolve(avail) : null;
  // Detectors chosen while the pack, the Mac or the card says no: a check naming a detector is
  // blocked with that reason; any other check falls back to the local model, then the cloud (which
  // still asks first), and says the pack's reason only when nothing else can look. While the pack
  // and the card are still read, Ask AI waits rather than guess.
  const withoutDetectors =
    avail && listed?.kind === 'detectors' && packBlock && !packBlock.checking
      ? check.kind === 'detector'
        ? null
        : resolve({ ...avail, detectors: [] })
      : null;
  const backend = withoutDetectors && withoutDetectors.kind !== 'none' ? withoutDetectors : listed;
  const detectorBlock = backend?.kind === 'detectors' ? packBlock : null;
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
  const off =
    readOnly ||
    running ||
    !backend ||
    backend.kind === 'none' ||
    detectorBlock !== null ||
    items.length === 0;

  /** Set at once on Ask AI and Send, so a second click before the run shows starts nothing. */
  const starting = useRef(false);
  const start = async (confirmed: boolean) => {
    if (!backend || backend.kind === 'none' || starting.current) return;
    starting.current = true;
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
    } finally {
      // the run has ended (or did not start): the bar's state takes over again
      starting.current = false;
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

  // a frames run that stops short of the end says so
  const cap = scope === 'frames' && source ? frameCap(source, everyS) : null;
  const title = readOnly ? t('inspect.readOnly') : (why ?? detectorBlock?.reason);
  // off with a reason: aria-disabled, so the button still takes hover and focus for its tip
  const askButton = (
    <button
      type="button"
      className="btn sm ask-btn"
      data-testid="ask-ai"
      disabled={off && !title}
      aria-disabled={off && title ? true : undefined}
      onClick={ask}
    >
      <Icon name="agent" size={14} className="ask-spark" />
      {t('askAi.button')}
    </button>
  );
  return (
    <div className="ask-bar" ref={bar}>
      <div className="ask-bar-row">
        <div className="ask-btn-group">
          {title ? <Tip content={title}>{askButton}</Tip> : askButton}
          <Tip
            content={option ? t('askAi.checks.current', { name: option.label }) : t('askAi.checks')}
            repeatsName={!option}
          >
            <button
              type="button"
              className="btn sm ask-caret"
              data-testid="ask-ai-checks"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              aria-label={t('askAi.checks')}
              disabled={readOnly || running}
              onClick={() => {
                setMenuOpen((o) => !o);
                setFramesOpen(false);
              }}
            >
              <Icon name="chev-d" size={12} />
            </button>
          </Tip>
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
                    <Tip key={n} content={t('askAi.frames.every', { s: n })}>
                      <button
                        type="button"
                        aria-pressed={everyS === n}
                        data-testid={`ask-ai-frames-every-${String(n)}`}
                        onClick={() => {
                          setEveryPick(n);
                        }}
                      >
                        {n}
                      </button>
                    </Tip>
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
      ) : backend?.kind === 'none' && backend.reason !== 'nothing' ? (
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
      ) : detectorBlock && !detectorBlock.checking ? (
        // the pack and the card live in Settings, Processing tools
        <p className="ask-note" data-testid="ask-ai-blocked">
          <span>{detectorBlock.reason}</span>
          <button
            type="button"
            className="btn link sm"
            data-testid="ask-ai-settings"
            onClick={() => {
              shell.getState().openSettingsPage('tools');
            }}
          >
            {t('askAi.openTools')}
          </button>
        </p>
      ) : (
        backend?.kind === 'detectors' &&
        tooBusy !== null && (
          // the gate queues the run until the card is free: said, not blocked
          <p className="ask-note" data-testid="ask-ai-busy">
            {tooBusy}
          </p>
        )
      )}
      {cap !== null && (
        <p className="ask-note" data-testid="ask-ai-frames-capped">
          {t('askAi.frames.capped', { max: cap })}
        </p>
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
