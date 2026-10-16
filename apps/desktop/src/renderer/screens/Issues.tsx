import { IssueRegister } from '@aio/annotate';
import { Icon, ResizableSplit, useT } from '@aio/ui';
import { useWorkspace } from '@aio/workspace';
import { ExportMenu } from '../exports/ExportMenu';
import { FocusZone } from '../FocusZone';
import { IssueCard } from '../issueCard/IssueCard';
import { NoProject } from './NoProject';

/** The issue list and the card of the picked issue, on the `issues.card` split (420 px card). */
export function IssuesScreen() {
  const t = useT();
  const hasProject = useWorkspace((s) => s.project !== null);
  const issueId = useWorkspace((s) => (s.selection?.kind === 'issue' ? s.selection.id : null));
  if (!hasProject) return <NoProject view="Issues" />;
  return (
    <FocusZone kind="issues" className="screen issues-screen" aria-label="Issues">
      <h1 className="sr-only">{t('nav.issues')}</h1>
      <ResizableSplit
        id="issues.card"
        className="iss-split"
        orientation="horizontal"
        sized="end"
        unit="px"
        defaultSize={420}
        min={320}
        max="60%"
        otherMin={280}
        minShare={0.55}
        label={t('split.issues')}
        start={
          <div className="iss-main">
            {/* one header row: the register's title, count, save state, undo and redo, and Export */}
            <IssueRegister
              className="fill-col"
              title={t('issues.register')}
              titleLevel={2}
              actions={<ExportMenu />}
            />
          </div>
        }
        end={
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
        }
      />
    </FocusZone>
  );
}
