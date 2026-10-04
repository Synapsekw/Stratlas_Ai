import { defaultIssuePages, houseKind } from '@aio/project/export';
import {
  REPORT_SECTIONS,
  reportSectionOn,
  type IssuePagesRule,
  type IssueStatus,
  type ReportContentsSettings,
  type ReportFile,
  type ReportSectionId,
} from '@aio/schema';
import { formatBytes, Icon, SevChip, t } from '@aio/ui';
import { assetUrl, useWorkspace } from '@aio/workspace';
import { useState } from 'react';
import { FocusZone } from '../FocusZone';
import { actionAllowed } from '../exports/exportModel';
import { runExportAction } from '../exports/exports';
import { NarrativeEditor } from '../report/NarrativeEditor';
import { PdfViewer } from '../report/PdfViewer';
import { ExtractPackage } from '../shell/ExtractPackage';
import { shell, useCall, useShell } from '../shell';
import { NoProject } from './NoProject';
import { useRoad } from '../road/store';

const STATUSES: IssueStatus[] = ['draft', 'reviewed', 'approved', 'closed'];

type Key = Parameters<typeof t>[0];
const tk = (key: string) => t(key as Key);

const PAGE_RULES: { id: IssuePagesRule; label: string }[] = [
  { id: 'all', label: 'reports.house.pages.all' },
  { id: 'above-lowest', label: 'reports.house.pages.above' },
  { id: 'none', label: 'reports.house.pages.none' },
];

function saveContents(next: ReportContentsSettings) {
  void shell.getState().updateSettings({ reportContents: next });
}

/** The house report: which sections it prints, which issues get a page, and the export. */
function ProjectReport(props: {
  allowed: boolean;
  /** The issue page rule when none is chosen (it follows the project kind). */
  defaultPages: IssuePagesRule;
  onText: () => void;
}) {
  const contents = useShell((s) => s.settings.reportContents);
  const toggle = (id: ReportSectionId) => {
    const sections = { ...contents?.sections, [id]: !reportSectionOn(contents, id) };
    saveContents({ ...contents, sections });
  };
  return (
    <section className="sblock" data-testid="house-report">
      <h2>{t('reports.house.title')}</h2>
      <p className="muted rep-note">{t('reports.house.text')}</p>
      <p className="faint small rep-note">{t('reports.brandingHint')}</p>
      <fieldset className="rep-sections">
        <legend className="caps">{t('reports.house.sections')}</legend>
        {REPORT_SECTIONS.map((id) => (
          <label key={id} className="rep-check">
            <input
              type="checkbox"
              checked={reportSectionOn(contents, id)}
              onChange={() => {
                toggle(id);
              }}
            />
            {id === 'contents' ? t('house.contents') : tk(`house.sec.${id}`)}
          </label>
        ))}
      </fieldset>
      <label className="rep-pages">
        <span className="caps">{t('reports.house.issuePages')}</span>
        <select
          className="input"
          value={contents?.issuePages ?? props.defaultPages}
          onChange={(e) => {
            saveContents({ ...contents, issuePages: e.target.value as IssuePagesRule });
          }}
        >
          {PAGE_RULES.map((r) => (
            <option key={r.id} value={r.id}>
              {tk(r.label)}
            </option>
          ))}
        </select>
      </label>
      <div className="rep-acts">
        <button type="button" className="btn" onClick={props.onText}>
          <Icon name="anno" size={14} />
          {t('reports.text.open')}
        </button>
        {props.allowed ? (
          <button
            type="button"
            className="btn primary"
            onClick={() => {
              runExportAction('house-pdf');
            }}
          >
            <Icon name="download" size={14} />
            {t('reports.house.export')}
          </button>
        ) : (
          <p className="faint small">This package does not allow PDF exports.</p>
        )}
      </div>
    </section>
  );
}

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
  const roadOpen = useRoad((s) => s.status === 'ready' || s.status === 'setup');
  const listed = useCall('report:list', { projectId: project?.id ?? '' }, project?.id ?? null);
  const [picked, setPicked] = useState<Record<string, string>>({});
  const [textOpen, setTextOpen] = useState(false);
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
          <ProjectReport
            allowed={actionAllowed('house-pdf', pkg)}
            defaultPages={defaultIssuePages(
              houseKind(project.manifest, issues, roadOpen ? { road: true } : {}),
            )}
            onText={() => {
              setTextOpen(true);
            }}
          />
          <section className="sblock">
            <h2>
              Issue register <span className="sub">{issues.length} issues</span>
            </h2>
            <p className="muted rep-note">
              A PDF report: cover, charts by severity, class and zone, the register, and one page
              per issue with its best photo and a 3D view.
            </p>
            <p className="faint small rep-note">{t('reports.brandingHint')}</p>
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
          {pkg && (
            <section className="sblock">
              <h2>{t('package.extract.title')}</h2>
              <p className="muted rep-note">{t('package.extract.text')}</p>
              <ExtractPackage projectId={project.id} pkg={pkg} />
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
        {textOpen ? (
          <NarrativeEditor
            key={project.id}
            onClose={() => {
              setTextOpen(false);
            }}
          />
        ) : file ? (
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
