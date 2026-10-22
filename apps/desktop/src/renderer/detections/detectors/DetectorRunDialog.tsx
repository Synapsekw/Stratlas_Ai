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
import { Button, Chip, Icon, t, Tip, useFocusTrap } from '@aio/ui';
import { useWorkspace } from '@aio/workspace';
import { useEffect, useMemo, useRef, useState } from 'react';
import { analyticsPack, useAnalyticsPack } from '../../analyticsPack';
import { bridge, jobs } from '../../shell';
import type { DetectItem } from '../convert';
import { ModeSwitch, type DetectMode } from '../LocalDetect';
import {
  estimateMinutes,
  newRunId,
  orderForProject,
  planRuns,
  runRequest,
  type Chosen,
} from './runPlan';
import { ThresholdSlider } from './ThresholdSlider';
import './detectorRun.css';

type Item = IpcResponse<'detectors:list'>['items'][number];
type Scope = 'selected' | 'current' | 'unreviewed';

/** The run dialog's threshold slider: 0.50 to 0.95 in 0.05 steps. */
const MIN_THRESHOLD = 0.5;
const MAX_THRESHOLD = 0.95;

const keyOf = (i: Item) => `${i.where}:${i.detector.id}`;
const clampThreshold = (v: number) => Math.min(MAX_THRESHOLD, Math.max(MIN_THRESHOLD, v));

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

  const [list, setList] = useState<Item[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [suggested, setSuggested] = useState<Record<string, number | null>>({});
  /** Chosen detectors by `where:id`, with their threshold. */
  const [chosen, setChosen] = useState<Record<string, number>>({});
  const [busy, setBusy] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

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
  const blocker =
    status === null || (hardware === null && hardwareError === null)
      ? t('detect.preset.run.checking')
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
                : null;
  const canRecheck =
    !checking && refused?.code !== 'mac' && (refused !== null || hardwareError !== null);

  const toggle = (i: Item) => {
    setChosen((c) => {
      const k = keyOf(i);
      if (k in c) return Object.fromEntries(Object.entries(c).filter(([x]) => x !== k));
      return { ...c, [k]: clampThreshold(i.detector.threshold) };
    });
  };

  const start = async () => {
    if (blocker !== null || busy || !project) return;
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
      const q = await bridge.call('detect:queue', {});
      if (q.ok && q.value.items.some((w) => w.run === runId)) queued++;
      else errors.push(error);
    }
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

  const close = () => {
    if (!busy) onClose();
  };

  const detectorRow = (i: Item) => {
    const k = keyOf(i);
    const d = i.detector;
    const th = chosen[k];
    const hint = suggested[d.id];
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
          {i.modelMismatch && (
            <Tip content={t('detect.preset.modelMismatch')} repeatsName>
              <span
                className="det-vlm-mismatch"
                role="img"
                tabIndex={0}
                aria-label={t('detect.preset.modelMismatch')}
                data-testid={`det-vlm-mismatch-${d.id}`}
              >
                <Icon name="warn" size={14} />
              </span>
            </Tip>
          )}
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
            {typeof hint === 'number' && Math.abs(hint - th) > 1e-9 && (
              <span className="det-vlm-suggested" data-testid={`det-vlm-suggested-${d.id}`}>
                {t('detect.preset.run.suggested', { value: hint.toFixed(2) })}
                <Button
                  variant="quiet"
                  data-testid={`det-vlm-use-${d.id}`}
                  onClick={() => {
                    setChosen((c) => ({ ...c, [k]: clampThreshold(hint) }));
                  }}
                >
                  {t('detect.preset.run.use')}
                </Button>
              </span>
            )}
            {!classIds.has(d.classId) && (
              <p className="ann-faint" data-testid={`det-vlm-class-missing-${d.id}`}>
                {t('detect.preset.run.classMissing', { class: d.classId })}
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
            disabled={busy}
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
                    {t(`det.ai.scope.${s}`, { count: photoCount(lists[s]) })}
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
