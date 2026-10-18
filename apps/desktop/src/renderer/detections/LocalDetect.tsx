/**
 * The Local model side of the Detect dialog (BLD-10): an imported ONNX detector runs on this
 * computer (inference utility process). No AI-6 preview or cost estimate: nothing leaves the
 * machine and the run is free. Results land in `detections/model-<run>.json` as waiting
 * detections; the review reads them when the run ends. Stop keeps the photos done; "Run the
 * remaining" continues the same run. "360 video frames" runs on frames of a walk layer: one frame
 * every N seconds, or the frame the 360 pane shows now.
 */
import type { DetectorModelInfo, IpcEvent, Layer } from '@aio/schema';
import { NEW_CLASS_OPTION, NewClassRow, useNewClass } from '@aio/annotate';
import { Icon, t, useFocusTrap } from '@aio/ui';
import { useWorkspace } from '@aio/workspace';
import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from 'zustand';
import { providerLabel } from '../screens/settings/DetectionModels';
import '../screens/settings/detectionModels.css';
import { bridge, useCall } from '../shell';
import { walkPlayback } from '../walks/walkPlayback';
import { sampleTimes, type DetectItem } from './convert';
import { loadDetections } from './store';

export type DetectMode = 'cloud' | 'local';

const MODE_KEY = 'stratlas.detect.mode';
const MODEL_KEY = 'stratlas.detect.model';
const classMapKey = (projectId: string, model: string) =>
  `stratlas.detect.classMap.${projectId}.${model}`;

function readStore(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}
function writeStore(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // a remembered choice is a convenience only
  }
}

/**
 * A class was made from a model's word (Create class in the review): every local model of this
 * project that keeps that word as it is ("keep the name") now maps it to the new class. A word
 * mapped to a class on purpose is left alone.
 */
export function mapModelClass(projectId: string, raw: string, classId: string): void {
  const prefix = `stratlas.detect.classMap.${projectId}.`;
  let keys: string[];
  try {
    keys = Object.keys(window.localStorage).filter((k) => k.startsWith(prefix));
  } catch {
    return;
  }
  const word = raw.trim().toLowerCase();
  for (const key of keys) {
    let map: Record<string, string>;
    try {
      map = JSON.parse(readStore(key) ?? '{}') as Record<string, string>;
    } catch {
      continue;
    }
    const hit = Object.keys(map).find((k) => k.trim().toLowerCase() === word);
    if (hit === undefined || map[hit]) continue;
    writeStore(key, JSON.stringify({ ...map, [hit]: classId }));
  }
}

export const readMode = (): DetectMode => (readStore(MODE_KEY) === 'local' ? 'local' : 'cloud');

/** Cloud vision or Local model, at the top of the Detect dialog. */
export function ModeSwitch({
  mode,
  disabled,
  onChange,
}: {
  mode: DetectMode;
  disabled?: boolean;
  onChange: (m: DetectMode) => void;
}) {
  return (
    <div className="det-scope infer-row" role="radiogroup" aria-label={t('infer.dlg.source')}>
      {(['cloud', 'local'] as const).map((m) => (
        <label key={m} className="ann-check">
          <input
            type="radio"
            name="det-mode"
            data-testid={`det-mode-${m}`}
            checked={mode === m}
            disabled={disabled}
            onChange={() => {
              writeStore(MODE_KEY, m);
              onChange(m);
            }}
          />
          {t(m === 'cloud' ? 'infer.dlg.cloud' : 'infer.dlg.local')}
        </label>
      ))}
    </div>
  );
}

type Scope = 'selected' | 'current' | 'unreviewed' | 'walk';
type WalkLayer = Extract<Layer, { kind: 'walk' }>;

/** Intervals offered for walk frames, in seconds. */
export const WALK_EVERY = [1, 2, 5, 10] as const;
/**
 * At most this many walk frames per run. A local run costs nothing, so the cap is higher than the
 * cloud's 500: it covers a 33 minute walk at one frame a second, while one run stays a bounded
 * job (a few hundred ms a frame: minutes, not hours) and a bounded list of items over IPC.
 */
export const MAX_WALK_FRAMES = 2000;

/** Frames of a walk to check: one every `everyS` seconds, or only the time `at`. */
export function walkItems(
  walk: { id: string; durationS: number },
  pick: { everyS: number } | { at: number },
): DetectItem[] {
  const times =
    'at' in pick
      ? [Math.round(pick.at * 1000) / 1000]
      : sampleTimes(walk.durationS, pick.everyS, MAX_WALK_FRAMES);
  return times.map((t) => ({ kind: 'frame', layer: walk.id, t }));
}
type Phase = 'running' | 'done' | 'stopped' | 'failed';

