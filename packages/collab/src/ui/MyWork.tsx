import { targetKey, type CollabTarget } from '@aio/schema';
import { useT } from '@aio/ui';
import { useWorkspace, workspace } from '@aio/workspace';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { mineKeys, myWork, type WorkItem } from '../work';
import { dueOf } from './AssignMenu';
import { Initials, whenOf } from './CommentThread';
import { collabStore, personOf, useCollab, useCollabStore } from './store';
import { CollabStyles } from './styles';
import { flyToView } from './view';

/** "F03", "change issue:F03", "the report". */
function useLabel() {
  const t = useT();
  const issues = useWorkspace((s) => s.issues);
  return (target: CollabTarget) =>
    target.kind === 'issue'
      ? (issues.find((i) => i.id === target.id)?.code ?? target.id)
      : t('collab.work.target', { kind: target.kind, id: target.id });
}

/** Open what a My work line is about: the issue, and the comment's saved view. */
export function openWork(item: WorkItem): void {
  if (item.target.kind === 'issue')
    workspace.getState().select({ kind: 'issue', id: item.target.id });
  if (item.kind === 'mention' && item.comment.view) flyToView(item.comment.view);
}

/** My work: assigned to me, mentions, awaiting my approval. In app only. */
export function MyWork({ onOpen }: { onOpen?: () => void }) {
  const t = useT();
  const c = useCollab();
  const label = useLabel();
  const issues = useWorkspace((s) => s.issues);
  const work = useMemo(
    () =>
      c.me
        ? myWork(c.state, c.me.actor, {
            statusOf: (tg) =>
              tg.kind === 'issue' ? issues.find((i) => i.id === tg.id)?.status : undefined,
          })
        : null,
    [c.state, c.me, issues],
  );
  if (!work)
    return (
      <div className="clb-work" data-testid="my-work">
        <CollabStyles />
        <p className="clb-faint">{t('collab.work.noIdentity')}</p>
      </div>
    );
  const open = (i: WorkItem) => {
    openWork(i);
    onOpen?.();
  };
  const section = (title: string, items: WorkItem[], line: (i: WorkItem) => ReactNode) => (
    <section>
      <h4>
        {title} ({items.length})
      </h4>
      {items.length === 0 ? (
        <p className="clb-faint">{t('collab.work.empty')}</p>
      ) : (
        <ul>
          {items.map((i, n) => (
            <li key={`${targetKey(i.target)}-${String(n)}`}>
              <button
                type="button"
                onClick={() => {
                  open(i);
                }}
              >
                {line(i)}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
  return (
    <div
      className="clb-work"
      data-testid="my-work"
      role="dialog"
      aria-label={t('collab.work.title')}
    >
      <CollabStyles />
      {section(t('collab.work.assigned'), work.assigned, (i) => (
        <>
          <b>{label(i.target)}</b>
          {i.kind === 'assigned' && i.assignment.due && (
            <span className="clb-faint">
              {t('collab.assign.due', { date: dueOf(i.assignment.due) })}
            </span>
          )}
        </>
      ))}
      {section(t('collab.work.mentions'), work.mentions, (i) =>
        i.kind === 'mention' ? (
          <>
            <Initials person={personOf(c, i.comment.author)} />
            <b>{label(i.target)}</b>
            <span className="clb-faint" dir="auto">
              {(i.comment.text ?? '').slice(0, 60)}
            </span>
            <span className="clb-faint">{whenOf(i.comment.createdAt)}</span>
          </>
        ) : null,
      )}
      {section(t('collab.work.awaiting'), work.awaiting, (i) => (
        <b>{label(i.target)}</b>
      ))}
    </div>
  );
}

/** Issue ids the Mine filter keeps, or null when it is off. */
export function useMineIssueIds(): ReadonlySet<string> | null {
  const on = useCollabStore((s) => s.mine);
  const state = useCollabStore((s) => s.state);
  const me = useCollabStore((s) => s.me?.actor);
  return useMemo(() => {
    if (!on || !me) return null;
    const keys = mineKeys(state, me);
    return new Set(
      [...keys].filter((k) => k.startsWith('issue::')).map((k) => k.slice('issue::'.length)),
    );
  }, [on, me, state]);
}

/** The Mine filter and the My work list, for the Issues filter row. */
export function MineFilter() {
  const t = useT();
  const c = useCollab();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);
  if (!c.me) return null;
  const count = (() => {
    const w = myWork(c.state, c.me.actor);
    return w.assigned.length + w.mentions.length;
  })();
  return (
    <div className="clb-pop" ref={ref}>
      <CollabStyles />
      <button
        type="button"
        className={`clb-btn${c.mine ? ' on' : ''}`}
        aria-pressed={c.mine}
        data-testid="mine-filter"
        title={t('collab.mine.tip')}
        onClick={() => {
          collabStore.setState({ mine: !c.mine });
        }}
      >
        {t('collab.mine')}
      </button>
      <button
        type="button"
        className="clb-btn ghost"
        aria-expanded={open}
        data-testid="my-work-button"
        onClick={() => {
          setOpen(!open);
        }}
      >
        {t('collab.work.button', { count })}
      </button>
      {open && (
        <MyWork
          onOpen={() => {
            setOpen(false);
          }}
        />
      )}
    </div>
  );
}
