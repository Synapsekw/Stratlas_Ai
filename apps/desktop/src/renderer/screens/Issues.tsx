import { IssueDetail, IssueRegister } from '@aio/annotate';
import { Icon } from '@aio/ui';
import { useWorkspace } from '@aio/workspace';
import { FocusZone } from '../FocusZone';
import { NoProject } from './NoProject';

export function IssuesScreen() {
  const hasProject = useWorkspace((s) => s.project !== null);
  const issueId = useWorkspace((s) => (s.selection?.kind === 'issue' ? s.selection.id : null));
  const count = useWorkspace((s) => s.issues.length);
  if (!hasProject) return <NoProject view="Issues" />;
  return (
    <FocusZone kind="issues" className="screen issues-screen" aria-label="Issues">
      <div className="iss-main">
        <div className="panel-h">
          <h3>
            <Icon name="issues" size={14} />
            Issue register
          </h3>
          <span className="sub mono">{count}</span>
        </div>
        <IssueRegister className="fill-col" />
      </div>
      <aside className="iss-side" aria-label="Issue detail">
        {issueId ? (
          <IssueDetail issueId={issueId} className="fill-col" />
        ) : (
          <div className="side-empty">
            <Icon name="issues" size={20} />
            <p>Select an issue to see its sightings, severity and notes.</p>
          </div>
        )}
      </aside>
    </FocusZone>
  );
}
