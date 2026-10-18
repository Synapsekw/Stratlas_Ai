import { PROVIDER_LABELS, modelLabel, type ModelRoute } from '@aio/ai';
import {
  DETAIL_BUDGETS,
  EngineerSetup,
  ModelFamily,
  type Detail,
  type Layer,
  type Vec3,
} from '@aio/schema';
import { Icon, useFocusTrap, useT, type MessageKey } from '@aio/ui';
import { useId, useRef, useState, type ReactNode } from 'react';
import './engineer.css';

type Setup = EngineerSetup;
interface Region {
  centre: [number, number];
  radiusM: number;
}
interface BoxSize {
  width: number;
  depth: number;
  bottom: number;
  top: number;
}
const BOX_FIELDS: { key: keyof BoxSize; label: MessageKey }[] = [
  { key: 'width', label: 'eng.setup.boxWidth' },
  { key: 'depth', label: 'eng.setup.boxDepth' },
  { key: 'bottom', label: 'eng.setup.boxBottom' },
  { key: 'top', label: 'eng.setup.boxTop' },
];

/** The schema's region: the circle, or the box around the picked centre (local frame). */
function regionOf(r: Region, shape: 'circle' | 'box', b: BoxSize): Setup['region'] {
  if (shape === 'circle') return { centre: r.centre, radiusM: r.radiusM };
  const [x, z] = r.centre;
  return {
    min: [x - b.width / 2, Math.min(b.bottom, b.top), z - b.depth / 2],
    max: [x + b.width / 2, Math.max(b.bottom, b.top), z + b.depth / 2],
  };
}
type Family = Setup['family'];
type Scope = Setup['scope'];
type PlacementMode = Setup['placement'];
type RefWhat = NonNullable<Setup['reference']>['what'];

const SOURCE_KINDS = ['pointcloud', 'mesh', 'photos'] as const;
type SourceLayer = Extract<Layer, { kind: (typeof SOURCE_KINDS)[number] }>;
const isSource = (l: Layer): l is SourceLayer =>
  (SOURCE_KINDS as readonly string[]).includes(l.kind);

const SCOPES: Scope[] = ['asset', 'asset-and-surroundings'];
const DETAILS: Detail[] = ['fast', 'standard', 'detailed'];
const PLACEMENTS: PlacementMode[] = ['from-source', 'anchor', 'unplaced'];
const REFS: RefWhat[] = ['height', 'diameter', 'other'];
/** What the schema allows per source kind. */
const MAX = { clouds: 4, meshes: 2, photos: 2000 };

const fmt = (v: number) => String(Number(v.toFixed(2)));

export interface SetupDialogProps {
  savedRuns?: ReactNode;
  /** The project's layers; point clouds, models and photo sets are offered as sources. */
  layers: readonly Layer[];
  /** The engineer route from Settings, shown read-only; null when none is set. */
  route: ModelRoute | null;
  /** False when the workstation is offline only: nothing can be sent or previewed. */
  online: boolean;
  /** The evidence pack's family suggestion, when a pack exists (a suggestion, never a decision). */
  familyHint: { suggested: ModelFamily; reasons?: readonly string[] | undefined } | null;
  /** The run store (`runStore.start`). */
  run: { start(setup: Setup): Promise<void> };
  /** The file picker for photos outside the project; the chosen paths. */
  onPickPhotos: () => Promise<string[]>;
  onPickSupplement?: (kind: 'drawings' | 'cameraPoses') => Promise<string[]>;
  /** A centre and radius picked in the 3D view (local frame, x and z), or null when cancelled. */
  onPickRegion: () => Promise<Region | null>;
  /** A point picked in the 3D view (local frame), or null when cancelled. */
  onPickAnchor: () => Promise<Vec3 | null>;
  onOpenSettings: () => void;
  /** "Preview what is sent": the data-sharing preview for this setup (EvidencePreview). */
  onPreview: (setup: Setup) => void;
  onClose: () => void;
  /** Layers chosen as sources when the dialog opens (the layer it was opened from). */
  initial?: readonly string[] | undefined;
  /**
   * Out of sight while a pick in the 3D view waits (the region, the anchor): the dialog stays
   * mounted, so every choice made so far is there when it comes back.
   */
  hidden?: boolean | undefined;
}

