import type { FieldWrite } from '@aio/merge';
import type { Conflict, QuarantineEntry, RecordRef } from '@aio/schema';
import { t } from '@aio/ui';
import { useId, useState } from 'react';
import './conflicts.css';

/**
 * The Conflicts inbox (M9 T4): two values written apart to one field, both people and both times,
 * with Keep mine, Keep theirs, Edit and Restore; deletes and merges that lost to an edit; codes
 * renumbered after two issues were made apart; and quarantined changes an owner may apply.
 * Presentational: the caller reads `sync:conflicts` and `sync:quarantine` and sends the choice
 * through `sync:resolve` and `sync:release`, then the projection reloads on `journal:changed`.
 */

export type ResolveChoice = 'ours' | 'theirs' | 'restore';

export interface ConflictsPanelProps {
  conflicts: readonly Conflict[];
  quarantined?: readonly QuarantineEntry[];
  /** The person looking (actor id): their side reads "You". */
  viewer?: string;
  /** Display name of an actor. */
  nameOf: (actor: string) => string;
  /** A short label for a record ("F02", "Change issue:F01"). */
  labelOf: (target: RecordRef) => string;
  /** Earlier values of the conflict's field (History), for Restore. */
  historyOf?: (conflict: Conflict) => readonly FieldWrite[];
  /** An owner may apply quarantined changes. */
  canRelease?: boolean;
  /** Keep a side, or write `value` (Edit, Restore). Rejecting shows the error on the entry. */
  onResolve: (conflict: Conflict, choice: ResolveChoice, value?: unknown) => Promise<void> | void;
  onRelease?: (entry: QuarantineEntry) => Promise<void> | void;
  className?: string;
}

const FIELD_NAMES: Record<string, string> = {
  classId: 'class',
  severityModelId: 'severity model',
  resolvedIn: 'resolved on',
  edit: 'boundary',
};

/** When a clock reading was taken, as people read it. */
export function whenOf(hlc: string): string {
  const ms = Number(hlc.slice(0, 13));
  if (!Number.isFinite(ms)) return hlc;
  return new Date(ms).toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** A value as text: plain values as they are, a class with its model by the class. */
export function showValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return t('conflicts.none');
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (typeof value === 'object' && !Array.isArray(value)) {
    const o = value as Record<string, unknown>;
    if (typeof o.classId === 'string') return o.classId;
    if (typeof o.status === 'string') return o.status;
  }
  const text = JSON.stringify(value);
  return text.length > 80 ? `${text.slice(0, 79)}…` : text;
}

