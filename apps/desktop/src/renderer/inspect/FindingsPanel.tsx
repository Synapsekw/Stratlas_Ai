/**
 * Findings on this photo: the issues a person confirmed (solid, in their severity colour) and the
 * AI's waiting suggestions (dashed, with their confidence) in one list. A suggestion has Accept
 * (one key, the project's last choice filling a missing class or severity), Change (the class and
 * severity picker) and Dismiss (a detector's draft asks why first). Below: Draw a finding, and how
 * many photos still wait, with the way to the next one. A read-only package shows the list only.
 */
import { annotateUi, severityColor, SeverityBadge, useTaxonomy } from '@aio/annotate';
import { detectorThreshold, isDetectorDraft, type Detection } from '@aio/annotate/detections';
import type { Issue } from '@aio/schema';
import { Icon, Tip, useT } from '@aio/ui';
import { useEffect, useRef, useState, type ReactElement } from 'react';
import { RejectReasonMenu } from '../detections/detectors/RejectReasonMenu';
import { ScoreBadge } from '../detections/detectors/ScoreBadge';
import { useDetections } from '../detections/store';
import { acceptSuggestion, dismissSuggestion } from './actions';
import { ChangePicker } from './ChangePicker';
import { FieldsList } from './FieldsForm';
import type { FindingRow } from './findings';
import './findingsPanel.css';

export interface FindingsPanelProps {
  projectId: string;
  rows: readonly FindingRow[];
  issues: readonly Issue[];
  leftToReview: number;
  readOnly: boolean;
  /** issue: workspace select; ai: dispatch select */
  onSelectRow: (row: FindingRow) => void;
  onNextToReview: () => void;
}

type AiRow = Extract<FindingRow, { kind: 'ai' }>;

function YouCard({
  row,
  onSelect,
}: {
  row: Extract<FindingRow, { kind: 'you' }>;
  onSelect: () => void;
}) {
  const t = useT();
  const { classById, modelById } = useTaxonomy();
  const model = modelById.get(row.severityModelId);
  return (
    <li
      className="inspect-row"
      data-testid="inspect-row"
      data-kind="you"
      data-key={row.key}
      data-selected={row.selected || undefined}
      style={{ ['--sev' as string]: severityColor(model, row.severity) }}
    >
      <Tip content={row.title} placement="top">
        <button
          type="button"
          className="inspect-row-head"
          aria-current={row.selected || undefined}
          onClick={onSelect}
        >
          <span className="inspect-tag you">{t('inspect.tag.you')}</span>
          <span className="inspect-row-class">
            <b className="mono">{row.code}</b> {classById.get(row.classId)?.label ?? row.title}
          </span>
          <SeverityBadge model={model} severity={row.severity} />
        </button>
      </Tip>
    </li>
  );
}