/**
 * Create engineering model, the setup: the sources (several together: clouds, models, photo sets
 * and photos from files), an optional region that leaves out neighbours and clutter, the asset
 * family (suggested from the evidence, overridable), what to model, the detail (standard by
 * default), an optional known dimension, the placement, and the AI model from Settings shown
 * read-only. "Preview what is sent" shows what would leave the workstation before anything does.
 */
export function SetupDialog(props: SetupDialogProps) {
  const t = useT();
  const id = useId();
  const dlg = useRef<HTMLDivElement>(null);
  const hidden = props.hidden === true;
  useFocusTrap(dlg, !hidden);
  const sources = props.layers.filter(isSource);
  const [chosen, setChosen] = useState<ReadonlySet<string>>(
    () => new Set((props.initial ?? []).filter((id) => sources.some((l) => l.id === id))),
  );
  const [files, setFiles] = useState<string[]>([]);
  const [drawings, setDrawings] = useState<string[]>([]);
  const [cameraPoses, setCameraPoses] = useState<string>();
  const [step, setStep] = useState(0);
  const [budget, setBudget] = useState('');
  const [region, setRegion] = useState<Region | null>(null);
  // a circle (centre and radius) or a box around the picked centre: width east, depth north,
  // and the height range it spans
  const [shape, setShape] = useState<'circle' | 'box'>('circle');
  const [box, setBox] = useState<BoxSize>({ width: 40, depth: 40, bottom: 0, top: 150 });
  const [family, setFamily] = useState<Family>('auto');
  const [scope, setScope] = useState<Scope>('asset');
  const [detail, setDetail] = useState<Detail>('standard');
  const [refWhat, setRefWhat] = useState<RefWhat>('height');
  const [refValue, setRefValue] = useState('');
  const [refLabel, setRefLabel] = useState('');
  const [placement, setPlacement] = useState<PlacementMode>('from-source');
  const [anchor, setAnchor] = useState<Vec3 | null>(null);
  const [starting, setStarting] = useState(false);

  const setup = (): Setup | null => {
    const pick = (kind: SourceLayer['kind']) =>
      sources.filter((l) => l.kind === kind && chosen.has(l.id));
    const photos = [
      ...pick('photos').flatMap((l) =>
        l.kind === 'photos'
          ? l.items.flatMap((p) => ('path' in p.src ? [{ path: p.src.path }] : []))
          : [],
      ),
      ...files.map((path) => ({ path })),
    ].slice(0, MAX.photos);
    const value = Number(refValue.replace(',', '.'));
    const candidate = {
      sources: {
        clouds: pick('pointcloud')
          .slice(0, MAX.clouds)
          .map((l) => ({ layer: l.id })),
        meshes: pick('mesh')
          .slice(0, MAX.meshes)
          .map((l) => ({ layer: l.id })),
        photos,
        ...(drawings.length ? { drawings: drawings.map((path) => ({ path })) } : {}),
        ...(cameraPoses ? { cameraPoses: { path: cameraPoses } } : {}),
      },
      ...(region ? { region: regionOf(region, shape, box) } : {}),
      family,
      scope,
      detail,
      budgetUsd: budget.trim() ? Number(budget) : DETAIL_BUDGETS[detail].costUsd,
      ...(refValue.trim() && value > 0
        ? {
            reference: {
              what: refWhat,
              valueM: value,
              ...(refWhat === 'other' && refLabel.trim() ? { label: refLabel.trim() } : {}),
            },
          }
        : {}),
      placement,
      ...(placement === 'anchor' && anchor ? { anchor } : {}),
    };
    const nothing =
      candidate.sources.clouds.length + candidate.sources.meshes.length + photos.length === 0;
    if (nothing) return null;
    const parsed = EngineerSetup.safeParse(candidate);
    return parsed.success ? parsed.data : null;
  };
  const ready = setup();
  const anchorMissing = placement === 'anchor' && !anchor;
  // a known dimension that is not a number of metres stops the start, and says why
  const refNumber = Number(refValue.replace(',', '.'));
  const refInvalid =
    refValue.trim() !== '' && !(Number.isFinite(refNumber) && refNumber > 0 && refNumber <= 1000);

  const toggle = (layerId: string) => {
    setChosen((s) => {
      const next = new Set(s);
      if (next.has(layerId)) next.delete(layerId);
      else next.add(layerId);
      return next;
    });
  };
  const start = async () => {
    if (!ready) return;
    setStarting(true);
    try {
      await props.run.start(ready);
    } finally {
      setStarting(false);
    }
  };
  const providerName = props.route ? PROVIDER_LABELS[props.route.provider] : '';
  const radio = (
    group: string,
    value: string,
    checked: boolean,
    label: string,
    onPick: () => void,
    hint?: string,
  ) => (
    <label key={value} className="eng-choice">
      <input
        type="radio"
        name={`${id}-${group}`}
        checked={checked}
        data-testid={`eng-${group}-${value}`}
        onChange={onPick}
      />
      <span>{label}</span>
      {hint && <span className="faint">{hint}</span>}
    </label>
  );

  return (
    <div
      className="dlg-scrim"
      style={hidden ? { display: 'none' } : undefined}
      aria-hidden={hidden || undefined}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) props.onClose();
      }}
    >
      <div
        ref={dlg}
        className="dlg wide eng-setup"
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-h`}
        data-testid="eng-setup"
        onKeyDown={(e) => {
          e.stopPropagation();
          // an Escape that let a pick go (the dialog hidden meanwhile) does not close it too
          if (e.key === 'Escape' && !e.defaultPrevented && !hidden) props.onClose();
        }}
      >
        <div className="dlg-h">
          <Icon name="scene" size={16} />
          <h2 id={`${id}-h`}>{t('eng.setup.title')}</h2>
          <span className="sub">{t('eng.setup.sub')}</span>
          <button
            type="button"
            className="btn ghost icon sm"
            aria-label={t('eng.setup.close')}
            onClick={props.onClose}
          >
            <Icon name="x" size={14} />
          </button>
        </div>

        <div className="dlg-b">
          {props.savedRuns}
          <ol className="eng-setup-steps" aria-label={t('eng.setup.steps')}>
            {(
              [
                'eng.setup.step.sources',
                'eng.setup.step.options',
                'eng.setup.step.confirm',
              ] as const
            ).map((key, i) => (
              <li key={key} aria-current={step === i ? 'step' : undefined}>
                {i + 1}. {t(key)}
              </li>
            ))}
          </ol>
          <div hidden={step !== 0}>
            <fieldset className="dlg-sec eng-sec">
              <legend>{t('eng.setup.sources')}</legend>
              <p>{t('eng.setup.sourcesHint')}</p>
              {sources.length === 0 && <p className="faint">{t('eng.setup.noSources')}</p>}
              <div className="eng-sources">
                {sources.map((l) => (
                  <label key={l.id} className="eng-choice">
                    <input
                      type="checkbox"
                      checked={chosen.has(l.id)}
                      data-testid={`eng-source-${l.id}`}
                      onChange={() => {
                        toggle(l.id);
                      }}
                    />
                    <span>{l.name}</span>
                    <span className="faint">
                      {l.kind === 'photos'
                        ? t('eng.setup.kind.photos', { count: l.items.length })
                        : t(`eng.setup.kind.${l.kind}`)}
                    </span>
                  </label>
                ))}
              </div>
              <div className="acts">
                <button
                  type="button"
                  className="btn sm"
                  data-testid="eng-add-photos"
                  onClick={() => {
                    void props.onPickPhotos().then((paths) => {
                      if (paths.length) setFiles((f) => [...new Set([...f, ...paths])]);
                    });
                  }}
                >
                  <Icon name="photo" size={12} />
                  {t('eng.setup.addPhotos')}
                </button>
                {files.length > 0 && (
                  <span className="eng-files" data-testid="eng-photo-files">
                    {t('eng.setup.photoFiles', { count: files.length })}
                    <button
                      type="button"
                      className="btn ghost icon sm"
                      aria-label={t('eng.setup.clearFiles')}
                      onClick={() => {
                        setFiles([]);
                      }}
                    >
                      <Icon name="x" size={12} />
                    </button>
                  </span>
                )}
              </div>
              <div className="acts">
                {(['drawings', 'cameraPoses'] as const).map((kind) => (
                  <button
                    key={kind}
                    type="button"
                    className="btn sm"
                    disabled={!props.onPickSupplement}
                    onClick={() => {
                      void props.onPickSupplement?.(kind).then((paths) => {
                        if (kind === 'drawings')
                          setDrawings((previous) =>
                            [...new Set([...previous, ...paths])].slice(0, 8),
                          );
                        else if (paths[0]) setCameraPoses(paths[0]);
                      });
                    }}
                  >
                    {t(kind === 'drawings' ? 'eng.setup.addDrawings' : 'eng.setup.addCameras')}
                  </button>
                ))}
              </div>
              {(drawings.length > 0 || cameraPoses) && (
                <ul className="eng-source-files">
                  {drawings.map((path) => (
                    <li key={path}>
                      {path.split(/[\\/]/).at(-1)}{' '}
                      <button
                        type="button"
                        className="btn ghost sm"
                        onClick={() => {
                          setDrawings((d) => d.filter((p) => p !== path));
                        }}
                      >
                        {t('eng.setup.remove')}
                      </button>
                    </li>
                  ))}
                  {cameraPoses && (
                    <li>
                      {cameraPoses.split(/[\\/]/).at(-1)}{' '}
                      <button
                        type="button"
                        className="btn ghost sm"
                        onClick={() => {
                          setCameraPoses(undefined);
                        }}
                      >
                        {t('eng.setup.remove')}
                      </button>
                    </li>
                  )}
                </ul>
              )}
              <p className="faint">{t('eng.setup.calibrationHint')}</p>
            </fieldset>

            <fieldset className="dlg-sec eng-sec">
              <legend>{t('eng.setup.region')}</legend>
              <p>{t('eng.setup.regionHint')}</p>
              <div className="acts">
                <button
                  type="button"
                  className="btn sm"
                  data-testid="eng-region-pick"
                  onClick={() => {
                    void props.onPickRegion().then((r) => {
                      if (r) setRegion(r);
                    });
                  }}
                >
                  <Icon name="target" size={12} />
                  {t('eng.setup.regionPick')}
                </button>
                {region && (
                  <>
                    <span className="eng-at mono" data-testid="eng-region">
                      {t('eng.setup.regionAt', {
                        e: fmt(region.centre[0]),
                        n: fmt(-region.centre[1]),
                        r: fmt(region.radiusM),
                      })}
                    </span>
                    <span className="seg" role="group" aria-label={t('eng.setup.regionShape')}>
                      {(['circle', 'box'] as const).map((k) => (
                        <button
                          key={k}
                          type="button"
                          aria-pressed={shape === k}
                          data-testid={`eng-region-${k}`}
                          onClick={() => {
                            setShape(k);
                          }}
                        >
                          {t(k === 'circle' ? 'eng.setup.regionCircle' : 'eng.setup.regionBox')}
                        </button>
                      ))}
                    </span>
                    {shape === 'circle' && (
                      <label className="eng-num">
                        <span>{t('eng.setup.regionRadius')}</span>
                        <input
                          className="input mono"
                          type="number"
                          min={1}
                          max={2000}
                          value={region.radiusM}
                          data-testid="eng-region-radius"
                          onChange={(e) => {
                            const v = Number(e.target.value);
                            if (v > 0) setRegion({ ...region, radiusM: Math.min(2000, v) });
                          }}
                        />
                      </label>
                    )}
                    {shape === 'box' &&
                      BOX_FIELDS.map((f) => (
                        <label key={f.key} className="eng-num">
                          <span>{t(f.label)}</span>
                          <input
                            className="input mono"
                            type="number"
                            value={box[f.key]}
                            data-testid={`eng-box-${f.key}`}
                            onChange={(e) => {
                              const v = Number(e.target.value);
                              const sized = f.key === 'width' || f.key === 'depth';
                              if (Number.isFinite(v) && (!sized || v > 0))
                                setBox({ ...box, [f.key]: v });
                            }}
                          />
                        </label>
                      ))}
                    <button
                      type="button"
                      className="btn ghost icon sm"
                      aria-label={t('eng.setup.regionClear')}
                      data-testid="eng-region-clear"
                      onClick={() => {
                        setRegion(null);
                      }}
                    >
                      <Icon name="x" size={12} />
                    </button>
                  </>
                )}
              </div>
            </fieldset>
          </div>
          <div hidden={step !== 1}>
            <div className="eng-grid">
              <fieldset className="dlg-sec eng-sec">
                <legend>{t('eng.setup.family')}</legend>
                {props.familyHint && (
                  <p data-testid="eng-family-hint" title={props.familyHint.reasons?.join('; ')}>
                    {t('eng.setup.familyHint', {
                      family: t(`eng.setup.family.${props.familyHint.suggested}`),
                    })}
                  </p>
                )}
                <select
                  className="input"
                  aria-label={t('eng.setup.family')}
                  data-testid="eng-family"
                  value={family}
                  onChange={(e) => {
                    const v = e.target.value;
                    setFamily(v === 'auto' ? 'auto' : ModelFamily.parse(v));
                  }}
                >
                  <option value="auto">{t('eng.setup.familyAuto')}</option>
                  {ModelFamily.options.map((f) => (
                    <option key={f} value={f}>
                      {t(`eng.setup.family.${f}`)}
                    </option>
                  ))}
                </select>
              </fieldset>

              <fieldset className="dlg-sec eng-sec">
                <legend>{t('eng.setup.scope')}</legend>
                {SCOPES.map((s) =>
                  radio('scope', s, scope === s, t(`eng.setup.scope.${s}`), () => {
                    setScope(s);
                  }),
                )}
              </fieldset>

              <fieldset className="dlg-sec eng-sec">
                <legend>{t('eng.setup.detail')}</legend>
                {DETAILS.map((d) =>
                  radio(
                    'detail',
                    d,
                    detail === d,
                    t(`eng.setup.detail.${d}`),
                    () => {
                      setDetail(d);
                    },
                    t(`eng.setup.detailHint.${d}` as MessageKey, {
                      usd: DETAIL_BUDGETS[d].costUsd.toFixed(2),
                    }),
                  ),
                )}
              </fieldset>

              <fieldset className="dlg-sec eng-sec">
                <legend>{t('eng.setup.reference')}</legend>
                <p>{t('eng.setup.referenceHint')}</p>
                <div className="eng-row">
                  <select
                    className="input"
                    aria-label={t('eng.setup.reference')}
                    value={refWhat}
                    onChange={(e) => {
                      const v = REFS.find((r) => r === e.target.value);
                      if (v) setRefWhat(v);
                    }}
                  >
                    {REFS.map((r) => (
                      <option key={r} value={r}>
                        {t(`eng.setup.ref.${r}`)}
                      </option>
                    ))}
                  </select>
                  <input
                    className="input mono"
                    inputMode="decimal"
                    aria-label={t('eng.setup.refValue')}
                    placeholder={t('eng.setup.refValue')}
                    data-testid="eng-ref-value"
                    aria-invalid={refInvalid}
                    value={refValue}
                    onChange={(e) => {
                      setRefValue(e.target.value);
                    }}
                  />
                </div>
                {refInvalid && (
                  <p className="eng-bad" role="alert" data-testid="eng-ref-invalid">
                    {t('eng.setup.refInvalid')}
                  </p>
                )}
                {refWhat === 'other' && (
                  <input
                    className="input"
                    aria-label={t('eng.setup.refLabel')}
                    placeholder={t('eng.setup.refLabel')}
                    maxLength={80}
                    value={refLabel}
                    onChange={(e) => {
                      setRefLabel(e.target.value);
                    }}
                  />
                )}
              </fieldset>
            </div>

            <fieldset className="dlg-sec eng-sec">
              <legend>{t('eng.setup.placement')}</legend>
              {PLACEMENTS.map((p) =>
                radio('placement', p, placement === p, t(`eng.setup.placement.${p}`), () => {
                  setPlacement(p);
                }),
              )}
              {placement === 'anchor' && (
                <div className="acts">
                  <button
                    type="button"
                    className="btn sm"
                    data-testid="eng-anchor-pick"
                    onClick={() => {
                      void props.onPickAnchor().then((a) => {
                        if (a) setAnchor(a);
                      });
                    }}
                  >
                    <Icon name="point" size={12} />
                    {t('eng.setup.anchorPick')}
                  </button>
                  {anchor ? (
                    <span className="eng-at mono" data-testid="eng-anchor">
                      {t('eng.setup.anchorAt', {
                        e: fmt(anchor[0]),
                        n: fmt(-anchor[2]),
                        h: fmt(anchor[1]),
                      })}
                    </span>
                  ) : (
                    <span className="faint">{t('eng.setup.anchorNeeded')}</span>
                  )}
                </div>
              )}
            </fieldset>

            <section className="dlg-sec eng-sec" aria-labelledby={`${id}-ai`}>
              <h3 id={`${id}-ai`}>{t('eng.setup.ai')}</h3>
              <div className="eng-route">
                <span data-testid="eng-route">
                  {props.route
                    ? t('eng.setup.aiRoute', {
                        provider: providerName,
                        model: modelLabel(props.route.model),
                      })
                    : t('eng.setup.aiNone')}
                </span>
                <button
                  type="button"
                  className="btn ghost sm"
                  data-testid="eng-open-settings"
                  onClick={props.onOpenSettings}
                >
                  {t('eng.setup.settings')}
                </button>
              </div>
              {!props.online && (
                <p className="notice small" role="status" data-testid="eng-offline">
                  {t('eng.setup.offline')}
                </p>
              )}
            </section>
          </div>
          <section hidden={step !== 2} className="dlg-sec eng-sec">
            <h3>{t('eng.setup.step.confirm')}</h3>
            <p>{t('eng.setup.runFlow')}</p>
            <dl className="eng-summary">
              <dt>{t('eng.setup.sources')}</dt>
              <dd>
                {t('eng.setup.sourceCount', {
                  clouds: ready?.sources.clouds.length ?? 0,
                  photos: ready?.sources.photos.length ?? 0,
                  drawings: drawings.length,
                })}
              </dd>
              <dt>{t('eng.setup.placement')}</dt>
              <dd>{t(`eng.setup.placement.${placement}`)}</dd>
              <dt>{t('eng.setup.ai')}</dt>
              <dd>
                {props.route
                  ? `${providerName} · ${modelLabel(props.route.model)}`
                  : t('eng.setup.aiNone')}
              </dd>
            </dl>
            {placement === 'from-source' && (
              <p className="notice small">{t('eng.setup.frameLock')}</p>
            )}
            <label className="eng-num">
              <span>{t('eng.setup.budget')}</span>
              <input
                className="input mono"
                type="number"
                min="0"
                max="100"
                step="0.5"
                value={budget || DETAIL_BUDGETS[detail].costUsd}
                onChange={(e) => {
                  setBudget(e.target.value);
                }}
              />
            </label>
            <p className="faint">{t('eng.setup.budgetHint')}</p>
          </section>
        </div>

        <div className="dlg-f">
          <button
            type="button"
            className="btn"
            hidden={step === 0}
            onClick={() => {
              setStep((s) => Math.max(0, s - 1));
            }}
          >
            {t('eng.setup.back')}
          </button>
          <span className="grow" />
          <button type="button" className="btn ghost" onClick={props.onClose}>
            {t('eng.setup.cancel')}
          </button>
          <button
            type="button"
            className="btn primary"
            data-testid="eng-start"
            hidden={step !== 2}
            disabled={!ready || anchorMissing || refInvalid || starting}
            onClick={() => void start()}
          >
            {t('eng.setup.start')}
          </button>
          <button
            type="button"
            className="btn primary"
            data-testid="eng-next"
            hidden={step === 2}
            disabled={!ready || anchorMissing || refInvalid}
            onClick={() => {
              setStep((s) => Math.min(2, s + 1));
            }}
          >
            {t('eng.setup.next')}
          </button>
        </div>
      </div>
    </div>
  );
}