const editable = (c: Conflict) =>
  c.kind === 'value' &&
  [c.ours.value, c.theirs.value].every((v) => typeof v === 'string' || typeof v === 'number');

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function ConflictEntry(props: ConflictsPanelProps & { conflict: Conflict }) {
  const { conflict: c, viewer, nameOf, labelOf, historyOf, onResolve } = props;
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputId = useId();
  const record = labelOf(c.target);
  const field = FIELD_NAMES[c.field] ?? c.field;
  const who = (actor: string) => (actor === viewer ? t('conflicts.you') : nameOf(actor));
  const run = async (choice: ResolveChoice, value?: unknown) => {
    setBusy(true);
    setError(null);
    try {
      await onResolve(c, choice, value);
      setEditing(null);
    } catch (e) {
      setError(t('conflicts.failed', { error: errorText(e) }));
    } finally {
      setBusy(false);
    }
  };

  if (c.kind === 'code') {
    return (
      <li className="cf-item" data-kind={c.kind}>
        <p className="cf-text">
          {t('conflicts.recoded', {
            record,
            from: showValue(c.ours.value),
            to: showValue(c.theirs.value),
          })}
        </p>
        <div className="cf-actions">
          <button
            type="button"
            className="btn sm"
            disabled={busy}
            onClick={() => void run('theirs')}
          >
            {t('conflicts.ok')}
          </button>
        </div>
        {error && (
          <p className="cf-error" role="alert">
            {error}
          </p>
        )}
      </li>
    );
  }

  if (c.kind === 'delete-edit' || c.kind === 'merge') {
    // `true` (deleted) or `{ into }` (merged) is the side that removed the record
    const removing = c.ours.value === false ? 'theirs' : 'ours';
    const kept = removing === 'ours' ? 'theirs' : 'ours';
    return (
      <li className="cf-item" data-kind={c.kind}>
        <p className="cf-text">
          {t(c.kind === 'merge' ? 'conflicts.merged' : 'conflicts.deleted', {
            name: who(c[removing].by),
            other: who(c[kept].by),
            record,
          })}
        </p>
        <div className="cf-actions">
          <button
            type="button"
            className="btn sm"
            disabled={busy}
            onClick={() => void run(removing)}
          >
            {t(c.kind === 'merge' ? 'conflicts.mergeAgain' : 'conflicts.deleteAgain')}
          </button>
          <button
            type="button"
            className="btn sm ghost"
            disabled={busy}
            onClick={() => void run(kept)}
          >
            {t('conflicts.keepIt')}
          </button>
        </div>
        {error && (
          <p className="cf-error" role="alert">
            {error}
          </p>
        )}
      </li>
    );
  }

  const earlier = (historyOf?.(c) ?? []).filter(
    (h) => h.op !== c.ours.op && h.op !== c.theirs.op && !h.absent,
  );
  const side = (key: 'ours' | 'theirs') => {
    const s = c[key];
    const label =
      key === 'theirs'
        ? t('conflicts.keepTheirs')
        : s.by === viewer
          ? t('conflicts.keepMine')
          : t('conflicts.keepThis');
    return (
      <div className="cf-side" data-side={key} data-current={c.current === key || undefined}>
        <span className="cf-value">{showValue(s.value)}</span>
        <span className="cf-who">
          {t('conflicts.side', { name: who(s.by), when: whenOf(s.hlc) })}
          {c.current === key && <span className="cf-now">{t('conflicts.inProject')}</span>}
        </span>
        <button
          type="button"
          className="btn sm"
          disabled={busy}
          aria-label={`${label}: ${record} ${field} ${showValue(s.value)}`}
          onClick={() => void run(key)}
        >
          {label}
        </button>
      </div>
    );
  };

  return (
    <li className="cf-item" data-kind={c.kind}>
      <h3 className="cf-h">{t('conflicts.heading', { record, field })}</h3>
      {side('ours')}
      {side('theirs')}
      {editing === null ? (
        editable(c) && (
          <div className="cf-actions">
            <button
              type="button"
              className="btn sm ghost"
              disabled={busy}
              onClick={() => {
                setEditing(String(c[c.current].value));
              }}
            >
              {t('conflicts.edit')}
            </button>
          </div>
        )
      ) : (
        <form
          className="cf-edit"
          onSubmit={(e) => {
            e.preventDefault();
            const numeric = typeof c.ours.value === 'number' && typeof c.theirs.value === 'number';
            const n = Number(editing);
            void run('restore', numeric && Number.isFinite(n) ? n : editing);
          }}
        >
          <label className="sr-only" htmlFor={inputId}>
            {t('conflicts.editLabel', { record, field })}
          </label>
          <input
            id={inputId}
            value={editing}
            disabled={busy}
            onChange={(e) => {
              setEditing(e.target.value);
            }}
          />
          <button type="submit" className="btn sm primary" disabled={busy || editing.trim() === ''}>
            {t('conflicts.save')}
          </button>
          <button
            type="button"
            className="btn sm ghost"
            disabled={busy}
            onClick={() => {
              setEditing(null);
            }}
          >
            {t('conflicts.cancel')}
          </button>
        </form>
      )}
      {earlier.length > 0 && (
        <details className="cf-history">
          <summary>{t('conflicts.history')}</summary>
          <ul>
            {earlier.map((h) => (
              <li key={h.op}>
                <span className="cf-value">{showValue(h.value)}</span>
                <span className="cf-who">
                  {t('conflicts.side', { name: who(h.by), when: whenOf(h.hlc) })}
                </span>
                <button
                  type="button"
                  className="btn sm ghost"
                  disabled={busy}
                  aria-label={`${t('conflicts.restore')}: ${showValue(h.value)}`}
                  onClick={() => void run('restore', h.value)}
                >
                  {t('conflicts.restore')}
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}
      {error && (
        <p className="cf-error" role="alert">
          {error}
        </p>
      )}
    </li>
  );
}

function QuarantineItem(props: ConflictsPanelProps & { entry: QuarantineEntry }) {
  const { entry: q, nameOf, labelOf, canRelease, onRelease } = props;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <li className="cf-item" data-kind="quarantine">
      <p className="cf-text">
        {t('conflicts.quarantineItem', {
          kind: q.kind,
          record: labelOf(q.target),
          name: nameOf(q.by),
          when: whenOf(q.hlc),
        })}
      </p>
      <p className="cf-why">{q.message}</p>
      {canRelease && onRelease && (
        <div className="cf-actions">
          <button
            type="button"
            className="btn sm"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              setError(null);
              Promise.resolve(onRelease(q))
                .catch((e: unknown) => {
                  setError(t('conflicts.failed', { error: errorText(e) }));
                })
                .finally(() => {
                  setBusy(false);
                });
            }}
          >
            {t('conflicts.apply')}
          </button>
        </div>
      )}
      {error && (
        <p className="cf-error" role="alert">
          {error}
        </p>
      )}
    </li>
  );
}

export function ConflictsPanel(props: ConflictsPanelProps) {
  const { conflicts, quarantined = [], canRelease = false, className } = props;
  const headingId = useId();
  return (
    <section
      className={['cf-panel', className].filter(Boolean).join(' ')}
      aria-labelledby={headingId}
    >
      <h2 className="panel-h" id={headingId}>
        {t('conflicts.title')}
      </h2>
      {conflicts.length === 0 ? (
        <p className="cf-empty">{t('conflicts.empty')}</p>
      ) : (
        <ul className="cf-list">
          {conflicts.map((c) => (
            <ConflictEntry key={c.id} {...props} conflict={c} />
          ))}
        </ul>
      )}
      {quarantined.length > 0 && (
        <>
          <h2 className="panel-h">{t('conflicts.quarantine')}</h2>
          <p className="cf-why">
            {t('conflicts.quarantineHelp')} {!canRelease && t('conflicts.ownerOnly')}
          </p>
          <ul className="cf-list">
            {quarantined.map((q) => (
              <QuarantineItem key={q.op} {...props} entry={q} />
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
