/**
 * The "Detectors (on this computer)" side of the Detect dialog: the local vision-model detectors
 * (Analytics pack) run on the chosen photos as `detect.vlm` jobs, one per photo layer. Detectors
 * are toggles, the project's asset type first, then "All detectors", each chosen one with its
 * threshold (its suggested value from the review ledger is offered with Use, never applied by
 * itself). Start is disabled while the pack is missing or unusable, the graphics card is refused
 * (too busy only warns: the gate queues the run), only video frames are chosen or no detector is,
 * and the reason is a line beside Start, not only in its tip. A started run closes the dialog; a
 * run the gate queued says it starts when the card is free.
 */
import type { IpcResponse } from '@aio/schema';
import { Button, Chip, Icon, t, useFocusTrap } from '@aio/ui';
import { useWorkspace } from '@aio/workspace';
import { useEffect, useMemo, useRef, useState } from 'react';
import { analyticsPack, useAnalyticsPack } from '../../analyticsPack';
import { bridge, jobs } from '../../shell';
import type { DetectItem } from '../convert';
import { ModeSwitch, type DetectMode } from '../LocalDetect';
import {
  estimateMinutes,
  MAX_RUN_DETECTORS,
  newRunId,
  orderForProject,
  planRuns,
  runRequest,
  type Chosen,
} from './runPlan';
import { ModelMismatchMark } from './ModelMismatchMark';
import { ThresholdSlider } from './ThresholdSlider';
import './detectorRun.css';

type Item = IpcResponse<'detectors:list'>['items'][number];
type Scope = 'selected' | 'current' | 'unreviewed';

/** The run dialog's threshold slider: 0.50 to 0.95 in 0.05 steps. */
const MIN_THRESHOLD = 0.5;
const MAX_THRESHOLD = 0.95;

const keyOf = (i: Item) => `${i.where}:${i.detector.id}`;
/** On the slider's 0.05 grid, within its range. */
const snapThreshold = (v: number) =>
  Math.min(MAX_THRESHOLD, Math.max(MIN_THRESHOLD, Math.round(v * 20) / 20));

/** What the dialog ends on after Start: runs waiting for the card, or why a start failed. */
interface Outcome {
  queued: boolean;
  errors: string[];
}

