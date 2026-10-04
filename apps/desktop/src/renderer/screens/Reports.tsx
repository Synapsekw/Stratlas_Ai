import type { IssueStatus, ReportFile } from '@aio/schema';
import { formatBytes, Icon, SevChip } from '@aio/ui';
import { assetUrl, useWorkspace } from '@aio/workspace';
import { useState } from 'react';
import { FocusZone } from '../FocusZone';
import { actionAllowed } from '../exports/exportModel';
import { runExportAction } from '../exports/exports';
import { PdfViewer } from '../report/PdfViewer';
import { shell, useCall, useShell } from '../shell';
import { NoProject } from './NoProject';

const STATUSES: IssueStatus[] = ['draft', 'reviewed', 'approved', 'closed'];

function ReportList(props: {
  files: ReportFile[] | null;
  selected: string | null;
  onSelect: (path: string) => void;
}) {
  if (props.files === null) return <p className="muted rep-note">Looking for reports...</p>;
  if (props.files.length === 0)
    return <p className="muted rep-note">No PDF report was delivered with this project.</p>;
  return (
    <ul className="rep-files" aria-label="Delivered reports">
      {props.files.map((f) => (
        <li key={f.path}>
          <button
            type="button"
            className={`rep-file${props.selected === f.path ? ' on' : ''}`}
            aria-current={props.selected === f.path ? 'true' : undefined}
            onClick={() => {
              props.onSelect(f.path);
            }}
          >
            <Icon name="report" size={16} />
            <span className="rep-file-name">{f.name.replace(/\.pdf$/i, '')}</span>
            <span className="mono muted">{formatBytes(f.sizeBytes)}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

export function ReportsScreen() {
  const project = useWorkspace((s) => s.project);
  const issues = useWorkspace((s) => s.issues);
  const pkg = useShell((s) => s.pkg);
  const listed = useCall('report:list', { projectId: project?.id ?? '' }, project?.id ?? null);
  const [picked, setPicked] = useState<Record<string, string>>({});
  if (!project) return <NoProject view="Reports" />;
  const files = listed === null ? null : listed.ok ? listed.value.files : [];
  const selected = picked[project.id] ?? files?.[0]?.path ?? null;
  const file = files?.find((f) => f.path === selected) ?? null;
  const models = project.manifest.severityModels;

  return (
    <FocusZone kind="report" className="screen reports" aria-label="Reports">
      <aside className="rep-side">
        <div className="panel-h">
          <h3>
            <Icon name="report" size={14} />
            Reports
          </h3>
          <span className="sub">{project.manifest.name}</span>
        </div>
        <div className="rep-side-in">
          <section className="sblock">
            <h2>Delivered</h2>
            <ReportList
              files={files}
              selected={selected}
              onSelect={(path) => {
                setPicked({ ...picked, [project.id]: path });
              }}
            />
          </section>
          <section className="sblock">
            <h2>
              Issue register <span className="sub">{issues.length} issues</span>
            </h2>
            <p className="muted rep-note">
              A branded PDF: cover, charts by severity, class and zone, the register, and one page
              per issue with its best photo and a 3D view.
            </p>
            {actionAllowed('report-pdf', pkg) ? (
              <button
                type="button"
                className="btn primary"
                disabled={issues.length === 0}
                onClick={() => {
                  runExportAction('report-pdf');
                }}
              >
                <Icon name="download" size={14} />
                Export issue register PDF
              </button>
            ) : (
              <p className="faint small">This package does not allow PDF exports.</p>
            )}
          </section>
          {!pkg && (
            <section className="sblock">
              <h2>Customer package</h2>
              <p className="muted rep-note">
                One .aio file for a customer: chosen layers, read-only player, optional passphrase.
              </p>
              <button
                type="button"
                className="btn"
                onClick={() => {
                  shell.getState().setExportFor(project.id);
                }}
                data-testid="export-package"
              >
                <Icon name="download" size={14} />
                Export package
              </button>
            </section>
          )}
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
        </div>
      </aside>
      <section className="rep-view" aria-label="Report viewer">
        {file ? (
          <PdfViewer
            key={file.path}
            url={assetUrl(project.id, { path: file.path })}
            title={file.name}
          />
        ) : (
          <div className="side-empty">
            <Icon name="report" size={20} />
            <p>
              {files?.length === 0
                ? 'Export the issue register to make a PDF report of this project.'
                : 'Pick a report to read it here.'}
            </p>
          </div>
        )}
      </section>
    </FocusZone>
  );
}
