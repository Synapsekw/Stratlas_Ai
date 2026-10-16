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
  if (!hasProject) return <NoProject view="Issues" />;
  return (
    <FocusZone kind="issues" className="screen issues-screen" aria-label="Issues">
      <h1 className="sr-only">{t('nav.issues')}</h1>
      <div className="iss-main">
        {/* one header row: the register's title, count, save state, undo and redo, and Export */}
        <IssueRegister
          className="fill-col"
          title={t('issues.register')}
          titleLevel={2}
          actions={<ExportMenu />}
        />
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
