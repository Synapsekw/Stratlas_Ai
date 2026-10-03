import type { IssueStatus } from '@aio/schema';
import { Icon, SevChip } from '@aio/ui';
import { useWorkspace } from '@aio/workspace';
import { FocusZone } from '../FocusZone';
import { NoProject } from './NoProject';

const STATUSES: IssueStatus[] = ['draft', 'reviewed', 'approved', 'closed'];

export function ReportsScreen() {
  const project = useWorkspace((s) => s.project);
  const issues = useWorkspace((s) => s.issues);
  if (!project) return <NoProject view="Reports" />;
  const models = project.manifest.severityModels;

  return (
    <FocusZone kind="report" className="screen page" aria-label="Reports">
      <div className="page-in">
        <header className="page-h">
          <h1>Reports</h1>
          <p className="muted">
            What a report of {project.manifest.name} would contain today. Report drafting and PDF
            export are not in this build yet.
          </p>
        </header>
        <div className="rep-grid">
          <section className="sblock">
            <h2>Issues by status</h2>
            <div className="stat-row">
              {STATUSES.map((s) => (
                <div key={s} className="stat">
                  <span className="v mono">{issues.filter((i) => i.status === s).length}</span>
                  <span className="k">{`${(s[0] ?? '').toUpperCase()}${s.slice(1)}`}</span>
                </div>
              ))}
            </div>
          </section>
          {models.map((m) => {
            const graded = issues.filter((i) => i.severityModelId === m.id);
            const max = Math.max(
              1,
              ...m.levels.map((l) => graded.filter((i) => i.severity === l.value).length),
            );
            return (
              <section key={m.id} className="sblock">
                <h2>
                  {m.name} <span className="sub">{graded.length} graded</span>
                </h2>
                <div className="sev-dist">
                  {[...m.levels].reverse().map((l) => {
                    const n = graded.filter((i) => i.severity === l.value).length;
                    return (
                      <div key={l.value} className="sd-row">
                        <SevChip color={l.color}>
                          {l.value} {l.label}
                        </SevChip>
                        <span className="bar">
                          <i
                            style={{ width: `${String((n / max) * 100)}%`, background: l.color }}
                          />
                        </span>
                        <span className="mono">{n}</span>
                      </div>
                    );
                  })}
                </div>
              </section>
            );
          })}
          {models.length === 0 && (
            <div className="side-empty">
              <Icon name="report" size={20} />
              <p>This project has no severity model, so issues cannot be graded for a report.</p>
            </div>
          )}
        </div>
      </div>
    </FocusZone>
  );
}
