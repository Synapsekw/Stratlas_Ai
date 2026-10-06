import { IssueRegister } from '@aio/annotate';
import { Icon, useT } from '@aio/ui';
import { useWorkspace } from '@aio/workspace';
import { ExportMenu } from '../exports/ExportMenu';
import { FocusZone } from '../FocusZone';
import { IssueCard } from '../issueCard/IssueCard';
import { NoProject } from './NoProject';

export function IssuesScreen() {
  const t = useT();
  const hasProject = useWorkspace((s) => s.project !== null);
  const issueId = useWorkspace((s) => (s.selection?.kind === 'issue' ? s.selection.id : null));
  const count = useWorkspace((s) => s.issues.length);
  if (!hasProject) return <NoProject view="Issues" />;
  return (
    <FocusZone kind="issues" className="screen issues-screen" aria-label="Issues">
      <h1 className="sr-only">{t('nav.issues')}</h1>
      <div className="iss-main">
        <div className="panel-h">
          <h2>
            <Icon name="issues" size={14} />
            Issue register
          </h2>
          <span className="sub mono">{count}</span>
          <span className="grow" />
          <ExportMenu />
        </div>
        <IssueRegister className="fill-col" />
      </div>
      <aside className="iss-side" aria-label={t('card.title')}>
        {issueId ? (
          <IssueCard issueId={issueId} place="issues" className="fill-col" />
        ) : (
          <div className="side-empty">
            <Icon name="issues" size={20} />
            <p>{t('card.empty')}</p>
          </div>
        )}
      </aside>
    </FocusZone>
  );
}
