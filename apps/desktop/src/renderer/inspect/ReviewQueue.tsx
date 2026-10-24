/**
 * The review queue, Inspect's right panel for working through AI suggestions one at a time: where
 * you are ("14 of 86"), class chips with counts, the Waiting / Accepted / Rejected filter, one
 * confidence slider, a zoomed crop of the current suggestion with its class and severity, and big
 * Accept (A), Fix (F) and Not a fault (D). Accept all of a class above the slider and Reject all
 * of a class go through the same confirm as before. The queue's current item is the review's
 * `currentId`, so the centre viewer follows it. Finishing the queue returns to the photo list.
 *
 * The screen owns the keyboard: in queue mode it sends A, F, D or X, J and K here through
 * `queueCommand`, so a key and a button take the same path (and a held A accepts once).
 */
import { SeverityBadge, useTaxonomy } from '@aio/annotate';
import {
  canRedo,
  canUndo,
  queueOf,
  sourceKey,
  type Detection,
  type QueueFilter,
} from '@aio/annotate/detections';
import type { ProjectManifest } from '@aio/schema';
import { formatCount, Icon, shortcutHint, useT } from '@aio/ui';
import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { BatchConfirm } from '../detections/BatchConfirm';
import { RejectReasonMenu } from '../detections/detectors/RejectReasonMenu';
import {
  detections,
  dispatch,
  planFor,
  redoReview,
  undoReview,
  useDetections,
} from '../detections/store';
import { toasts } from '../exports/exports';
import {
  acceptAllAbove,
  acceptSuggestion,
  dismissSuggestion,
  rejectAllOfClass,
  resolveImageSize,
  waitingOf,
} from './actions';
import { askAiPrefs } from './askAi/prefs';
import { Crop } from './Crop';
import { visibleDetections } from './findings';
import { leaveQueue, openQueue, useInspectUi } from './inspectUi';
import './reviewQueue.css';

export type QueueCommand = 'accept' | 'fix' | 'dismiss' | 'next' | 'prev';

const FILTERS: QueueFilter[] = ['draft', 'accepted', 'rejected'];
const CROP_W = 280;
const CROP_H = 180;
const DONE_TOAST = 'inspect-queue-done';

/** The open queue's command handler (one queue is open at a time). */
let active: ((cmd: QueueCommand) => void) | null = null;

/**
 * Run a queue key on the open queue: A accepts, F fixes, D or X is Not a fault, J and K step.
 * False when no queue is open. A command the queue cannot run now (read only, an accept still
 * pending) is dropped.
 */
export function queueCommand(cmd: QueueCommand): boolean {
  if (!active) return false;
  active(cmd);
  return true;
}

/** The project whose slider start was taken from the Ask AI settings (once per project load). */
let seeded: string | null = null;
detections.subscribe((s, prev) => {
  if (s.projectId !== prev.projectId) seeded = null;
});

const isScored = (d: Detection) => !d.unscored && d.confidence !== undefined;

