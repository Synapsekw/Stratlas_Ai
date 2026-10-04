/**
 * The current detection: where it came from, class, severity, uncertain flag and note, and the
 * decisions (accept as a new issue, link to an issue, reject, reopen, delete a drawing).
 */
import { SeverityBadge, useTaxonomy } from '@aio/annotate';
import {
  acceptProblem,
  linkCandidates,
  type AcceptProblem,
  type Detection,
} from '@aio/annotate/detections';
import type { Issue } from '@aio/schema';
import { Icon, useT, type MessageKey } from '@aio/ui';
import { useEffect, useMemo, useRef, useState } from 'react';

export const PROBLEM_KEY: Record<AcceptProblem, MessageKey> = {
  'no-class': 'det.problem.noClass',
  'unknown-class': 'det.problem.unknownClass',
  'no-model': 'det.problem.noModel',
  'no-severity': 'det.problem.noSeverity',
  'bad-severity': 'det.problem.badSeverity',
  'no-uncertain': 'det.problem.noUncertain',
  'mask-on-frame': 'det.problem.maskOnFrame',
};

export interface InspectorProps {
  detection: Detection | null;
  position: { index: number; total: number };
  issues: readonly Issue[];
  readOnly: boolean;
  problem: AcceptProblem | null;
  issueError: string | null;
  linking: boolean;
  noteFocus: number;
  maskAssist: boolean;
  onPatch: (patch: Partial<Pick<Detection, 'classId' | 'severity' | 'uncertain' | 'note'>>) => void;
  onAccept: () => void;
  onLinkStart: () => void;
  onLinkCancel: () => void;
  onLink: (issueId: string) => void;
  onReject: () => void;
  onReopen: (issueGone: boolean) => void;
  onDelete: () => void;
  onOpenIssue: (issueId: string) => void;
  onMask: () => void;
  onStep: (dir: 1 | -1) => void;
}

function OriginLine({ d }: { d: Detection }) {
  const t = useT();
  const conf = d.confidence !== undefined ? Math.round(d.confidence * 100) : null;
  if (d.origin.kind === 'ai') {
    return (
      <p className="det-origin">
        <Icon name="agent" size={12} />
        <span>
          {t('det.origin.ai', { model: d.origin.model, prompt: d.origin.promptVersion || '?' })}
          {conf !== null && <b className="mono">{` ${t('det.confidence', { pct: conf })}`}</b>}
        </span>
      </p>
    );
  }
  if (d.origin.kind === 'pipeline') {
    return (
      <p className="det-origin">
        <Icon name="clock" size={12} />
        <span>
          {t('det.origin.pipeline', { pipeline: d.origin.pipeline })}
          {conf !== null && <b className="mono">{` ${t('det.confidence', { pct: conf })}`}</b>}
        </span>
      </p>
    );
  }
  return (
    <p className="det-origin">
      <Icon name="anno" size={12} />
      <span>{t('det.origin.human', { author: d.origin.author })}</span>
    </p>
  );
}