function AiCard(p: {
  projectId: string;
  row: AiRow;
  detection: Detection | undefined;
  threshold: number | null;
  issues: readonly Issue[];
  readOnly: boolean;
  picker: 'pick' | 'link' | null;
  onPicker: (on: 'pick' | 'link' | null) => void;
  onSelect: () => void;
}) {
  const t = useT();
  const { classById, modelById } = useTaxonomy();
  const { row, detection: d } = p;
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const dismissBtn = useRef<HTMLButtonElement>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const cls = classById.get(row.classId);
  const model = cls ? modelById.get(cls.severityModel) : undefined;
  const severity = row.uncertain ? 'uncertain' : row.severity;
  const detector = d ? isDetectorDraft(d) : false;

  const accept = () => {
    if (pending) return;
    setPending(true);
    setError(null);
    void acceptSuggestion(p.projectId, row.detectionId)
      .then((r) => {
        if (!alive.current || r.ok) return;
        if ('needs' in r) p.onPicker('pick');
        else setError(r.error);
      })
      .catch((e: unknown) => {
        if (alive.current) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (alive.current) setPending(false);
      });
  };

  return (
    <li
      className="inspect-row"
      data-testid="inspect-row"
      data-kind="ai"
      data-key={row.key}
      data-selected={row.selected || undefined}
    >
      <button
        type="button"
        className="inspect-row-head"
        aria-current={row.selected || undefined}
        onClick={p.onSelect}
      >
        {detector ? (
          <ScoreBadge score={row.confidence} threshold={p.threshold} unscored={row.unscored} />
        ) : (
          <span className="inspect-tag ai">
            {row.confidence === undefined || row.unscored
              ? t('inspect.tag.aiUnscored')
              : t('inspect.tag.ai', { pct: Math.round(row.confidence * 100) })}
          </span>
        )}
        <span className="inspect-row-class">{cls?.label ?? row.label ?? t('det.class.pick')}</span>
        {severity !== null && <SeverityBadge model={model} severity={severity} />}
      </button>
      {d?.note && (
        <p className="inspect-row-note" data-testid="inspect-row-note">
          {d.note}
        </p>
      )}
      {d?.fields && d.fields.length > 0 && <FieldsList fields={d.fields} />}
      {error && (
        <p className="ann-error" role="alert">
          {error}
        </p>
      )}
      {!p.readOnly && (
        <div className="inspect-row-acts">
          <button
            type="button"
            className="ann-btn primary"
            data-testid="inspect-accept"
            disabled={pending}
            onClick={accept}
          >
            <Icon name="check" size={12} />
            {t('inspect.accept')}
            <kbd>A</kbd>
          </button>
          <button
            type="button"
            className="ann-btn"
            data-testid="inspect-change"
            disabled={pending}
            aria-expanded={p.picker !== null}
            onClick={() => {
              p.onPicker(p.picker ? null : 'pick');
            }}
          >
            {t('inspect.change')}
          </button>
          <button
            ref={dismissBtn}
            type="button"
            className="ann-btn ghost danger"
            data-testid="inspect-dismiss"
            disabled={pending}
            aria-haspopup={detector ? 'menu' : undefined}
            aria-expanded={detector ? asking : undefined}
            onClick={() => {
              if (detector) setAsking((o) => !o);
              else dismissSuggestion(row.detectionId);
            }}
          >
            <Icon name="x" size={12} />
            {t('inspect.dismiss')}
            <kbd>D</kbd>
          </button>
          {detector && (
            <RejectReasonMenu
              open={asking}
              opener={dismissBtn}
              onClose={() => {
                setAsking(false);
              }}
              onPick={(reason, note) => {
                if (reason === null) dismissSuggestion(row.detectionId);
                else dismissSuggestion(row.detectionId, reason, note);
              }}
            />
          )}
        </div>
      )}
      {p.picker && d && !p.readOnly && (
        <ChangePicker
          projectId={p.projectId}
          detection={d}
          issues={p.issues}
          startOn={p.picker}
          onDone={() => {
            p.onPicker(null);
          }}
          onCancel={() => {
            p.onPicker(null);
          }}
        />
      )}
    </li>
  );
}

export function FindingsPanel(p: FindingsPanelProps): ReactElement {
  const t = useT();
  const review = useDetections((s) => s.review);
  const [picker, setPicker] = useState<{ id: string; on: 'pick' | 'link' } | null>(null);
  const byId = new Map(review.detections.map((d) => [d.id, d]));

  return (
    <section className="inspect-findings-panel" aria-label={t('inspect.panel.title')}>
      <header className="inspect-panel-h">
        <h3>{t('inspect.panel.title')}</h3>
        <span className="sub">{t('inspect.panel.sub')}</span>
      </header>
      {p.rows.length === 0 ? (
        <p className="ann-faint inspect-none">{t('inspect.none')}</p>
      ) : (
        <ul className="inspect-rows">
          {p.rows.map((row) => {
            if (row.kind === 'you') {
              return (
                <YouCard
                  key={row.key}
                  row={row}
                  onSelect={() => {
                    p.onSelectRow(row);
                  }}
                />
              );
            }
            const d = byId.get(row.detectionId);
            return (
              <AiCard
                key={row.key}
                projectId={p.projectId}
                row={row}
                detection={d}
                threshold={d ? detectorThreshold(review, d) : null}
                issues={p.issues}
                readOnly={p.readOnly}
                picker={picker?.id === row.detectionId ? picker.on : null}
                onPicker={(on) => {
                  setPicker(on ? { id: row.detectionId, on } : null);
                }}
                onSelect={() => {
                  p.onSelectRow(row);
                }}
              />
            );
          })}
        </ul>
      )}
      {p.readOnly ? (
        <p className="ann-faint inspect-readonly">{t('inspect.readOnly')}</p>
      ) : (
        <button
          type="button"
          className="ann-btn ghost inspect-draw"
          data-testid="inspect-draw"
          onClick={() => {
            annotateUi.setState({ imageTool: 'box' });
          }}
        >
          <Icon name="plus" size={12} />
          {t('inspect.draw')}
          <kbd>B</kbd>
        </button>
      )}
      <footer className="inspect-panel-foot">
        <span className="ann-faint">{t('inspect.left', { count: p.leftToReview })}</span>
        <button
          type="button"
          className="ann-btn"
          data-testid="inspect-next-review"
          disabled={p.leftToReview === 0}
          onClick={p.onNextToReview}
        >
          {t('inspect.nextToReview')}
          <Icon name="fwd" size={12} />
        </button>
      </footer>
    </section>
  );
}
