import { targetKey, type CollabTarget } from '@aio/schema';
import { useT } from '@aio/ui';
import { useState } from 'react';
import { ApprovalBar } from './ApprovalBar';
import { AssignMenu } from './AssignMenu';
import { CommentThread } from './CommentThread';
import { useCollab } from './store';
import { CollabStyles } from './styles';

/**
 * Discussion and sign-off of one change item in the Changes panel: assign the item, comment on it,
 * and sign off the whole change register (the item's change set) once it is reviewed.
 */
export function ChangeCollab({
  setId,
  itemId,
  readOnly,
}: {
  setId: string;
  itemId: string;
  readOnly?: boolean;
}) {
  const t = useT();
  const c = useCollab();
  const [tab, setTab] = useState<'discuss' | 'signoff'>('discuss');
  if (!c.projectId) return null;
  const item: CollabTarget = { kind: 'change-item', id: itemId, in: setId };
  const set: CollabTarget = { kind: 'change-set', id: setId };
  const count = c.state.comments.filter(
    (x) => targetKey(x.target) === targetKey(item) && !x.deleted,
  ).length;
  const ro = readOnly ? { readOnly } : {};
  return (
    <section className="clb" data-testid="change-collab" aria-label={t('collab.title')}>
      <CollabStyles />
      <div className="clb-tabs" role="tablist" aria-label={t('collab.title')}>
        <button
          type="button"
          role="tab"
          className="clb-tab"
          aria-selected={tab === 'discuss'}
          onClick={() => {
            setTab('discuss');
          }}
        >
          {t('collab.tab.comments', { count })}
        </button>
        <button
          type="button"
          role="tab"
          className="clb-tab"
          aria-selected={tab === 'signoff'}
          onClick={() => {
            setTab('signoff');
          }}
        >
          {t('collab.tab.signOff')}
        </button>
      </div>
      <div role="tabpanel">
        {tab === 'discuss' ? (
          <div className="clb">
            <AssignMenu target={item} {...ro} />
            <CommentThread target={item} {...ro} />
          </div>
        ) : c.state.policy ? (
          <ApprovalBar target={set} signLabel={t('collab.sign.changeRegister')} {...ro} />
        ) : (
          <p className="clb-faint">{t('collab.approve.notShared')}</p>
        )}
      </div>
    </section>
  );
}
