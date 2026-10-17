/**
 * The Clean up panel (spec section 5): one point cloud layer's clip box, height range, box and
 * lasso selections, noise run and cleaned copy, with Undo, Redo and Reset all. It sits on the stage
 * (dark in every theme) under the toolbar. Every edit is one step of the layer's recipe through the
 * cleanup store; the stage tools themselves are bound by `mountCleanupScene` (CleanupHost).
 */
import { useAnnotateReadOnly } from '@aio/annotate';
import { formatBoxSize, type EngineStage } from '@aio/engine';
import { cloudWorldBounds, usePointcloudCounts } from '@aio/pointcloud';
import {
  DEFAULT_ELM,
  DEFAULT_OUTLIER,
  HeightRange,
  MAX_REGIONS,
  NOISE_CLASS,
  emptyCleanup,
  type Layer,
  type NoiseParams,
  type PointcloudCleanup,
} from '@aio/schema';
import { Icon, useT } from '@aio/ui';
import { useWorkspace } from '@aio/workspace';
import {
  useEffect,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
  type ReactNode,
  type Ref,
} from 'react';
import { boxToLocal, fitBox } from './cleanupFrame';
import { defaultJobsDeps, noiseShare, runNoise, saveCleaned } from './cleanupJobs';
import { cleanup, isCleanable, useCleanup } from './cleanupStore';
import './cleanup.css';

type CloudLayer = Extract<Layer, { kind: 'pointcloud' }>;

/** From this many selections on a layer the panel suggests saving a cleaned copy. */
const NEAR_REGIONS = 180;

/** The cloud the panel acts on: the store's, else the selected cloud, else the only one. */
export function useCleanupLayer(): { layer: CloudLayer | null; clouds: CloudLayer[] } {
  const layers = useWorkspace((s) => s.project?.manifest.layers);
  const selected = useWorkspace((s) => (s.selection?.kind === 'layer' ? s.selection.id : null));
  const active = useCleanup((s) => s.active);
  const clouds = (layers ?? []).filter((l): l is CloudLayer => l.kind === 'pointcloud');
  const layer =
    clouds.find((l) => l.id === active) ??
    clouds.find((l) => l.id === selected) ??
    (clouds.length === 1 ? (clouds[0] ?? null) : null);
  return { layer, clouds };
}

/** Re-render when the stage's tool changes. */
function useStageTool(stage: EngineStage | null): string | null {
  const [, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => stage?.onStateChange(bump), [stage]);
  return stage?.tool ?? null;
}

const num = (s: string): number | undefined => {
  const v = Number.parseFloat(s);
  return Number.isFinite(v) ? v : undefined;
};
/** A height field: empty is no limit, anything else must be a number. */
const parseHeight = (s: string): number | undefined | 'bad' => {
  const v = s.trim();
  if (!v) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : 'bad';
};
/** A noise setting within the schema's range (the default when it does not parse). */
const clamp = (s: string, fallback: number, lo: number, hi: number): number =>
  Math.min(hi, Math.max(lo, num(s) ?? fallback));
const fmt = (v: number | undefined) => (v === undefined ? '' : String(Math.round(v * 100) / 100));

/** File Z to the height the cloud is drawn at, and back (rounded so an offset adds no float noise). */
const toShown = (z: number, off: number): number => Math.round((z + off) * 1e6) / 1e6;
const toFile = (h: number, off: number): number =>
  off === 0 ? h : Math.round((h - off) * 1e6) / 1e6;

/** A recipe with or without its height range (no undefined keys in a recipe). */
function withHeight(r: PointcloudCleanup, min?: number, max?: number): PointcloudCleanup {
  const rest = { ...r };
  delete rest.height;
  if (min === undefined && max === undefined) return rest;
  return {
    ...rest,
    height: { ...(min !== undefined ? { min } : {}), ...(max !== undefined ? { max } : {}) },
  };
}

