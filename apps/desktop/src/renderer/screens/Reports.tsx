import { SignOff } from '@aio/collab/ui';
import { defaultIssuePages, houseKind } from '@aio/project/export';
import {
  defaultSurveySettings,
  reportSectionOn,
  type IssuePagesRule,
  type IssueStatus,
  type ReportContentsSettings,
  type ReportFile,
  type ReportSectionId,
} from '@aio/schema';
import { Button, formatBytes, Icon, SevChip, t } from '@aio/ui';
import { assetUrl, useWorkspace } from '@aio/workspace';
import { useState } from 'react';
import { FocusZone } from '../FocusZone';
import { actionAllowed, exportUnavailable } from '../exports/exportModel';
import { runExportAction } from '../exports/exports';
import { AuditScreen } from '../audit/AuditScreen';
import { closeAuditTrail, openAuditTrail, useAuditOpen } from '../audit/auditView';
import { NarrativeEditor } from '../report/NarrativeEditor';
import { PdfViewer } from '../report/PdfViewer';
import { TemplateNote } from '../report/TemplateNote';
import { ExtractPackage } from '../shell/ExtractPackage';
import { shell, useCall, useShell } from '../shell';
import { NoProject } from './NoProject';
import { offeredSections, sectionsWithData } from './reportSections';
import { useRoad } from '../road/store';
import { PageHeader } from '../shell/PageHeader';

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
  /** The sections this project has something to print in, in report order. */
  sections: readonly ReportSectionId[];
  /** The project has no datasets and no issues yet: there is nothing to report. */
  empty: boolean;
  /** The issue page rule when none is chosen (it follows the project kind). */
  defaultPages: IssuePagesRule;
  onText: () => void;
}) {
  const contents = useShell((s) => s.settings.reportContents);
  const pkg = useShell((s) => s.pkg);
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
        {props.sections.map((id) => (
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
      <TemplateNote readOnly={Boolean(pkg)} />
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
          // nothing to put in it yet: greyed, with the reason in its tooltip
          <Button
            variant="primary"
            size="md"
            icon="download"
            {...(props.empty ? { disabledReason: t('reports.house.noData') } : {})}
            onClick={() => {
              runExportAction('house-pdf');
            }}
          >
            {t('reports.house.export')}
          </Button>
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

/**
 * The survey and run sections the open project has data for (null while they are read), so the
 * Reports screen offers no landfill, haul-road or hydrology section to a project without any.
 */
function useSectionsWithData(projectId: string | null): ReportSectionId[] | null {
  const req = { projectId: projectId ?? '' };
  const measurements = useCall('survey:readMeasurements', req, projectId);
  const settings = useCall('survey:readSettings', req, projectId);
  const templates = useCall('survey:readTemplates', req, projectId);
  const haul = useCall('survey:readHaulRuns', req, projectId);
  const hydro = useCall('survey:readHydroRuns', req, projectId);
  if (!measurements || !settings || !templates || !haul || !hydro) return null;
  const ok = <T,>(r: { ok: true; value: T } | { ok: false }) => (r.ok ? r.value : null);
  const m = ok(measurements);
  const s = ok(settings);
  const tpl = ok(templates);
  const h = ok(haul);
  const y = ok(hydro);
  return sectionsWithData({
    measurements: m?.ok ? m.file.measurements : [],
    settings: s?.ok ? s.settings : defaultSurveySettings(),
    templates: tpl?.ok ? tpl.project : null,
    haulRuns: h?.ok ? h.runs.length : 0,
    hydroRuns: y?.ok ? y.runs.length : 0,
  });
}

export function ReportsScreen() {
  const project = useWorkspace((s) => s.project);
  const issues = useWorkspace((s) => s.issues);
  const pkg = useShell((s) => s.pkg);
  const roadOpen = useRoad((s) => s.status === 'ready' || s.status === 'setup');
  const listed = useCall('report:list', { projectId: project?.id ?? '' }, project?.id ?? null);
  const withData = useSectionsWithData(project?.id ?? null);
  const [picked, setPicked] = useState<Record<string, string>>({});
  const [textOpen, setTextOpen] = useState(false);
  const auditOpen = useAuditOpen();
  if (!project)
    return (
      <>
        <PageHeader heading="nav.reports" />
        <NoProject view="Reports" />
      </>
    );
  const files = listed === null ? null : listed.ok ? listed.value.files : [];
  const selected = picked[project.id] ?? files?.[0]?.path ?? null;
  const file = files?.find((f) => f.path === selected) ?? null;
  const models = project.manifest.severityModels;

  const page = (
    <FocusZone kind="report" className="screen reports" aria-label="Reports">
      <h1 className="sr-only">Reports</h1>
      <aside className="rep-side" aria-label="Report files">
        <div className="panel-h">
          <h2>
            <Icon name="report" size={14} />
            Reports
          </h2>
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
            sections={offeredSections(withData)}
            empty={exportUnavailable('house-pdf', project.manifest, issues) !== null}
            defaultPages={defaultIssuePages(
              houseKind(project.manifest, issues, roadOpen ? { road: true } : {}),
            )}
            onText={() => {
              closeAuditTrail();
              setTextOpen(true);
            }}
          />
          <section className="sblock" data-testid="audit-trail-section">
            <h2>{t('audit.title')}</h2>
            <p className="muted rep-note">{t('audit.reports.text')}</p>
            <button
              type="button"
              className="btn"
              aria-pressed={auditOpen}
              data-testid="open-audit-trail"
              onClick={() => {
                setTextOpen(false);
                openAuditTrail();
              }}
            >
              <Icon name="history" size={14} />
              {t('audit.open')}
            </button>
          </section>
          <SignOff readOnly={Boolean(pkg)} />
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
        {auditOpen ? (
          <AuditScreen key={project.id} projectId={project.id} onClose={closeAuditTrail} />
        ) : textOpen ? (
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
            <p>{files?.length === 0 ? t('reports.viewer.none') : t('reports.viewer.pick')}</p>
          </div>
        )}
      </section>
    </FocusZone>
  );
  return (
    <>
      <PageHeader heading="nav.reports" />
      {page}
    </>
  );
}
