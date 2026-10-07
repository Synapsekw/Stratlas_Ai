import {
  targetKey,
  type ApprovalDecision,
  type ApprovalView,
  type CollabState,
  type CollabTarget,
} from '@aio/schema';
import { useT } from '@aio/ui';
import { useState } from 'react';
import { Initials, whenOf } from './CommentThread';
import { collabWrite, personOf, useCollab, type CollabStoreState } from './store';
import { CollabStyles } from './styles';

/** Statuses the bar may set through the issue editor. */
export type BarStatus = 'reviewed' | 'approved';

/**
 * Does the target still have enough current approvals from owners or reviewers? Main enforced
 * four-eyes when each approval was written; here only "still counts" matters (content, withdrawal).
 */
export function stillApproved(
  s: Pick<CollabStoreState, 'members'> & { state: CollabState },
  target: CollabTarget,
): boolean {
  const required = s.state.policy?.approval.required ?? 1;
  const eligible = new Set(
    s.members.filter((m) => m.role === 'owner' || m.role === 'reviewer').map((m) => m.actor),
  );
  const by = new Set(
    s.state.approvals
      .filter(
        (a) =>
          targetKey(a.target) === targetKey(target) &&
          a.decision === 'approve' &&
          !a.withdrawn &&
          a.current &&
          (eligible.size === 0 || eligible.has(a.by)),
      )
      .map((a) => a.by),
  );
  return by.size >= required;
}

function decisionKey(a: ApprovalView) {
  return a.decision === 'approve'
    ? 'collab.approve.approved'
    : a.decision === 'accept'
      ? 'collab.approve.accepted'
      : 'collab.approve.changes';
}

/**
 * Approve, Request changes (a comment is required), Withdraw, and the client's Accept. Main
 * checks roles, four-eyes and the content hash; the bar shows main's answer as it is.
 * `onApproved` runs when this approval completed the policy (the issue editor then writes the
 * status, so history reads "F05 to approved").
 */
export function ApprovalBar({
  target,
  readOnly,
  signLabel,
  onApproved,
  beforeWrite,
}: {
  target: CollabTarget;
  readOnly?: boolean;
  /** For batch sign-offs ("Sign off change register"); default "Approve". */
  signLabel?: string;
  onApproved?: () => void;
  /** Runs before main is asked (the issue editor saves first: approvals hash the file). */
  beforeWrite?: () => Promise<void>;
}) {
  const t = useT();
  const c = useCollab();
  const [asking, setAsking] = useState(false);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const policy = c.state.policy;
  if (!policy) return null;
  const key = targetKey(target);
  const mine = c.me?.actor;
  const list = c.state.approvals.filter((a) => targetKey(a.target) === key && !a.withdrawn);
  const done = stillApproved(c, target);
  const stale = list.some((a) => a.decision === 'approve' && !a.current);
  const role = c.me?.role;
  const canApprove = !readOnly && (role === undefined || role === 'owner' || role === 'reviewer');
  const canAccept = !readOnly && role === 'client' && policy.approval.clientAcceptance === 'record';

  const send = async (decision: ApprovalDecision, comment?: string) => {
    if (!c.projectId) return;
    setBusy(true);
    setMsg(null);
    await beforeWrite?.();
    const r = await collabWrite('collab:approve', {
      projectId: c.projectId,
      target,
      decision,
      ...(comment ? { comment } : {}),
    });
    setBusy(false);
    if (!r.ok) {
      setMsg({ ok: false, text: r.error });
      return;
    }
    setAsking(false);
    setNote('');
    if ('approved' in r && r.approved) onApproved?.();
    setMsg({
      ok: true,
      text:
        decision === 'approve'
          ? 'approved' in r && r.approved
            ? t('collab.approve.complete')
            : t('collab.approve.recorded')
          : decision === 'accept'
            ? t('collab.approve.acceptRecorded')
            : t('collab.approve.changesSent'),
    });
  };

  return (
    <div className="clb clb-appr" data-testid="approval-bar">
      <CollabStyles />
      <div className="clb-row">
        <span className="clb-faint">
          {t('collab.approve.needs', { count: policy.approval.required })}
          {policy.approval.fourEyes ? ` · ${t('collab.approve.fourEyes')}` : ''}
        </span>
        {done ? (
          <span className="clb-tag good" data-testid="approval-state">
            {t('collab.approve.done')}
          </span>
        ) : stale ? (
          <span className="clb-tag warn" data-testid="approval-state">
            {t('collab.approve.outOfDate')}
          </span>
        ) : null}
      </div>
      {list.length > 0 && (
        <ul className="clb-list">
          {list.map((a) => (
            <li key={a.id} className="clb-c" data-testid="approval">
              <Initials person={personOf(c, a.by)} />
              <div className="h">
                <b>{personOf(c, a.by).name}</b>
                <span>{t(decisionKey(a))}</span>
                <span className="clb-faint">{whenOf(a.at)}</span>
                {!a.current && a.decision !== 'changes-requested' && (
                  <span className="clb-tag warn">{t('collab.approve.stale')}</span>
                )}
                {a.by === mine && !readOnly && (
                  <button
                    type="button"
                    className="clb-link"
                    onClick={() =>
                      void collabWrite('collab:withdraw', {
                        projectId: c.projectId ?? '',
                        id: a.id,
                      }).then((r) => {
                        if (!r.ok) setMsg({ ok: false, text: r.error });
                      })
                    }
                  >
                    {t('collab.approve.withdraw')}
                  </button>
                )}
              </div>
              {a.comment && (
                <div className="t">
                  <p dir="auto">{a.comment}</p>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {canApprove && (
        <div className="clb-row">
          <button
            type="button"
            className="clb-btn primary"
            disabled={busy}
            data-testid="approve"
            onClick={() => void send('approve')}
          >
            {signLabel ?? t('collab.approve.button')}
          </button>
          <button
            type="button"
            className="clb-btn"
            disabled={busy}
            aria-expanded={asking}
            onClick={() => {
              setAsking(!asking);
            }}
          >
            {t('collab.approve.request')}
          </button>
        </div>
      )}
      {canAccept && (
        <div className="clb-row">
          <button
            type="button"
            className="clb-btn primary"
            disabled={busy}
            onClick={() => void send('accept')}
          >
            {t('collab.approve.accept')}
          </button>
        </div>
      )}
      {asking && (
        <div className="clb">
          <textarea
            className="clb-input"
            dir="auto"
            aria-label={t('collab.approve.whatToChange')}
            placeholder={t('collab.approve.whatToChange')}
            value={note}
            onChange={(e) => {
              setNote(e.target.value);
            }}
          />
          <div className="clb-row">
            <button
              type="button"
              className="clb-btn primary"
              disabled={busy || !note.trim()}
              onClick={() => void send('changes-requested', note.trim())}
            >
              {t('collab.approve.sendRequest')}
            </button>
            <button
              type="button"
              className="clb-btn ghost"
              onClick={() => {
                setAsking(false);
              }}
            >
              {t('collab.cancel')}
            </button>
          </div>
        </div>
      )}
      {msg && (
        <div
          className={msg.ok ? 'clb-ok' : 'clb-err'}
          role={msg.ok ? 'status' : 'alert'}
          data-testid="approval-message"
        >
          {msg.text}
        </div>
      )}
    </div>
  );
}