function LinkPicker({
  detection,
  issues,
  onPick,
  onCancel,
}: {
  detection: Detection;
  issues: readonly Issue[];
  onPick: (id: string) => void;
  onCancel: () => void;
}) {
  const t = useT();
  const [q, setQ] = useState('');
  const [at, setAt] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    input.current?.focus();
  }, []);
  const list = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const all = linkCandidates(detection, issues);
    const hits = needle
      ? all.filter((i) => `${i.code} ${i.title}`.toLowerCase().includes(needle))
      : all;
    return hits.slice(0, 50);
  }, [detection, issues, q]);
  const pick = list[Math.min(at, list.length - 1)];
  return (
    <div className="det-link" role="dialog" aria-label={t('det.link.title')}>
      <input
        ref={input}
        className="ann-input"
        placeholder={t('det.link.search')}
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setAt(0);
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') setAt((n) => Math.min(n + 1, list.length - 1));
          else if (e.key === 'ArrowUp') setAt((n) => Math.max(0, n - 1));
          else if (e.key === 'Enter' && pick) onPick(pick.id);
          else if (e.key === 'Escape') onCancel();
          else return;
          e.preventDefault();
          e.stopPropagation();
        }}
      />
      {list.length === 0 ? (
        <p className="ann-faint">{t('det.link.none')}</p>
      ) : (
        <ul className="det-link-list" role="listbox">
          {list.map((i) => (
            <li key={i.id}>
              <button
                type="button"
                role="option"
                aria-selected={pick?.id === i.id}
                onClick={() => {
                  onPick(i.id);
                }}
              >
                <b className="mono">{i.code}</b>
                <span>{i.title}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <button type="button" className="ann-btn ghost" onClick={onCancel}>
        {t('det.cancel')}
      </button>
    </div>
  );
}

export function Inspector(p: InspectorProps) {
  const t = useT();
  const { classes, classById, modelById, models } = useTaxonomy();
  const d = p.detection;
  const [note, setNote] = useState(d?.note ?? '');
  const [noteFor, setNoteFor] = useState(d?.id ?? null);
  if ((d?.id ?? null) !== noteFor) {
    setNoteFor(d?.id ?? null);
    setNote(d?.note ?? '');
  }
  const noteRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (p.noteFocus > 0) noteRef.current?.focus();
  }, [p.noteFocus]);

  if (!d) {
    return (
      <aside className="det-insp" aria-label={t('det.inspector')}>
        <div className="side-empty">
          <Icon name="target" size={20} />
          <p>{t('det.none')}</p>
        </div>
      </aside>
    );
  }

  const cls = classById.get(d.classId);
  const model = cls ? modelById.get(cls.severityModel) : models[0];
  const locked = p.readOnly || d.status === 'accepted';
  const issue = d.issueId ? p.issues.find((i) => i.id === d.issueId) : undefined;
  const ctx = {
    models,
    catalogues: [{ id: 'all', name: '', assetType: '', classes: [...classes] }],
  };
  const missing = d.status === 'draft' || d.status === 'rejected' ? acceptProblem(d, ctx) : null;
  const shownProblem = p.problem ?? null;
  const commitNote = () => {
    if (note !== d.note) p.onPatch({ note });
  };

  return (
    <aside className="det-insp" aria-label={t('det.inspector')} data-testid="det-inspector">
      <div className="ann-h">
        <h3>{t('det.inspector')}</h3>
        <span className="sub">
          {p.position.index > 0
            ? t('det.position', { index: p.position.index, total: p.position.total })
            : t(`det.status.${d.status}`)}
        </span>
        <span className="acts">
          <button
            type="button"
            className="ann-btn ghost"
            aria-label={t('det.prev')}
            title={t('det.prev')}
            onClick={() => {
              p.onStep(-1);
            }}
          >
            <Icon name="back" size={12} />
          </button>
          <button
            type="button"
            className="ann-btn ghost"
            aria-label={t('det.next')}
            title={t('det.next')}
            onClick={() => {
              p.onStep(1);
            }}
          >
            <Icon name="fwd" size={12} />
          </button>
        </span>
      </div>
      <div className="ann-body">
        <div className="det-status-row">
          <span className={`det-chip ${d.status}`} data-testid="det-status">
            {t(`det.status.${d.status}`)}
          </span>
          {d.uncertain && <span className="det-chip unc">{t('det.uncertain')}</span>}
        </div>
        <OriginLine d={d} />
        {d.label && d.classId === '' && (
          <p className="ann-faint">{t('det.modelSaid', { label: d.label })}</p>
        )}

        <label className="ann-field">
          <span>{t('det.class')}</span>
          <select
            className="ann-select"
            value={d.classId}
            disabled={locked}
            data-testid="det-class"
            onChange={(e) => {
              p.onPatch({ classId: e.target.value });
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
                aria-pressed={d.severity === l.value}
                disabled={locked}
                title={`${String(l.value)} ${l.label}${l.criteria ? `: ${l.criteria}` : ''}`}
                onClick={() => {
                  p.onPatch({ severity: l.value });
                }}
              >
                <SeverityBadge model={model} severity={l.value} withLabel />
              </button>
            ))}
          </div>
        </div>

        <label className="ann-check">
          <input
            type="checkbox"
            checked={d.uncertain}
            disabled={locked}
            data-testid="det-uncertain"
            onChange={(e) => {
              p.onPatch({ uncertain: e.target.checked });
            }}
          />
          {model?.uncertain
            ? t('det.uncertain.as', { label: model.uncertain.label })
            : t('det.uncertain.flag')}
        </label>

        <label className="det-note">
          <span className="ann-faint">{t('det.note')}</span>
          <textarea
            ref={noteRef}
            className="ann-input"
            value={note}
            disabled={locked}
            rows={3}
            onChange={(e) => {
              setNote(e.target.value);
            }}
            onBlur={commitNote}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                commitNote();
                e.currentTarget.blur();
              }
            }}
          />
        </label>

        {(shownProblem ?? missing) && d.status !== 'accepted' && (
          <p
            className={shownProblem ? 'ann-error' : 'ann-faint'}
            role={shownProblem ? 'alert' : undefined}
          >
            {t(PROBLEM_KEY[shownProblem ?? missing ?? 'no-class'])}
          </p>
        )}
        {p.issueError && (
          <p className="ann-error" role="alert">
            {p.issueError}
          </p>
        )}

        {d.status === 'accepted' ? (
          <div className="det-accepted">
            {issue ? (
              <>
                <p>{t('det.acceptedAs', { code: issue.code })}</p>
                <button
                  type="button"
                  className="ann-btn"
                  onClick={() => {
                    p.onOpenIssue(issue.id);
                  }}
                >
                  <Icon name="issues" size={12} />
                  {t('det.openIssue')}
                </button>
              </>
            ) : (
              <>
                <p className="ann-faint">{t('det.issueGone')}</p>
                {!p.readOnly && (
                  <button
                    type="button"
                    className="ann-btn"
                    onClick={() => {
                      p.onReopen(true);
                    }}
                  >
                    {t('det.reopen')}
                  </button>
                )}
              </>
            )}
          </div>
        ) : p.linking ? (
          <LinkPicker detection={d} issues={p.issues} onPick={p.onLink} onCancel={p.onLinkCancel} />
        ) : (
          !p.readOnly && (
            <div className="det-acts">
              <button
                type="button"
                className="ann-btn primary"
                data-testid="det-accept"
                onClick={p.onAccept}
                title={t('det.accept.tip')}
              >
                <Icon name="check" size={12} />
                {t('det.accept')}
                <kbd>A</kbd>
              </button>
              <button
                type="button"
                className="ann-btn"
                onClick={p.onLinkStart}
                title={t('det.link.tip')}
              >
                <Icon name="link" size={12} />
                {t('det.link')}
                <kbd>L</kbd>
              </button>
              {d.status === 'rejected' ? (
                <button
                  type="button"
                  className="ann-btn"
                  onClick={() => {
                    p.onReopen(false);
                  }}
                >
                  {t('det.reopen')}
                  <kbd>⇧R</kbd>
                </button>
              ) : (
                <button
                  type="button"
                  className="ann-btn danger"
                  data-testid="det-reject"
                  onClick={p.onReject}
                >
                  <Icon name="x" size={12} />
                  {t('det.reject')}
                  <kbd>X</kbd>
                </button>
              )}
              {d.origin.kind === 'human' && (
                <button type="button" className="ann-btn ghost danger" onClick={p.onDelete}>
                  {t('det.delete')}
                </button>
              )}
              {p.maskAssist && d.source.kind === 'photo' && d.geom.type === 'box' && (
                <button
                  type="button"
                  className="ann-btn ghost"
                  onClick={p.onMask}
                  title={t('det.mask.tip')}
                >
                  <Icon name="brush" size={12} />
                  {t('det.mask')}
                  <kbd>M</kbd>
                </button>
              )}
            </div>
          )
        )}
      </div>
    </aside>
  );
}