function Section({
  title,
  children,
  sectionRef,
  testId,
}: {
  title: string;
  children: ReactNode;
  sectionRef?: Ref<HTMLElement>;
  testId?: string;
}) {
  return (
    <section className="cleanup-sec" ref={sectionRef} data-testid={testId}>
      <span className="pop-title">{title}</span>
      {children}
    </section>
  );
}

export function CleanupPanel({
  stage,
  inTab = false,
}: {
  stage: EngineStage | null;
  /** In the sidebar's Clean up tab, not floating over the stage. */
  inTab?: boolean;
}) {
  const t = useT();
  const tool = useStageTool(stage);
  // chunks arriving re-render the panel, so the layer's bounds show once its header has loaded
  usePointcloudCounts(stage);
  const origin = useWorkspace((s) => s.project?.manifest.origin ?? null);
  const { layer, clouds } = useCleanupLayer();
  const id = layer?.id ?? null;
  const history = useCleanup((s) => (id ? s.layers[id] : undefined));
  const readOnly = useCleanup((s) => s.readOnly);
  // a look-only reviewer sees the cleanup but cannot change it (the store refuses it too)
  const lookOnly = useAnnotateReadOnly();
  const busy = useCleanup((s) => s.busy);
  const shape = useCleanup((s) => s.selectShape);
  const section = useCleanup((s) => s.section);
  const recipe = history?.present ?? null;
  const copc = layer ? isCleanable(layer) : false;
  const can = copc && !readOnly && !lookOnly;
  const [error, setError] = useState<string | null>(null);

  // keep the store's active layer in step with what the panel shows
  useEffect(() => {
    if (id && cleanup.store.getState().active !== id) cleanup.setActive(id);
  }, [id]);

  const base = (): PointcloudCleanup => recipe ?? emptyCleanup(id ?? '');
  const commit = (next: PointcloudCleanup | null) =>
    id ? cleanup.commit(id, next) : Promise.resolve(false);
  const bounds = stage && id ? cloudWorldBounds(stage, id) : null;
  const box = recipe?.clipBox;
  const regions = recipe?.regions.length ?? 0;

  // nothing to drag: an undo, a reset or Remove box took the box away while the gizmo was on
  useEffect(() => {
    if (stage && tool === 'clipbox' && !box) stage.setTool('select');
  }, [stage, tool, box]);

  /* ---------------------------------------------------------------- height range */
  // the recipe keeps file Z; the panel shows the height the cloud is drawn at (file Z + offset)
  const off = layer && 'heightOffsetM' in layer ? (layer.heightOffsetM ?? 0) : 0;
  const hMin = recipe?.height?.min;
  const hMax = recipe?.height?.max;
  const shownMin = hMin === undefined ? undefined : toShown(hMin, off);
  const shownMax = hMax === undefined ? undefined : toShown(hMax, off);
  const [minDraft, setMinDraft] = useState(fmt(shownMin));
  const [maxDraft, setMaxDraft] = useState(fmt(shownMax));
  const [name, setName] = useState(layer?.name ?? '');
  const [bad, setBad] = useState({ min: false, max: false });
  // another layer, or its range changed elsewhere (undo, redo): the fields follow, during render
  const shown = `${id ?? ''}|${layer?.name ?? ''}|${String(hMin)}|${String(hMax)}|${off}`;
  const [seen, setSeen] = useState(shown);
  if (seen !== shown) {
    const [seenId, seenName] = seen.split('|');
    setSeen(shown);
    setMinDraft(fmt(shownMin));
    setMaxDraft(fmt(shownMax));
    setBad({ min: false, max: false });
    if (seenId !== (id ?? '') || seenName !== (layer?.name ?? '')) {
      setName(layer?.name ?? '');
      setError(null);
    }
  }
  const commitHeight = (min: number | undefined, max: number | undefined) => {
    if (!id || !can) return;
    const check = HeightRange.safeParse({
      ...(min !== undefined ? { min } : {}),
      ...(max !== undefined ? { max } : {}),
    });
    if (!check.success) {
      setError(t('cleanup.height.order'));
      return;
    }
    setError(null);
    if (min === hMin && max === hMax) return;
    void commit(withHeight(base(), min, max));
  };
  /** Blur or Enter: only an end whose text the user changed is read; the other keeps its value. */
  const commitFields = () => {
    const minChanged = minDraft !== fmt(shownMin);
    const maxChanged = maxDraft !== fmt(shownMax);
    const typedMin = minChanged ? parseHeight(minDraft) : hMin;
    const typedMax = maxChanged ? parseHeight(maxDraft) : hMax;
    // typed values are shown heights: back to file Z for the recipe
    const min = minChanged && typeof typedMin === 'number' ? toFile(typedMin, off) : typedMin;
    const max = maxChanged && typeof typedMax === 'number' ? toFile(typedMax, off) : typedMax;
    const nowBad = { min: min === 'bad', max: max === 'bad' };
    setBad(nowBad);
    if (min === 'bad' || max === 'bad') {
      setError(t('cleanup.height.invalid'));
      return;
    }
    if (!minChanged && !maxChanged) {
      setError(null);
      return;
    }
    commitHeight(min, max);
  };
  const lo = bounds ? toShown(bounds.min[2], off) : null;
  const hi = bounds ? toShown(bounds.max[2], off) : null;
  const span = lo !== null && hi !== null && hi > lo ? hi - lo : null;
  const step = span ? Math.max(0.01, Math.round((span / 200) * 100) / 100) : 0.1;
  /** A thumb at its end of the layer's range means no limit on that side. */
  const thumbs = useRef({ min: 0, max: 0 });
  const sliderMin = shownMin ?? lo ?? 0;
  const sliderMax = shownMax ?? hi ?? 0;
  const releaseThumbs = () => {
    if (lo === null || hi === null) return;
    const a = thumbs.current.min;
    const b = thumbs.current.max;
    const min = Math.min(a, b);
    const max = Math.max(a, b);
    commitHeight(
      min <= lo ? undefined : toFile(min, off),
      max >= hi ? undefined : toFile(max, off),
    );
  };
  const minRange = useRef<HTMLInputElement>(null);
  const maxRange = useRef<HTMLInputElement>(null);
  const release = useRef(releaseThumbs);
  useLayoutEffect(() => {
    release.current = releaseThumbs;
  });
  useEffect(() => {
    // the native change fires once the thumb is released (React's onChange fires on every move)
    const els = [minRange.current, maxRange.current];
    const on = () => {
      release.current();
    };
    for (const el of els) el?.addEventListener('change', on);
    return () => {
      for (const el of els) el?.removeEventListener('change', on);
    };
  }, [span]);
  const previewThumbs = () => {
    if (!id || lo === null || hi === null) return;
    const min = Math.min(thumbs.current.min, thumbs.current.max);
    const max = Math.max(thumbs.current.min, thumbs.current.max);
    setMinDraft(min <= lo ? '' : fmt(min));
    setMaxDraft(max >= hi ? '' : fmt(max));
    cleanup.preview(
      id,
      withHeight(
        base(),
        min <= lo ? undefined : toFile(min, off),
        max >= hi ? undefined : toFile(max, off),
      ),
    );
  };

  /* ---------------------------------------------------------------- noise settings */
  const [meanK, setMeanK] = useState(String(DEFAULT_OUTLIER.meanK));
  const [multiplier, setMultiplier] = useState(String(DEFAULT_OUTLIER.multiplier));
  const [low, setLow] = useState(false);
  const [cell, setCell] = useState(String(DEFAULT_ELM.cell));
  const [threshold, setThreshold] = useState(String(DEFAULT_ELM.threshold));
  const noiseParams = (): NoiseParams => ({
    outlier: {
      meanK: Math.round(clamp(meanK, DEFAULT_OUTLIER.meanK, 2, 64)),
      multiplier: clamp(multiplier, DEFAULT_OUTLIER.multiplier, 0.1, 10),
    },
    ...(low
      ? {
          elm: {
            cell: clamp(cell, DEFAULT_ELM.cell, 0.5, 100),
            threshold: clamp(threshold, DEFAULT_ELM.threshold, 0.1, 50),
          },
        }
      : {}),
  });

  /* ---------------------------------------------------------------- save */

  /* ---------------------------------------------------------------- focus a section */
  const noiseRef = useRef<HTMLElement>(null);
  const saveRef = useRef<HTMLElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const headRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const el = section === 'noise' ? noiseRef.current : section === 'save' ? saveRef.current : null;
    if (!el) return;
    el.scrollIntoView({ block: 'nearest' });
    el.querySelector<HTMLElement>(section === 'save' ? 'input' : 'button')?.focus();
  }, [section]);
  // focus moves into the panel when it opens and back to the toolbar button when it closes
  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!cleanup.store.getState().section) headRef.current?.focus();
    return () => {
      const at = document.activeElement;
      if (at && at !== document.body && !panel?.contains(at)) return;
      document.querySelector<HTMLElement>('[data-testid="cleanup-tool"]')?.focus();
    };
  }, []);

  const close = () => {
    cleanup.closePanel();
    if (stage && (stage.tool === 'clipbox' || stage.tool === 'pcselect')) stage.setTool('select');
  };

  /* ---------------------------------------------------------------- clip box */
  const editBox = async () => {
    if (!stage || !id) return;
    if (tool === 'clipbox') {
      stage.setTool('select');
      return;
    }
    if (!box) {
      const b = cloudWorldBounds(stage, id);
      if (!b) return;
      if (!(await commit({ ...base(), clipBox: fitBox(b) }))) return;
    }
    stage.setTool('clipbox');
  };
  const fit = () => {
    if (!stage || !id) return;
    const b = cloudWorldBounds(stage, id);
    if (!b) return;
    void commit({ ...base(), clipBox: { ...fitBox(b), keep: box?.keep ?? 'inside' } });
  };
  const keep = (k: 'inside' | 'outside') => {
    if (box && box.keep !== k) void commit({ ...base(), clipBox: { ...box, keep: k } });
  };
  const removeBox = () => {
    const rest = { ...base() };
    delete rest.clipBox;
    void commit(rest);
  };

  /* ---------------------------------------------------------------- select */
  const full = regions >= MAX_REGIONS;
  const pick = (s: 'box' | 'lasso') => {
    if (!stage) return;
    if (tool === 'pcselect' && shape === s) {
      stage.setTool('select');
      return;
    }
    cleanup.setShape(s);
    stage.setTool('pcselect');
  };

  /* ---------------------------------------------------------------- noise */
  const runNoiseNow = async () => {
    if (!layer) return;
    setError(null);
    const e = await runNoise(defaultJobsDeps, layer, noiseParams());
    if (e) setError(e);
  };
  const undoNoise = () => {
    if (!id || !recipe?.noise) return;
    const past = history?.past ?? [];
    const last = past.length ? past[past.length - 1] : undefined;
    if (last !== undefined && last?.noise === undefined) {
      // the run was the last step
      void cleanup.undo(id);
      return;
    }
    // later steps came after the run: take the run out as a step of its own, and class 7 with it
    // when the run hid it (the newest state before any run did not)
    const beforeRun = [...past].reverse().find((r) => r?.noise === undefined);
    const rest = { ...base() };
    delete rest.noise;
    const hidden = beforeRun?.hiddenClasses.includes(NOISE_CLASS)
      ? rest.hiddenClasses
      : rest.hiddenClasses.filter((c) => c !== NOISE_CLASS);
    void commit({ ...rest, hiddenClasses: hidden });
  };

  /* ---------------------------------------------------------------- save */
  const save = async () => {
    if (!layer) return;
    setError(null);
    const e = await saveCleaned(defaultJobsDeps, layer, name);
    // the job is over (the copy is in Datasets, or it failed): "Saving..." no longer holds
    const started = t('cleanup.save.started');
    if (cleanup.store.getState().notice?.text === started) cleanup.dismiss();
    if (e) setError(e);
  };

  const size = box ? formatBoxSize(boxToLocal(box, origin ?? [0, 0, 0])) : null;
  const toolsOff = !can || !stage;

  return (
    <div
      ref={panelRef}
      className={inTab ? 'cleanup-panel in-tab wb-scroll' : 'cleanup-panel overlay-box'}
      {...(inTab ? {} : { 'data-surface': 'dark' })}
      data-testid="cleanup-panel"
      role={inTab ? 'region' : 'dialog'}
      aria-label={t('cleanup.title')}
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return;
        e.stopPropagation();
        close();
      }}
    >
      <div className="cleanup-head">
        <span className="pop-title" ref={headRef} tabIndex={-1}>
          {t('cleanup.title')}
        </span>
        <button
          type="button"
          className="btn ghost icon sm"
          aria-label={t('keys.dialog.close')}
          title={t('keys.dialog.close')}
          data-testid="cleanup-close"
          onClick={close}
        >
          <Icon name="x" size={12} />
        </button>
      </div>

      {clouds.length > 1 && (
        <label className="pop-row">
          <span>{t('cleanup.layer')}</span>
          <select
            className="input cleanup-grow"
            data-testid="cleanup-layer"
            value={id ?? ''}
            onChange={(e) => {
              cleanup.setActive(e.currentTarget.value || null);
            }}
          >
            {!id && <option value="">{t('cleanup.layer')}</option>}
            {clouds.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
      )}

      {!layer ? (
        <p className="pop-note" data-testid="cleanup-hint">
          {t('cleanup.none')}
        </p>
      ) : !copc ? (
        <p className="pop-note" data-testid="cleanup-hint">
          {t('cleanup.copcOnly')}
        </p>
      ) : readOnly ? (
        <p className="pop-note" data-testid="cleanup-hint">
          {t('cleanup.readOnly')}
        </p>
      ) : lookOnly ? (
        <p className="pop-note" data-testid="cleanup-hint">
          {t('cleanup.lookOnly')}
        </p>
      ) : null}

      <Section title={t('cleanup.box.title')}>
        <div className="cleanup-btns">
          <button
            type="button"
            className="btn sm"
            aria-pressed={tool === 'clipbox'}
            disabled={toolsOff || (!box && !bounds)}
            data-testid="cleanup-box-edit"
            onClick={() => {
              void editBox();
            }}
          >
            <Icon name="boxclip" size={14} />
            {t('cleanup.box.edit')}
          </button>
          <button
            type="button"
            className="btn sm"
            disabled={toolsOff || !bounds}
            data-testid="cleanup-box-fit"
            onClick={fit}
          >
            {t('cleanup.box.fit')}
          </button>
          <button
            type="button"
            className="btn ghost sm"
            disabled={!can || !box}
            data-testid="cleanup-box-reset"
            onClick={removeBox}
          >
            {t('cleanup.box.reset')}
          </button>
        </div>
        <div className="pop-row">
          <span>{t('cleanup.box.keep')}</span>
          <div className="seg pop-seg cleanup-grow" role="group" aria-label={t('cleanup.box.keep')}>
            {(['inside', 'outside'] as const).map((k) => (
              <button
                key={k}
                type="button"
                aria-pressed={(box?.keep ?? 'inside') === k}
                disabled={!can || !box}
                data-testid={`cleanup-box-keep-${k}`}
                onClick={() => {
                  keep(k);
                }}
              >
                {t(k === 'inside' ? 'cleanup.box.inside' : 'cleanup.box.outside')}
              </button>
            ))}
          </div>
        </div>
        {size && (
          <span className="mono cleanup-size" data-testid="cleanup-box-size">
            {t('cleanup.box.size', { x: size[0], y: size[1], z: size[2] })}
          </span>
        )}
        {tool === 'clipbox' && <p className="pop-note">{t('cleanup.box.editing')}</p>}
      </Section>

      <Section title={t('cleanup.height.title')}>
        <div className="cleanup-pair">
          {(
            [
              ['min', minDraft, setMinDraft, 'cleanup.height.min'],
              ['max', maxDraft, setMaxDraft, 'cleanup.height.max'],
            ] as const
          ).map(([end, value, set, label]) => (
            <label key={end} className="cleanup-field">
              <span>{t(label)}</span>
              <input
                className="input"
                type="text"
                inputMode="decimal"
                spellCheck={false}
                value={value}
                aria-invalid={bad[end]}
                placeholder={end === 'min' ? fmt(lo ?? undefined) : fmt(hi ?? undefined)}
                disabled={!can}
                data-testid={`cleanup-height-${end}`}
                onChange={(e) => {
                  set(e.currentTarget.value);
                }}
                onBlur={commitFields}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitFields();
                }}
              />
            </label>
          ))}
        </div>
        {span !== null && lo !== null && hi !== null && (
          <div className="cleanup-range">
            {(['min', 'max'] as const).map((end) => (
              <input
                key={end}
                ref={end === 'min' ? minRange : maxRange}
                type="range"
                min={lo}
                max={hi}
                step={step}
                value={end === 'min' ? sliderMin : sliderMax}
                disabled={!can}
                aria-label={t(end === 'min' ? 'cleanup.height.min' : 'cleanup.height.max')}
                onPointerDown={() => {
                  thumbs.current = { min: sliderMin, max: sliderMax };
                }}
                onFocus={() => {
                  thumbs.current = { min: sliderMin, max: sliderMax };
                }}
                onChange={(e) => {
                  thumbs.current[end] = Number(e.currentTarget.value);
                  previewThumbs();
                }}
              />
            ))}
          </div>
        )}
        <div className="cleanup-btns">
          <button
            type="button"
            className="btn ghost sm"
            disabled={!can || !recipe?.height}
            data-testid="cleanup-height-clear"
            onClick={() => {
              setError(null);
              void commit(withHeight(base()));
            }}
          >
            {t('cleanup.height.clear')}
          </button>
        </div>
      </Section>

      <Section title={t('cleanup.select.title')}>
        <div className="seg pop-seg" role="group" aria-label={t('cleanup.select.title')}>
          {(['box', 'lasso'] as const).map((s) => (
            <button
              key={s}
              type="button"
              aria-pressed={tool === 'pcselect' && shape === s}
              disabled={toolsOff || full}
              data-testid={`cleanup-select-${s}`}
              onClick={() => {
                pick(s);
              }}
            >
              <Icon name={s === 'box' ? 'box' : 'polygon'} size={14} />
              {t(s === 'box' ? 'cleanup.select.box' : 'cleanup.select.lasso')}
            </button>
          ))}
        </div>
        {full ? (
          <p className="pop-note">{t('cleanup.select.full', { max: MAX_REGIONS })}</p>
        ) : regions >= NEAR_REGIONS ? (
          <p className="pop-note">
            {t('cleanup.select.near', { count: regions, max: MAX_REGIONS })}
          </p>
        ) : tool === 'pcselect' ? (
          <p className="pop-note">{t('cleanup.select.hint')}</p>
        ) : null}
      </Section>

      <Section title={t('cleanup.noise.title')} sectionRef={noiseRef}>
        <button
          type="button"
          className="btn sm"
          disabled={!can || busy !== null}
          data-testid="cleanup-noise-run"
          onClick={() => {
            void runNoiseNow();
          }}
        >
          {busy === 'noise' ? t('cleanup.noise.running') : t('cleanup.noise.run')}
        </button>
        {recipe?.noise && (
          <div className="pop-row" data-testid="cleanup-noise-result">
            <span className="cleanup-grow cleanup-result">
              {t('cleanup.noise.result', {
                count: recipe.noise.marked,
                share: noiseShare(recipe.noise.marked, recipe.noise.total),
              })}
            </span>
            <button
              type="button"
              className="btn ghost sm"
              disabled={!can}
              data-testid="cleanup-noise-undo"
              onClick={undoNoise}
            >
              {t('cleanup.noise.undo')}
            </button>
          </div>
        )}
        <details className="cleanup-details" data-testid="cleanup-noise-settings">
          <summary>{t('cleanup.noise.settings')}</summary>
          <div className="cleanup-settings">
            <label className="cleanup-field">
              <span>{t('cleanup.noise.neighbours')}</span>
              <input
                className="input"
                type="number"
                min={2}
                max={64}
                step={1}
                value={meanK}
                disabled={!can}
                onChange={(e) => {
                  setMeanK(e.currentTarget.value);
                }}
              />
            </label>
            <label className="cleanup-field">
              <span>{t('cleanup.noise.multiplier')}</span>
              <input
                className="input"
                type="number"
                min={0.1}
                max={10}
                step={0.1}
                value={multiplier}
                disabled={!can}
                onChange={(e) => {
                  setMultiplier(e.currentTarget.value);
                }}
              />
            </label>
            <label className="pop-row">
              <span className="pop-grow">{t('cleanup.noise.low')}</span>
              <input
                type="checkbox"
                checked={low}
                disabled={!can}
                onChange={(e) => {
                  setLow(e.currentTarget.checked);
                }}
              />
            </label>
            {low && (
              <div className="cleanup-pair">
                <label className="cleanup-field">
                  <span>{t('cleanup.noise.cell')}</span>
                  <input
                    className="input"
                    type="number"
                    min={0.5}
                    max={100}
                    step={0.5}
                    value={cell}
                    disabled={!can}
                    onChange={(e) => {
                      setCell(e.currentTarget.value);
                    }}
                  />
                </label>
                <label className="cleanup-field">
                  <span>{t('cleanup.noise.threshold')}</span>
                  <input
                    className="input"
                    type="number"
                    min={0.1}
                    max={50}
                    step={0.1}
                    value={threshold}
                    disabled={!can}
                    onChange={(e) => {
                      setThreshold(e.currentTarget.value);
                    }}
                  />
                </label>
              </div>
            )}
          </div>
        </details>
      </Section>

      <Section title={t('cleanup.save.title')} sectionRef={saveRef}>
        <div className="pop-row">
          <input
            className="input cleanup-grow"
            type="text"
            aria-label={t('cleanup.save.name')}
            placeholder={t('cleanup.save.name')}
            value={name}
            disabled={!can}
            data-testid="cleanup-save-name"
            onChange={(e) => {
              setName(e.currentTarget.value);
            }}
          />
          <button
            type="button"
            className="btn sm"
            disabled={!can || busy !== null}
            data-testid="cleanup-save"
            onClick={() => {
              void save();
            }}
          >
            {t('cleanup.save.run')}
          </button>
        </div>
      </Section>

      {error && (
        <p className="pop-note cleanup-error" role="alert" data-testid="cleanup-error">
          {error}
        </p>
      )}

      <div className="cleanup-foot">
        <button
          type="button"
          className="btn ghost icon sm"
          aria-label={t('cleanup.undo')}
          title={t('cleanup.undo')}
          disabled={!can || !history?.past.length}
          data-testid="cleanup-undo"
          onClick={() => {
            if (id) void cleanup.undo(id);
          }}
        >
          <Icon name="undo" size={14} />
        </button>
        <button
          type="button"
          className="btn ghost icon sm"
          aria-label={t('cleanup.redo')}
          title={t('cleanup.redo')}
          disabled={!can || !history?.future.length}
          data-testid="cleanup-redo"
          onClick={() => {
            if (id) void cleanup.redo(id);
          }}
        >
          <Icon name="undo" size={14} className="flip-x" />
        </button>
        <span className="cleanup-grow" />
        <button
          type="button"
          className="btn sm danger"
          disabled={!can || !recipe}
          data-testid="cleanup-reset"
          onClick={() => {
            if (id) void cleanup.reset(id);
          }}
        >
          {t('cleanup.reset')}
        </button>
      </div>
    </div>
  );
}
