import { targetKey, type CollabTarget } from '@aio/schema';
import { useT } from '@aio/ui';
import { useWorkspace } from '@aio/workspace';
import { useEffect, useRef, useState } from 'react';
import { ApprovalBar, stillApproved } from './ApprovalBar';
import { AssignMenu } from './AssignMenu';
import { CommentThread } from './CommentThread';
import { collabStore, loadCollab, useCollab } from './store';
import { CollabStyles } from './styles';

/**
 * What the issue panel needs of the issue editor (`@aio/annotate`'s `issueEditor` fits): status
 * steps go through it, so they are saved, undoable and labelled like any other edit.
 */
export interface StatusEditor {
  setStatus(id: string, status: 'draft' | 'reviewed' | 'approved' | 'closed'): { ok: boolean };
  subscribe(listener: () => void): () => void;
  readonly state: { save: { state: string } };
}

/** Wait until the editor has written every pending change (approvals hash what is on disk). */
function saved(editor: StatusEditor): Promise<void> {
  if (editor.state.save.state === 'saved' || editor.state.save.state === 'error')
    return Promise.resolve();
  return new Promise((resolve) => {
    const off = editor.subscribe(() => {
      if (editor.state.save.state === 'saved' || editor.state.save.state === 'error') {
        off();
        resolve();
      }
    });
  });
}

/**
 * Assign, comments and approvals of one issue, in one tabbed area under the issue's edit form.
 * With a team policy, an approved issue whose approvals no longer count (a material edit, a
 * withdrawal) goes back to reviewed through the editor.
 */
export function IssueCollab({
  issueId,
  editor,
  readOnly,
}: {
  issueId: string;
  editor: StatusEditor;
  readOnly?: boolean;
}) {
  const t = useT();
  const c = useCollab();
  const issue = useWorkspace((s) => s.issues.find((i) => i.id === issueId));
  const [tab, setTab] = useState<'comments' | 'approvals'>('comments');
  const target: CollabTarget = { kind: 'issue', id: issueId };
  const key = targetKey(target);
  const comments = c.state.comments.filter((x) => targetKey(x.target) === key && !x.deleted).length;

  // read again once the editor has saved an edit of this issue (approvals hash the file)
  const stamp = issue?.updatedAt;
  useEffect(() => {
    if (!c.projectId || !stamp) return;
    let live = true;
    void saved(editor).then(() => {
      if (live && c.projectId) void loadCollab(c.projectId);
    });
    return () => {
      live = false;
    };
  }, [stamp, editor, c.projectId]);

  // an approval that stopped counting returns the issue to reviewed (decision 6), once
  const reconciled = useRef('');
  useEffect(() => {
    if (readOnly || !c.loaded || !c.state.policy || issue?.status !== 'approved') return;
    if (editor.state.save.state !== 'saved') return;
    const s = collabStore.getState();
    if (stillApproved(s, target)) return;
    const mark = `${issueId}:${issue.updatedAt}`;
    if (reconciled.current === mark) return;
    reconciled.current = mark;
    editor.setStatus(issueId, 'reviewed');
    // target is rebuilt each render; the store and the issue decide
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [c.state, c.loaded, issue?.status, issue?.updatedAt, issueId, readOnly, editor]);

  // nothing to show in a read-only package without review data (player mode stays as in 0.8)
  if (!c.projectId || (readOnly && c.state.comments.length + c.state.approvals.length === 0))
    return null;
  return (
    <section className="clb" data-testid="issue-collab" aria-label={t('collab.title')}>
      <CollabStyles />
      <AssignMenu target={target} {...(readOnly ? { readOnly } : {})} />
      <div className="clb-tabs" role="tablist" aria-label={t('collab.title')}>
        <button
          type="button"
          role="tab"
          className="clb-tab"
          aria-selected={tab === 'comments'}
          onClick={() => {
            setTab('comments');
          }}
        >
          {t('collab.tab.comments', { count: comments })}
        </button>
        <button
          type="button"
          role="tab"
          className="clb-tab"
          aria-selected={tab === 'approvals'}
          onClick={() => {
            setTab('approvals');
          }}
        >
          {t('collab.tab.approvals')}
        </button>
      </div>
      <div role="tabpanel">
        {tab === 'comments' ? (
          <CommentThread target={target} {...(readOnly ? { readOnly } : {})} />
        ) : c.state.policy ? (
          <ApprovalBar
            target={target}
            {...(readOnly ? { readOnly } : {})}
            beforeWrite={() => saved(editor)}
            onApproved={() => {
              void saved(editor).then(() => editor.setStatus(issueId, 'approved'));
            }}
          />
        ) : (
          <p className="clb-faint">{t('collab.approve.notShared')}</p>
        )}
      </div>
    </section>
  );
}
