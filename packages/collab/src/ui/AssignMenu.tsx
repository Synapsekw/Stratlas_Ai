import { targetKey, type CollabTarget } from '@aio/schema';
import { useT } from '@aio/ui';
import { useState } from 'react';
import { Initials } from './CommentThread';
import { collabWrite, personOf, useCollab } from './store';
import { CollabStyles } from './styles';

/** `Fri 9 Oct` from `2026-10-09`. */
export function dueOf(date: string): string {
  const d = new Date(`${date}T12:00:00Z`);
  return Number.isNaN(d.getTime())
    ? date
    : d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
}

/** Who a target is assigned to, with a due date, and the form to change it. */
export function AssignMenu({ target, readOnly }: { target: CollabTarget; readOnly?: boolean }) {
  const t = useT();
  const c = useCollab();
  const [open, setOpen] = useState(false);
  const [who, setWho] = useState('');
  const [due, setDue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const current = c.state.assignments.find((a) => targetKey(a.target) === targetKey(target));
  // one person alone (not shared) can only assign themself
  const people = c.state.policy
    ? c.members.filter((m) => m.role === 'owner' || m.role === 'reviewer')
    : c.me
      ? [c.me]
      : [];

  const save = async (assignee: string | null) => {
    if (!c.projectId) return;
    setError(null);
    const r = await collabWrite('collab:assign', {
      projectId: c.projectId,
      target,
      assignee,
      ...(assignee && due ? { due } : {}),
    });
    if (!r.ok) setError(r.error);
    else setOpen(false);
  };

  return (
    <div className="clb" data-testid="assign-menu">
      <CollabStyles />
      <div className="clb-row">
        {current ? (
          <>
            <Initials person={personOf(c, current.assignee)} />
            <span data-testid="assignee">
              {t('collab.assign.to', { name: personOf(c, current.assignee).name })}
            </span>
            {current.due && (
              <span className="clb-tag">
                {t('collab.assign.due', { date: dueOf(current.due) })}
              </span>
            )}
          </>
        ) : (
          <span className="clb-faint">{t('collab.assign.nobody')}</span>
        )}
        <span style={{ flex: 1 }} />
        {!readOnly && people.length > 0 && (
          <button
            type="button"
            className="clb-btn"
            aria-expanded={open}
            onClick={() => {
              setWho(current?.assignee ?? people[0]?.actor ?? '');
              setDue(current?.due ?? '');
              setOpen(!open);
            }}
          >
            {t('collab.assign.button')}
          </button>
        )}
      </div>
      {open && (
        <div className="clb-row" role="group" aria-label={t('collab.assign.button')}>
          <select
            className="clb-input"
            aria-label={t('collab.assign.person')}
            value={who}
            onChange={(e) => {
              setWho(e.target.value);
            }}
          >
            {people.map((p) => (
              <option key={p.actor} value={p.actor}>
                {p.name} ({p.initials})
              </option>
            ))}
          </select>
          <input
            className="clb-input"
            type="date"
            aria-label={t('collab.assign.dueLabel')}
            value={due}
            onChange={(e) => {
              setDue(e.target.value);
            }}
          />
          <button
            type="button"
            className="clb-btn primary"
            disabled={!who}
            onClick={() => void save(who)}
          >
            {t('collab.assign.save')}
          </button>
          {current && (
            <button type="button" className="clb-btn ghost" onClick={() => void save(null)}>
              {t('collab.assign.clear')}
            </button>
          )}
        </div>
      )}
      {error && (
        <div className="clb-err" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}
