import { useT } from '@aio/ui';
import { useWorkspace } from '@aio/workspace';
import { signOffBlock, type SignOffPerson } from '../signoff';
import { ApprovalBar } from './ApprovalBar';
import { personOf, useCollab } from './store';
import { CollabStyles } from './styles';

function names(list: readonly SignOffPerson[]): string {
  return list.map((p) => `${p.name} (${p.initials}) ${p.date}`).join(', ');
}

/**
 * Report sign-off on the Reports screen: who prepared, reviewed and approved, and the approval of
 * the report itself, bound to the content of the report's inputs (every finding).
 */
export function SignOff({ readOnly }: { readOnly?: boolean }) {
  const t = useT();
  const c = useCollab();
  const issues = useWorkspace((s) => s.issues);
  if (!c.projectId || !c.state.policy) return null;
  const b = signOffBlock(c.state, {
    projectId: c.projectId,
    issueIds: issues.map((i) => i.id),
    who: (a) => personOf(c, a),
    prepared: c.me ? { actor: c.me.actor, date: new Date().toISOString().slice(0, 10) } : null,
  });
  const none = t('collab.sign.none');
  return (
    <section className="sblock clb-sign" data-testid="report-signoff">
      <CollabStyles />
      <h2>{t('collab.sign.title')}</h2>
      <table>
        <tbody>
          <tr>
            <th>{t('collab.sign.prepared')}</th>
            <td>{b.prepared ? names([b.prepared]) : none}</td>
          </tr>
          <tr>
            <th>{t('collab.sign.reviewed')}</th>
            <td>
              {b.reviewed.length ? names(b.reviewed) : none}{' '}
              <span className="clb-faint">
                {t('collab.sign.findings', {
                  approved: b.findings.approved,
                  total: b.findings.total,
                })}
              </span>
            </td>
          </tr>
          <tr>
            <th>{t('collab.sign.approved')}</th>
            <td>{b.approved.length ? names(b.approved) : none}</td>
          </tr>
          {b.accepted.length > 0 && (
            <tr>
              <th>{t('collab.sign.accepted')}</th>
              <td>{names(b.accepted)}</td>
            </tr>
          )}
        </tbody>
      </table>
      <ApprovalBar
        target={{ kind: 'report', id: c.projectId }}
        signLabel={t('collab.sign.report')}
        {...(readOnly ? { readOnly } : {})}
      />
    </section>
  );
}