interface Progress {
  phase: Phase;
  done: number;
  total: number;
  found: number;
  /** Stop was pressed; the run ends after the photo in hand. */
  stopping?: boolean;
  /** The run checks walk frames, so progress counts frames. */
  frames?: boolean;
  error?: string;
}

/** The project class a model class maps to by default: same id or label, else none. */
function defaultClass(name: string, classes: readonly { id: string; label: string }[]): string {
  const n = name.trim().toLowerCase();
  return (
    classes.find((c) => c.id.toLowerCase() === n || c.label.trim().toLowerCase() === n)?.id ?? ''
  );
}

function runStamp(): string {
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\..*$/, '')
    .replace('T', '-');
  return `${stamp}-${globalThis.crypto.randomUUID().slice(0, 6)}`;
}

export function LocalDetectDialog({
  projectId,
  layers,
  selected,
  current,
  unreviewed,
  onMode,
  onClose,
}: {
  projectId: string;
  /** The project's layers: its walk layers are offered as 360 video frames. */
  layers: readonly Layer[];
  selected: readonly DetectItem[];
  current: DetectItem | null;
  unreviewed: readonly DetectItem[];
  onMode: (m: DetectMode) => void;
  onClose: () => void;
}) {
  const manifest = useWorkspace((s) => s.project?.manifest);
  const { create, disabledReason } = useNewClass();
  const [newFor, setNewFor] = useState<string | null>(null);
  const projectClasses = useMemo(
    () => (manifest?.classCatalogues ?? []).flatMap((c) => c.classes),
    [manifest],
  );
  const photos = (list: readonly (DetectItem | null)[]) =>
    list.flatMap((i) => (i?.kind === 'photo' ? [i] : []));
  const walks = useMemo(
    () => layers.filter((l): l is WalkLayer => l.kind === 'walk' && l.durationS > 0),
    [layers],
  );
  const [walkId, setWalkId] = useState(walks[0]?.id ?? '');
  const walk = walks.find((w) => w.id === walkId) ?? walks[0];
  const [everyS, setEveryS] = useState<number>(2);
  const [atNow, setAtNow] = useState(false);
  const playing = useStore(walkPlayback);
  // the current frame is offered only while the 360 pane plays the chosen walk
  const nowT = playing.layerId !== null && playing.layerId === walk?.id ? playing.t : null;
  const useNow = atNow && nowT !== null;
  const walkFrames = useMemo(
    () => (walk ? walkItems(walk, nowT !== null && atNow ? { at: nowT } : { everyS }) : []),
    [walk, atNow, nowT, everyS],
  );
  const capped =
    !!walk &&
    !useNow &&
    sampleTimes(walk.durationS, everyS, MAX_WALK_FRAMES + 1).length > MAX_WALK_FRAMES;
  const counts: Record<Scope, number> = {
    selected: photos(selected).length,
    current: photos([current]).length,
    unreviewed: photos(unreviewed).length,
    walk: walkFrames.length,
  };
  const [scope, setScope] = useState<Scope>(
    counts.selected > 0
      ? 'selected'
      : counts.current > 0
        ? 'current'
        : counts.unreviewed === 0 && walks.length > 0
          ? 'walk'
          : 'unreviewed',
  );
  const items =
    scope === 'selected'
      ? photos(selected)
      : scope === 'current'
        ? photos([current])
        : scope === 'walk'
          ? walkFrames
          : photos(unreviewed);

  const res = useCall('inference:models', {}, projectId);
  const runtime = res?.ok ? res.value.runtime : null;
  const models = useMemo<DetectorModelInfo[]>(() => (res?.ok ? res.value.models : []), [res]);
  const [modelId, setModelId] = useState<string>(readStore(MODEL_KEY) ?? '');
  const model = models.find((m) => m.id === modelId) ?? models[0];
  const [minConfidence, setMinConfidence] = useState<number | null>(null);
  const [tile, setTile] = useState(false);
  const [tileSize, setTileSize] = useState<number | null>(null);
  const [overlap, setOverlap] = useState<number | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const run = useRef<{ id: string; items: typeof items } | null>(null);
  const dlg = useRef<HTMLDivElement>(null);
  useFocusTrap(dlg, true);

  // the remembered (or default) class mapping of this project and model, with this dialog's edits
  const [edits, setEdits] = useState<Record<string, Record<string, string>>>({});
  const classMap = useMemo<Record<string, string>>(() => {
    if (!model) return {};
    let stored: Record<string, string> = {};
    try {
      stored = JSON.parse(readStore(classMapKey(projectId, model.id)) ?? '{}') as Record<
        string,
        string
      >;
    } catch {
      stored = {};
    }
    const mine = edits[model.id] ?? {};
    return Object.fromEntries(
      model.card.classes.map((c) => [c, mine[c] ?? stored[c] ?? defaultClass(c, projectClasses)]),
    );
  }, [model, projectId, projectClasses, edits]);
  const setClass = (modelClass: string, value: string) => {
    if (!model) return;
    setEdits((e) => ({ ...e, [model.id]: { ...e[model.id], [modelClass]: value } }));
  };

  useEffect(
    () =>
      window.aio.on('inference:progress', (e: IpcEvent<'inference:progress'>) => {
        if (e.runId !== run.current?.id) return;
        setProgress((p) => (p ? { ...p, done: e.done, total: e.total, found: e.found } : p));
      }),
    [],
  );

  const conf = minConfidence ?? model?.card.minConfidence ?? 0.25;
  const size = tileSize ?? model?.card.input.width ?? 640;
  const ov = overlap ?? Math.round(size / 5);
  const running = progress?.phase === 'running';
  const available = runtime?.available === true;
  const remaining =
    progress && progress.phase !== 'running' && progress.done < progress.total
      ? progress.total - progress.done
      : 0;
  const canRun = available && !!model && items.length > 0 && !running;
  const ofFrames = progress?.frames === true;

  const start = async (resume: boolean) => {
    if (!model) return;
    const r = resume && run.current ? run.current : { id: runStamp(), items };
    run.current = r;
    writeStore(MODEL_KEY, model.id);
    writeStore(classMapKey(projectId, model.id), JSON.stringify(classMap));
    const frames = r.items[0]?.kind === 'frame';
    setProgress({ phase: 'running', done: 0, total: r.items.length, found: 0, frames });
    const res = await bridge.call('inference:run', {
      runId: r.id,
      projectId,
      model: model.id,
      items: r.items.map((i) =>
        i.kind === 'photo' ? { layer: i.layer, photo: i.photo } : { layer: i.layer, t: i.t },
      ),
      classMap: Object.fromEntries(Object.entries(classMap).filter(([, v]) => v !== '')),
      minConfidence: conf,
      ...(tile ? { tile: { size, overlap: Math.min(ov, size - 1) } } : {}),
    });
    // the review reads the pass the run wrote
    await loadDetections(projectId, true);
    setProgress((p) => {
      const base = p ?? {
        done: 0,
        total: r.items.length,
        found: 0,
        frames,
        phase: 'done' as Phase,
      };
      if (!res.ok) return { ...base, phase: 'failed', error: res.error };
      if (!res.value.ok) return { ...base, phase: 'failed', error: res.value.error };
      const stopped = base.stopping === true || base.done < base.total;
      return {
        ...base,
        stopping: false,
        phase: stopped ? 'stopped' : 'done',
        found: res.value.count,
      };
    });
  };

  const stop = () => {
    const id = run.current?.id;
    if (!id) return;
    setProgress((p) => (p ? { ...p, stopping: true } : p));
    void bridge.call('inference:cancel', { runId: id });
  };

  const close = () => {
    if (!running) onClose();
  };

  const blocked =
    res && !res.ok
      ? res.error
      : runtime && !runtime.available
        ? t('infer.dlg.unavailable', { problem: runtime.problem ?? '' })
        : res?.ok && models.length === 0
          ? t('infer.dlg.noModels')
          : null;

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
        aria-labelledby="det-local-h"
        data-testid="det-ai-dialog"
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Escape') close();
        }}
      >
        <div className="dlg-h">
          <Icon name="target" size={16} />
          <h2 id="det-local-h">{t('infer.dlg.title')}</h2>
          {model && <span className="sub mono">{model.card.name}</span>}
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
          <div className="dlg-b" data-testid="det-local-progress">
            <section className="dlg-sec">
              <h3 className="caps">{t(`infer.dlg.phase.${progress.phase}`)}</h3>
              <div className="det-bar" aria-hidden="true">
                <i
                  style={{
                    width: `${String(progress.total ? (100 * progress.done) / progress.total : 0)}%`,
                  }}
                />
              </div>
              <p>
                {t(ofFrames ? 'infer.dlg.progressFrames' : 'infer.dlg.progress', {
                  done: progress.done,
                  total: progress.total,
                  found: progress.found,
                })}
              </p>
              <p className="mono">{t('infer.dlg.cost')}</p>
              {progress.error && (
                <p className="ann-error" role="alert" data-testid="det-local-error">
                  {progress.error}
                </p>
              )}
            </section>
          </div>
        ) : (
          <div className="dlg-b">
            <section className="dlg-sec">
              <h3 className="caps">{t('infer.dlg.source')}</h3>
              <ModeSwitch mode="local" onChange={onMode} />
              {blocked ? (
                <p className="ann-error" role="alert" data-testid="det-local-blocked">
                  {blocked}
                </p>
              ) : (
                runtime?.available && (
                  <p data-testid="det-local-free">
                    {t('infer.dlg.free', { provider: providerLabel(runtime.provider) })}
                  </p>
                )
              )}
            </section>

            <section className="dlg-sec">
              <h3 className="caps">{t('infer.dlg.what')}</h3>
              <div className="det-scope" role="radiogroup" aria-label={t('infer.dlg.what')}>
                {(['selected', 'current', 'unreviewed', 'walk'] as const).map((s) => (
                  <label key={s} className="ann-check">
                    <input
                      type="radio"
                      name="det-local-scope"
                      data-testid={`det-local-scope-${s}`}
                      checked={scope === s}
                      disabled={s === 'walk' ? walks.length === 0 : counts[s] === 0}
                      onChange={() => {
                        setScope(s);
                      }}
                    />
                    {s === 'walk'
                      ? t('infer.dlg.scope.walk')
                      : t(`det.ai.scope.${s}`, { count: counts[s] })}
                  </label>
                ))}
              </div>
              {walks.length === 0 && <p className="ann-faint">{t('infer.dlg.noWalk')}</p>}
              {scope === 'walk' && walk && (
                <div className="det-walk" data-testid="det-local-walk-frames">
                  <label className="ann-check">
                    {t('infer.dlg.walk')}
                    <select
                      className="ann-select"
                      value={walk.id}
                      data-testid="det-local-walk"
                      onChange={(e) => {
                        setWalkId(e.target.value);
                      }}
                    >
                      {walks.map((w) => (
                        <option key={w.id} value={w.id}>
                          {w.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <div className="det-row">
                    <label className="ann-check">
                      <input
                        type="radio"
                        name="det-local-frames"
                        data-testid="det-local-every"
                        checked={!useNow}
                        onChange={() => {
                          setAtNow(false);
                        }}
                      />
                      {t('infer.dlg.every')}
                    </label>
                    <div className="seg" role="group" aria-label={t('infer.dlg.every')}>
                      {WALK_EVERY.map((n) => (
                        <button
                          key={n}
                          type="button"
                          aria-pressed={!useNow && everyS === n}
                          data-testid={`det-local-every-${String(n)}`}
                          onClick={() => {
                            setEveryS(n);
                            setAtNow(false);
                          }}
                        >
                          {n}
                        </button>
                      ))}
                    </div>
                    <span>{t('det.ai.seconds')}</span>
                    {!useNow && (
                      <span className="ann-faint mono" data-testid="det-local-frames-count">
                        {t('infer.dlg.framesCount', { count: walkFrames.length })}
                      </span>
                    )}
                  </div>
                  {capped && (
                    <p className="ann-faint" data-testid="det-local-frames-capped">
                      {t('infer.dlg.framesCapped', { max: MAX_WALK_FRAMES })}
                    </p>
                  )}
                  <label className="ann-check">
                    <input
                      type="radio"
                      name="det-local-frames"
                      data-testid="det-local-current-frame"
                      checked={useNow}
                      disabled={nowT === null}
                      onChange={() => {
                        setAtNow(true);
                      }}
                    />
                    {t('infer.dlg.currentFrame', { t: (nowT ?? 0).toFixed(1) })}
                  </label>
                </div>
              )}
              <p className="ann-faint">{t('infer.dlg.framesNote')}</p>
            </section>

            {model && (
              <section className="dlg-sec">
                <div className="infer-row">
                  <label className="ann-check">
                    {t('infer.dlg.model')}
                    <select
                      className="ann-select"
                      value={model.id}
                      data-testid="det-local-model"
                      onChange={(e) => {
                        setModelId(e.target.value);
                        setMinConfidence(null);
                        setTileSize(null);
                        setOverlap(null);
                      }}
                    >
                      {models.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.card.name} {m.card.version}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="ann-check">
                    {t('infer.dlg.minConfidence')}
                    <input
                      className="ann-input infer-num"
                      type="number"
                      min={0.01}
                      max={1}
                      step={0.05}
                      value={conf}
                      data-testid="det-local-conf"
                      onChange={(e) => {
                        const v = Number(e.target.value);
                        if (v > 0 && v <= 1) setMinConfidence(v);
                      }}
                    />
                  </label>
                </div>
                <div className="infer-row">
                  <label className="ann-check">
                    <input
                      type="checkbox"
                      checked={tile}
                      data-testid={scope === 'walk' ? 'det-local-walk-tile' : 'det-local-tile'}
                      onChange={(e) => {
                        setTile(e.target.checked);
                      }}
                    />
                    {t(scope === 'walk' ? 'infer.dlg.walkTile' : 'infer.dlg.tile')}
                  </label>
                  {tile && (
                    <>
                      <label className="ann-check">
                        {t('infer.dlg.tileSize')}
                        <input
                          className="ann-input infer-num"
                          type="number"
                          min={64}
                          max={8192}
                          value={size}
                          onChange={(e) => {
                            const v = Math.round(Number(e.target.value));
                            if (v >= 64 && v <= 8192) setTileSize(v);
                          }}
                        />
                        {t('infer.dlg.px')}
                      </label>
                      <label className="ann-check">
                        {t('infer.dlg.overlap')}
                        <input
                          className="ann-input infer-num"
                          type="number"
                          min={0}
                          max={4096}
                          value={ov}
                          onChange={(e) => {
                            const v = Math.round(Number(e.target.value));
                            if (v >= 0 && v <= 4096) setOverlap(v);
                          }}
                        />
                        {t('infer.dlg.px')}
                      </label>
                    </>
                  )}
                </div>
                {scope === 'walk' && <p className="ann-faint">{t('infer.dlg.walkTileHint')}</p>}
              </section>
            )}

            {model && (
              <section className="dlg-sec" data-testid="det-local-classes">
                <h3 className="caps">{t('infer.dlg.classes')}</h3>
                <p className="ann-faint">{t('infer.dlg.classesLead')}</p>
                <div className="infer-classes">
                  {model.card.classes.map((c) => (
                    <Fragment key={c}>
                      <label className="ann-check" style={{ display: 'contents' }}>
                        <span className="mono">{c}</span>
                        <select
                          className="ann-select"
                          aria-label={c}
                          value={classMap[c] ?? ''}
                          onChange={(e) => {
                            if (e.target.value === NEW_CLASS_OPTION) {
                              setNewFor(c);
                              return;
                            }
                            setClass(c, e.target.value);
                          }}
                        >
                          <option value="">{t('infer.dlg.keepName')}</option>
                          {projectClasses.map((pc) => (
                            <option key={pc.id} value={pc.id}>
                              {pc.label}
                            </option>
                          ))}
                          {create && <option value={NEW_CLASS_OPTION}>{t('det.class.new')}</option>}
                        </select>
                      </label>
                      {newFor === c && create && (
                        <div style={{ gridColumn: '1 / -1' }}>
                          <NewClassRow
                            startOpen
                            onCreate={create}
                            disabledReason={disabledReason}
                            testId="det-local-new-class"
                            onCancel={() => {
                              setNewFor(null);
                            }}
                            onCreated={(cls) => {
                              setNewFor(null);
                              setClass(c, cls.id);
                            }}
                          />
                        </div>
                      )}
                    </Fragment>
                  ))}
                </div>
              </section>
            )}
          </div>
        )}

        <div className="dlg-f">
          {running ? (
            <>
              <span className="grow" />
              <button
                type="button"
                className="btn"
                data-testid="det-local-stop"
                disabled={progress.stopping === true}
                onClick={stop}
              >
                {progress.stopping
                  ? t(ofFrames ? 'infer.dlg.stoppingFrame' : 'infer.dlg.stopping')
                  : t('infer.dlg.stop')}
              </button>
            </>
          ) : progress ? (
            <>
              <span className="grow" />
              {remaining > 0 && progress.phase === 'stopped' && (
                <button
                  type="button"
                  className="btn"
                  data-testid="det-local-rest"
                  onClick={() => void start(true)}
                >
                  {t('infer.dlg.runRest', { count: remaining })}
                </button>
              )}
              <button
                type="button"
                className="btn primary"
                data-testid="det-local-close"
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
                data-testid="det-local-run"
                disabled={!canRun}
                onClick={() => void start(false)}
              >
                <Icon name="target" size={12} />
                {t(scope === 'walk' ? 'infer.dlg.runFrames' : 'infer.dlg.run', {
                  count: items.length,
                })}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