export function DetectorRunDialog({
  projectId,
  selected,
  current,
  unreviewed,
  onMode,
  onClose,
}: {
  projectId: string;
  selected: readonly DetectItem[];
  current: DetectItem | null;
  unreviewed: readonly DetectItem[];
  onMode: (m: DetectMode) => void;
  onClose: () => void;
}) {
  const project = useWorkspace((s) => s.project);
  const status = useAnalyticsPack((s) => s.status);
  const hardware = useAnalyticsPack((s) => s.hardware);
  const hardwareError = useAnalyticsPack((s) => s.hardwareError);
  const checking = useAnalyticsPack((s) => s.checking);
  const packError = useAnalyticsPack((s) => s.error);
  const dlg = useRef<HTMLDivElement>(null);
  useFocusTrap(dlg, true);

  const lists: Record<Scope, readonly DetectItem[]> = {
    selected,
    current: current ? [current] : [],
    unreviewed,
  };
  const photoCount = (l: readonly DetectItem[]) => l.filter((i) => i.kind === 'photo').length;
  const [scope, setScope] = useState<Scope>(
    selected.length > 0 ? 'selected' : current ? 'current' : 'unreviewed',
  );
  const items = lists[scope];
  // a selection of video frames only is named as frames, not as "0 selected photos"
  const scopeLabel = (s: Scope) => {
    const n = photoCount(lists[s]);
    return s === 'selected' && n === 0 && lists[s].length > 0
      ? t('detect.preset.run.selectedFrames', { count: lists[s].length })
      : t(`det.ai.scope.${s}`, { count: n });
  };

  const [list, setList] = useState<Item[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [suggested, setSuggested] = useState<Record<string, number | null>>({});
  /** Chosen detectors by `where:id`, with their threshold. */
  const [chosen, setChosen] = useState<Record<string, number>>({});
  const [busy, setBusy] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  /** Set at once on Start, so a second click before the busy render starts nothing. */
  const starting = useRef(false);
  /**
   * False once the dialog is gone. Closing while a start waits for the model to load leaves the
   * start running (its job shows in the jobs list); the dialog then sets no state.
   */
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    void analyticsPack.getState().load();
    // a list read for an earlier project is dropped
    let live = true;
    const stale = () => !live;
    void (async () => {
      const r = await bridge.call('detectors:list', { projectId });
      if (stale()) return;
      if (!r.ok) {
        setListError(r.error);
        return;
      }
      setList(r.value.items);
      const ids = [...new Set(r.value.items.map((i) => i.detector.id))];
      const stats = await Promise.all(
        ids.map(async (id) => {
          const s = await bridge.call('ledger:stats', { detectorId: id });
          return [id, s.ok ? s.value.suggestedThreshold : null] as const;
        }),
      );
      if (!stale()) setSuggested(Object.fromEntries(stats));
    })();
    return () => {
      live = false;
    };
  }, [projectId]);

  const manifest = project?.manifest;
  const assetTypes = useMemo(
    () => [...new Set((manifest?.classCatalogues ?? []).map((c) => c.assetType))],
    [manifest],
  );
  const classIds = useMemo(
    () => new Set((manifest?.classCatalogues ?? []).flatMap((c) => c.classes.map((k) => k.id))),
    [manifest],
  );
  const groups = useMemo(() => orderForProject(list ?? [], assetTypes), [list, assetTypes]);

  const picks: Chosen[] = (list ?? []).flatMap((i) => {
    const th = chosen[keyOf(i)];
    return th === undefined ? [] : [{ where: i.where, detector: i.detector, threshold: th }];
  });
  const plan = planRuns(items, picks);
  const photos = plan.runs.reduce((n, r) => n + r.photos.length, 0);

  const refused = hardware && !hardware.ok ? hardware : null;
  const tooBusy = refused?.code === 'tooBusy';
  // the status read failed: say why (with Try again), not "Checking" for ever
  const statusFailed = status === null && packError !== null;
  const blocker =
    status === null || (hardware === null && hardwareError === null)
      ? (packError ?? t('detect.preset.run.checking'))
      : refused?.code === 'mac'
        ? refused.reason
        : !status.installed
          ? (status.unusable[0]?.reason ?? t('detect.preset.pack.missing'))
          : hardwareError !== null
            ? t('detect.preset.settings.hw.failed')
            : refused && !tooBusy
              ? refused.reason
              : photos === 0
                ? plan.skippedFrames > 0
                  ? t('detect.preset.run.onlyFrames')
                  : t('detect.preset.run.noPhotos')
                : picks.length === 0
                  ? t('detect.preset.run.noDetector')
                  : picks.length > MAX_RUN_DETECTORS
                    ? t('detect.preset.run.tooMany', { max: MAX_RUN_DETECTORS })
                    : null;
  const canRecheck =
    !checking && refused?.code !== 'mac' && (refused !== null || hardwareError !== null);

  const toggle = (i: Item) => {
    setChosen((c) => {
      const k = keyOf(i);
      if (k in c) return Object.fromEntries(Object.entries(c).filter(([x]) => x !== k));
      return { ...c, [k]: snapThreshold(i.detector.threshold) };
    });
  };

  const start = async () => {
    if (blocker !== null || starting.current || !project) return;
    starting.current = true;
    setBusy(true);
    setStartError(null);
    const errors: string[] = [];
    let started = 0;
    let queued = 0;
    for (const run of plan.runs) {
      const runId = newRunId();
      const error = await jobs.getState().start(runRequest(project.root, runId, run));
      if (error === null) {
        started++;
        continue;
      }
      // the gate answers a run it queued with an error: the queue says whether it waits
      // (or by its message, when the run already left the queue or the read failed)
      const q = await bridge.call('detect:queue', {});
      const waits = q.ok && q.value.items.some((w) => w.run === runId);
      if (waits || error === t('detect.preset.queued')) queued++;
      else errors.push(error);
    }
    starting.current = false;
    // closed while the model loaded: the runs carry on in the jobs list
    if (!mounted.current) return;
    setBusy(false);
    if (errors.length === 0 && queued === 0) {
      onClose();
      return;
    }
    if (started === 0 && queued === 0) {
      setStartError(errors.join(' '));
      return;
    }
    setOutcome({ queued: queued > 0, errors });
  };

  // while a start waits for the model, closing hides the dialog and lets the start carry on
  const close = () => {
    onClose();
  };

  const detectorRow = (i: Item) => {
    const k = keyOf(i);
    const d = i.detector;
    const th = chosen[k];
    const raw = suggested[d.id];
    const hint = typeof raw === 'number' ? snapThreshold(raw) : null;
    return (
      <li key={k} className="det-vlm-det">
        <div className="det-vlm-det-h">
          <Button
            pressed={th !== undefined}
            data-testid={`det-vlm-det-${d.id}`}
            onClick={() => {
              toggle(i);
            }}
          >
            {d.name}
          </Button>
          {d.status === 'experimental' && (
            <span data-testid={`det-vlm-experimental-${d.id}`}>
              <Chip kind="status" tone="warn">
                {t('detect.preset.library.experimental')}
              </Chip>
            </span>
          )}
          {i.modelMismatch && <ModelMismatchMark testId={`det-vlm-mismatch-${d.id}`} />}
        </div>
        {th !== undefined && (
          <div className="det-vlm-det-b">
            <span className="det-vlm-bar" data-testid={`det-vlm-threshold-${d.id}`}>
              <ThresholdSlider
                value={th}
                min={MIN_THRESHOLD}
                max={MAX_THRESHOLD}
                step={0.05}
                label={t('detect.preset.run.threshold', { name: d.name })}
                onChange={(v) => {
                  setChosen((c) => ({ ...c, [k]: v }));
                }}
              />
              <span className="mono">{th.toFixed(2)}</span>
            </span>
            {hint !== null && (
              <span className="det-vlm-suggested" data-testid={`det-vlm-suggested-${d.id}`}>
                {t('detect.preset.run.suggested', { value: hint.toFixed(2) })}
                {Math.abs(hint - th) > 1e-9 && (
                  <Button
                    variant="quiet"
                    data-testid={`det-vlm-use-${d.id}`}
                    onClick={() => {
                      setChosen((c) => ({ ...c, [k]: hint }));
                    }}
                  >
                    {t('detect.preset.run.use')}
                  </Button>
                )}
              </span>
            )}
            {!classIds.has(d.classId) && (
              <p className="ann-faint" data-testid={`det-vlm-class-missing-${d.id}`}>
                {t('detect.preset.run.classMissing', { class: d.name })}
              </p>
            )}
          </div>
        )}
      </li>
    );
  };

  return (
    <div
      className="dlg-scrim"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div
        ref={dlg}
        className="dlg wide det-ai det-vlm-run"
        role="dialog"
        aria-modal="true"
        aria-labelledby="det-vlm-h"
        data-testid="det-ai-dialog"
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Escape') close();
        }}
      >
        <div className="dlg-h">
          <Icon name="target" size={16} />
          <h2 id="det-vlm-h">{t('infer.dlg.title')}</h2>
          <button
            type="button"
            className="btn ghost icon sm"
            aria-label={t('det.close')}
            onClick={close}
          >
            <Icon name="x" size={14} />
          </button>
        </div>

        {outcome ? (
          <div className="dlg-b">
            <section className="dlg-sec">
              {outcome.queued && (
                <p role="status" data-testid="det-vlm-queued">
                  {t('detect.preset.queued')}
                </p>
              )}
              {outcome.errors.map((e, n) => (
                <p key={n} className="ann-error" role="alert" data-testid="det-vlm-error">
                  {e}
                </p>
              ))}
            </section>
          </div>
        ) : (
          <div className="dlg-b">
            <section className="dlg-sec">
              <h3 className="caps">{t('infer.dlg.source')}</h3>
              <ModeSwitch mode="detectors" disabled={busy} onChange={onMode} />
              {refused && tooBusy && (
                <p className="det-vlm-hw warn" role="status" data-testid="det-vlm-hw">
                  <Icon name="warn" size={14} />
                  {refused.reason}
                </p>
              )}
              {statusFailed && (
                <Button
                  variant="quiet"
                  data-testid="det-vlm-pack-retry"
                  onClick={() => void analyticsPack.getState().load()}
                >
                  {t('detect.preset.run.retry')}
                </Button>
              )}
              {canRecheck && (
                <Button
                  variant="quiet"
                  data-testid="det-vlm-hw-recheck"
                  onClick={() => void analyticsPack.getState().checkHardware()}
                >
                  {t('detect.preset.settings.hw.recheck')}
                </Button>
              )}
            </section>

            <section className="dlg-sec">
              <h3 className="caps">{t('infer.dlg.what')}</h3>
              <div className="det-scope" role="radiogroup" aria-label={t('infer.dlg.what')}>
                {(['selected', 'current', 'unreviewed'] as const).map((s) => (
                  <label key={s} className="ann-check">
                    <input
                      type="radio"
                      name="det-vlm-scope"
                      data-testid={`det-vlm-scope-${s}`}
                      checked={scope === s}
                      disabled={lists[s].length === 0}
                      onChange={() => {
                        setScope(s);
                      }}
                    />
                    {scopeLabel(s)}
                  </label>
                ))}
              </div>
              {plan.skippedFrames > 0 && photos > 0 && (
                <p className="ann-faint" data-testid="det-vlm-frames-skipped">
                  {t('detect.preset.run.framesSkipped', { count: plan.skippedFrames })}
                </p>
              )}
            </section>

            <section className="dlg-sec" data-testid="det-vlm-detectors">
              <h3 className="caps">{t('detect.preset.run.detectors')}</h3>
              {listError !== null && (
                <p className="ann-error" role="alert">
                  {t('detect.preset.run.listFailed', { error: listError })}
                </p>
              )}
              {list?.length === 0 && <p className="ann-faint">{t('detect.preset.run.none')}</p>}
              {groups.forProject.length > 0 && (
                <div className="det-vlm-group" data-testid="det-vlm-group-project">
                  <h4>{t('detect.preset.run.forProject', { types: assetTypes.join(', ') })}</h4>
                  <ul className="det-vlm-list">{groups.forProject.map(detectorRow)}</ul>
                </div>
              )}
              {groups.rest.length > 0 && (
                <div className="det-vlm-group" data-testid="det-vlm-group-all">
                  <h4>{t('detect.preset.run.all')}</h4>
                  <ul className="det-vlm-list">{groups.rest.map(detectorRow)}</ul>
                </div>
              )}
            </section>

            {photos > 0 && picks.length > 0 && (
              <section className="dlg-sec">
                <p data-testid="det-vlm-estimate">
                  {t('detect.preset.run.estimate', {
                    min: estimateMinutes(photos, picks.length),
                    count: photos,
                  })}
                </p>
              </section>
            )}
            {busy && (
              <p className="ann-faint" role="status" data-testid="det-vlm-loading">
                {t('detect.preset.run.loading')}
              </p>
            )}
            {startError !== null && (
              <p className="ann-error" role="alert" data-testid="det-vlm-error">
                {startError}
              </p>
            )}
          </div>
        )}

        <div className="dlg-f">
          {outcome ? (
            <>
              <span className="grow" />
              <Button variant="primary" data-testid="det-vlm-ok" onClick={onClose}>
                {t('detect.preset.run.ok')}
              </Button>
            </>
          ) : (
            <>
              {blocker !== null ? (
                <span className="grow det-vlm-blocker" data-testid="det-vlm-blocker">
                  {blocker}
                </span>
              ) : (
                <span className="grow ann-faint">{t('det.ai.draftNote')}</span>
              )}
              <button type="button" className="btn ghost" disabled={busy} onClick={close}>
                {t('det.cancel')}
              </button>
              <Button
                variant="primary"
                icon="target"
                busy={busy}
                disabledReason={blocker ?? undefined}
                data-testid="det-vlm-start"
                onClick={() => void start()}
              >
                {t('detect.preset.run.start')}
              </Button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