export function ReviewQueue(p: {
  projectId: string;
  manifest: ProjectManifest;
  readOnly: boolean;
  /** Fix: the screen makes the current draft's shape editable in the viewer and opens its ChangePicker (Task 11). */
  onFix: () => void;
  /** Accept answered `needs: 'picker'`: the screen opens the ChangePicker for that draft. */
  onNeedsPicker: (detectionId: string) => void;
}): ReactElement {
  const t = useT();
  const review = useDetections((s) => s.review);
  const storeProject = useDetections((s) => s.projectId);
  const storeReadOnly = useDetections((s) => s.readOnly);
  const save = useDetections((s) => s.save);
  const issueError = useDetections((s) => s.issueError);
  const queueClass = useInspectUi((s) => s.queueClass);
  const { classes, classById, modelById } = useTaxonomy();
  const readOnly = p.readOnly || storeReadOnly;

  const [pendingState, setPending] = useState(false);
  const pending = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [skipped, setSkipped] = useState(0);
  const [batch, setBatch] = useState<'accept' | 'reject' | null>(null);
  const [reasonOpen, setReasonOpen] = useState(false);
  const reasonBtn = useRef<HTMLButtonElement>(null);
  const [sizes, setSizes] = useState<ReadonlyMap<string, [number, number]>>(new Map());

  // the slider starts at the Ask AI setting once per project load, then is the reviewer's
  useEffect(() => {
    if (storeProject !== p.projectId || seeded === storeProject) return;
    seeded = storeProject;
    dispatch({ type: 'minConfidence', value: askAiPrefs.getState().queueThreshold });
  }, [storeProject, p.projectId]);

  const queueAll = useMemo(() => queueOf(review), [review]);
  // a draft relabelled in the queue stays on the chip while it is current, so relabel then
  // accept works (it leaves once decided, or once the reviewer steps away)
  const [kept, setKept] = useState<{ id: string; cls: string } | null>(null);
  const keptId = kept?.id === review.currentId && kept.cls === queueClass ? kept.id : null;
  const list = useMemo(
    () =>
      queueClass === null
        ? queueAll
        : queueAll.filter((d) => d.classId === queueClass || d.id === keptId),
    [queueAll, queueClass, keptId],
  );
  const at = list.findIndex((d) => d.id === review.currentId);
  const current = at >= 0 ? (list[at] ?? null) : null;

  // keep the place: when the current item leaves the list (decided, another chip, the slider),
  // the one now at its index is next
  const lastAt = useRef(0);
  useEffect(() => {
    if (at >= 0) {
      lastAt.current = at;
      return;
    }
    const next = list[Math.min(lastAt.current, list.length - 1)];
    if (next) dispatch({ type: 'select', id: next.id });
  }, [at, list]);

  // the last waiting suggestion decided: back to the photos, with one "all checked"
  const before = useRef({ revision: review.revision, length: list.length });
  useEffect(() => {
    const was = before.current;
    before.current = { revision: review.revision, length: list.length };
    if (review.revision === was.revision || review.filter !== 'draft') return;
    if (was.length > 0 && list.length === 0) {
      leaveQueue();
      toasts.getState().start(DONE_TOAST, t('queue.title'));
      toasts.getState().finish(DONE_TOAST, 'done', t('queue.done'));
    }
  }, [review.revision, review.filter, list.length, t]);

  // a normalized draft's crop needs its photo's pixel size
  const currentKey = current ? sourceKey(current.source) : null;
  useEffect(() => {
    if (!currentKey || current?.source.kind !== 'photo') return;
    let live = true;
    void resolveImageSize(currentKey).then((size) => {
      if (live && size) setSizes((m) => new Map(m).set(currentKey, size));
    });
    return () => {
      live = false;
    };
  }, [currentKey, current?.source.kind]);

  const counts = useMemo(() => {
    const c = { draft: 0, accepted: 0, rejected: 0 };
    for (const d of visibleDetections(review)) c[d.status] += 1;
    return c;
  }, [review]);

  const chips = useMemo(() => {
    const n = new Map<string, number>();
    for (const d of queueAll) n.set(d.classId, (n.get(d.classId) ?? 0) + 1);
    return classes.flatMap((c) => {
      const count = n.get(c.id) ?? 0;
      return count > 0 || c.id === queueClass ? [{ id: c.id, label: c.label, count }] : [];
    });
  }, [queueAll, classes, queueClass]);

  // the footer acts on the chip's class, or the current suggestion's
  const footerClass =
    queueClass ?? (current && classById.has(current.classId) ? current.classId : null);
  const threshold = review.minConfidence;
  const above = useMemo(
    () =>
      footerClass
        ? waitingOf(footerClass, threshold).filter(
            (d) => isScored(d) && (d.confidence ?? 0) >= threshold,
          )
        : [],
    // `review` and `classes`: the lists follow every change and a class added while working
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [footerClass, threshold, review, classes],
  );
  const ofClass = useMemo(
    () => (footerClass ? waitingOf(footerClass, 0) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [footerClass, review],
  );
  const acceptPlan = useMemo(() => planFor(above), [above]);
  const rejectPlan = useMemo(() => planFor(ofClass), [ofClass]);

  const locked = readOnly || !current || current.status === 'accepted';
  const canDismiss = !readOnly && current?.status === 'draft';
  const reason = readOnly ? t('inspect.readOnly') : undefined;

  const begin = () => {
    if (pending.current) return false;
    pending.current = true;
    setPending(true);
    setError(null);
    return true;
  };
  const end = () => {
    pending.current = false;
    setPending(false);
  };

  const accept = async () => {
    if (locked || !begin()) return;
    const id = current.id;
    try {
      const r = await acceptSuggestion(p.projectId, id);
      if (!r.ok) {
        if ('needs' in r) p.onNeedsPicker(id);
        else setError(r.error);
      }
    } finally {
      end();
    }
  };

  const dismiss = (
    why: Parameters<typeof dismissSuggestion>[1] = 'not-a-defect',
    note?: string,
  ) => {
    if (!canDismiss || pending.current) return;
    setError(null);
    dismissSuggestion(current.id, why, note);
  };

  const fix = () => {
    if (locked || pending.current) return;
    p.onFix();
  };

  const step = (dir: 1 | -1) => {
    setKept(null);
    if (list.length === 0) return;
    const i = at < 0 ? 0 : (at + dir + list.length) % list.length;
    const d = list[i];
    if (d) dispatch({ type: 'select', id: d.id });
  };

  const run = useRef<(cmd: QueueCommand) => void>(() => undefined);
  // the latest render's handler, so a key acts on what is on screen
  useEffect(() => {
    run.current = (cmd) => {
      switch (cmd) {
        case 'accept':
          void accept();
          break;
        case 'fix':
          fix();
          break;
        case 'dismiss':
          dismiss();
          break;
        case 'next':
          step(1);
          break;
        case 'prev':
          step(-1);
          break;
      }
    };
  });
  useEffect(() => {
    const handler = (cmd: QueueCommand) => {
      run.current(cmd);
    };
    active = handler;
    return () => {
      if (active === handler) active = null;
    };
  }, []);

  const confirmBatch = async () => {
    const kind = batch;
    setBatch(null);
    if (!footerClass || !kind) return;
    if (kind === 'reject') {
      rejectAllOfClass(footerClass);
      return;
    }
    if (!begin()) return;
    try {
      // the slider as it is now: only drafts of this class at or above it are accepted
      const r = await acceptAllAbove(footerClass, detections.getState().review.minConfidence);
      if ('error' in r) setError(r.error);
      else setSkipped(r.skipped);
    } finally {
      end();
    }
  };

  const cls = current ? classById.get(current.classId) : undefined;
  const model = cls ? modelById.get(cls.severityModel) : undefined;
  const footerLabel = footerClass ? (classById.get(footerClass)?.label ?? footerClass) : '';
  const pct = Math.round(threshold * 100);

  return (
    <section className="inspect-queue" data-testid="inspect-queue" aria-label={t('queue.title')}>
      <header className="queue-h">
        <div className="queue-row">
          <h2>{t('queue.title')}</h2>
          <span className="mono queue-progress" data-testid="queue-progress">
            {t('queue.progress', { index: at >= 0 ? at + 1 : 0, total: list.length })}
          </span>
          <span className="grow" />
          <button
            type="button"
            className="btn ghost icon sm"
            data-testid="queue-undo"
            aria-label={t('det.undo', { keys: shortcutHint('review.undo') })}
            title={t('det.undo', { keys: shortcutHint('review.undo') })}
            disabled={readOnly || !canUndo(review)}
            onClick={undoReview}
          >
            <Icon name="undo" size={14} />
          </button>
          <button
            type="button"
            className="btn ghost icon sm"
            data-testid="queue-redo"
            aria-label={t('det.redo', { keys: shortcutHint('review.redo') })}
            title={t('det.redo', { keys: shortcutHint('review.redo') })}
            disabled={readOnly || !canRedo(review)}
            onClick={redoReview}
          >
            <Icon name="undo" size={14} className="flip" />
          </button>
          <span
            className="ann-save"
            data-state={save.state}
            title={save.error ?? ''}
            data-testid="det-save"
          >
            <i />
            {readOnly ? t('det.save.readOnly') : t(`det.save.${save.state}`)}
          </span>
          <button
            type="button"
            className="btn ghost sm"
            data-testid="queue-leave"
            onClick={leaveQueue}
          >
            {t('queue.leave')}
          </button>
        </div>
        <span className="mono faint queue-counts" data-testid="det-counts">
          {t('det.counts', {
            draft: formatCount(counts.draft),
            accepted: formatCount(counts.accepted),
            rejected: formatCount(counts.rejected),
          })}
        </span>
        <div className="queue-chips" role="group" aria-label={t('det.class')}>
          <button
            type="button"
            className="queue-chip"
            data-testid="queue-class-all"
            aria-pressed={queueClass === null}
            onClick={() => {
              setKept(null);
              openQueue(null);
            }}
          >
            {t('queue.allClasses')} <span className="mono">{formatCount(queueAll.length)}</span>
          </button>
          {chips.map((c) => (
            <button
              key={c.id}
              type="button"
              className="queue-chip"
              data-testid={`queue-class-${c.id}`}
              aria-pressed={queueClass === c.id}
              onClick={() => {
                setKept(null);
                openQueue(c.id);
              }}
            >
              {c.label} <span className="mono">{formatCount(c.count)}</span>
            </button>
          ))}
        </div>
        <div className="queue-row">
          <div className="seg" role="group" aria-label={t('det.filter')} data-testid="queue-filter">
            {FILTERS.map((f) => (
              <button
                key={f}
                type="button"
                aria-pressed={review.filter === f}
                onClick={() => {
                  dispatch({ type: 'filter', filter: f });
                }}
              >
                {t(`det.filter.${f}`)}
              </button>
            ))}
          </div>
          <label className="queue-threshold">
            <span>{t('queue.threshold', { pct })}</span>
            <input
              type="range"
              min={0}
              max={0.95}
              step={0.05}
              value={threshold}
              data-testid="queue-threshold"
              aria-label={t('queue.thresholdLabel')}
              // the slider's keys (arrows, Home, End) are its own, not the review's shortcuts
              onKeyDown={(e) => {
                e.stopPropagation();
              }}
              onChange={(e) => {
                dispatch({ type: 'minConfidence', value: Number(e.target.value) });
              }}
            />
          </label>
        </div>
      </header>

      {(error ?? issueError) && (
        <p className="queue-error" role="alert" data-testid="queue-error">
          {error ?? issueError}
        </p>
      )}
      {skipped > 0 && (
        <p className="queue-note" role="status" data-testid="queue-skipped">
          {t('det.acceptAll.skip', { count: skipped })}
        </p>
      )}

      {current ? (
        <div className="queue-body">
          <Crop
            projectId={p.projectId}
            detection={current}
            imageSize={currentKey ? (sizes.get(currentKey) ?? null) : null}
            width={CROP_W}
            height={CROP_H}
            layers={p.manifest.layers}
          />
          <div className="queue-step">
            <button
              type="button"
              className="btn ghost icon sm"
              data-testid="queue-prev"
              aria-label={shortcutHint('review.prev')}
              title={shortcutHint('review.prev')}
              onClick={() => {
                step(-1);
              }}
            >
              <Icon name="chev-r" size={14} className="flip" />
            </button>
            {current.confidence !== undefined && !current.unscored && (
              <span className="mono faint">{Math.round(current.confidence * 100)}%</span>
            )}
            <button
              type="button"
              className="btn ghost icon sm"
              data-testid="queue-next"
              aria-label={shortcutHint('review.next')}
              title={shortcutHint('review.next')}
              onClick={() => {
                step(1);
              }}
            >
              <Icon name="chev-r" size={14} />
            </button>
          </div>
          <label className="ann-field">
            <span>{t('det.class')}</span>
            <select
              className="ann-select"
              value={current.classId}
              disabled={locked || pendingState}
              data-testid="det-class"
              onChange={(e) => {
                if (queueClass !== null) setKept({ id: current.id, cls: queueClass });
                dispatch({
                  type: 'edit',
                  id: current.id,
                  patch: { classId: e.target.value },
                  now: new Date().toISOString(),
                });
              }}
            >
              <option value="">{t('det.class.pick')}</option>
              {classes.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </select>
          </label>
          <div className="ann-field">
            <span>{t('det.severity')}</span>
            <div className="det-sevs" role="group" aria-label={t('det.severity')}>
              {(model?.levels ?? []).map((l) => (
                <button
                  key={l.value}
                  type="button"
                  className="det-sev"
                  data-testid={`queue-sev-${String(l.value)}`}
                  aria-pressed={current.severity === l.value}
                  disabled={locked || pendingState}
                  title={`${String(l.value)} ${l.label}${l.criteria ? `: ${l.criteria}` : ''}`}
                  onClick={() => {
                    dispatch({
                      type: 'edit',
                      id: current.id,
                      patch: { severity: l.value, uncertain: false },
                      now: new Date().toISOString(),
                    });
                  }}
                >
                  <SeverityBadge model={model} severity={l.value} withLabel />
                </button>
              ))}
            </div>
          </div>
          <div className="queue-actions">
            <button
              type="button"
              className="btn primary queue-big"
              data-testid="queue-accept"
              disabled={locked || pendingState}
              title={reason}
              onClick={() => void accept()}
            >
              <Icon name="check" size={14} />
              {t('queue.accept')}
              <kbd>A</kbd>
            </button>
            <button
              type="button"
              className="btn queue-big"
              data-testid="queue-fix"
              disabled={locked || pendingState}
              title={reason}
              onClick={fix}
            >
              {t('queue.fix')}
              <kbd>F</kbd>
            </button>
            <span className="queue-dismiss">
              <button
                type="button"
                className="btn queue-big"
                data-testid="queue-not-fault"
                disabled={!canDismiss || pendingState}
                title={reason}
                onClick={() => {
                  dismiss();
                }}
              >
                <Icon name="x" size={14} />
                {t('queue.notFault')}
                <kbd>D</kbd>
              </button>
              <button
                ref={reasonBtn}
                type="button"
                className="btn ghost icon"
                data-testid="queue-reject-reason"
                aria-label={t('detect.preset.reject.title')}
                title={reason ?? t('detect.preset.reject.title')}
                aria-haspopup="menu"
                aria-expanded={reasonOpen}
                disabled={!canDismiss || pendingState}
                onClick={() => {
                  setReasonOpen((o) => !o);
                }}
              >
                <Icon name="chev-d" size={12} />
              </button>
              <RejectReasonMenu
                open={reasonOpen}
                opener={reasonBtn}
                onClose={() => {
                  setReasonOpen(false);
                }}
                onPick={(why, note) => {
                  if (why === null) {
                    if (canDismiss) dismissSuggestion(current.id);
                  } else dismiss(why, note);
                }}
              />
            </span>
          </div>
        </div>
      ) : (
        <p className="queue-empty faint">{t('queue.done')}</p>
      )}

      {footerClass && (
        <footer className="queue-f">
          <button
            type="button"
            className="btn sm"
            data-testid="det-accept-all"
            title={reason}
            disabled={readOnly || pendingState || batch !== null || acceptPlan.accept === 0}
            onClick={() => {
              setSkipped(0);
              setBatch('accept');
            }}
          >
            {t('queue.acceptAbove', { class: footerLabel, pct, count: acceptPlan.accept })}
          </button>
          <button
            type="button"
            className="btn ghost sm"
            data-testid="det-reject-all"
            title={reason}
            disabled={readOnly || pendingState || batch !== null || rejectPlan.reject === 0}
            onClick={() => {
              setBatch('reject');
            }}
          >
            {t('queue.rejectClass', { class: footerLabel, count: rejectPlan.reject })}
          </button>
          {batch && (
            <BatchConfirm
              kind={batch}
              plan={batch === 'accept' ? acceptPlan : rejectPlan}
              onCancel={() => {
                setBatch(null);
              }}
              onConfirm={() => void confirmBatch()}
            />
          )}
        </footer>
      )}
    </section>
  );
}
