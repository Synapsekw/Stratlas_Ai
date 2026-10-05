// The report text editor (BLD-7): the executive summary, method and findings overview of the
// project report, drafted by AI from the statistics (after the AI-6 preview) or from a template
// when cloud AI is off, edited in place and saved as versions in `report/narrative.json`.
import { narrativeRequest, parseNarrativeReply, type NarrativeRequest } from '@aio/ai/narrative';
import { PROVIDER_LABELS } from '@aio/ai/routes';
import {
  houseReportModel,
  narrativeFacts,
  resolveReportBranding,
  type NarrativeFacts,
} from '@aio/project/export';
import {
  NARRATIVE_SECTIONS,
  parseRoadModel,
  type IpcResponse,
  type NarrativeFile,
  type NarrativeSectionId,
  type RoadModel,
} from '@aio/schema';
import { brand } from '@aio/brand';
import { Icon, t, useFocusTrap } from '@aio/ui';
import { assetUrl, useWorkspace } from '@aio/workspace';
import { useEffect, useMemo, useRef, useState } from 'react';
import { authorName } from '../author';
import { bridge } from '../shell';
import {
  changedParts,
  editorTexts,
  hasPlaceholders,
  restoreVersion,
  saveParts,
  versionsOf,
  type Drafts,
} from './narrativeModel';
import { templateNarrative } from './narrativeTemplate';

type Key = Parameters<typeof t>[0];
const tk = (key: string, vars?: Record<string, string | number>) => t(key as Key, vars);

const PART_TITLE: Record<NarrativeSectionId, string> = {
  summary: 'house.sec.summary',
  method: 'house.sec.scope',
  findings: 'house.findings',
};

type Route = NonNullable<IpcResponse<'ai:status'>['route']>;

interface Preview {
  route: Route;
  request: NarrativeRequest;
  resolve: (send: { always: boolean } | null) => void;
}

const when = (iso: string) =>
  new Date(iso).toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });

/** Volumes and road model of the open project, for the statistics the text is written from. */
function useExtras(projectId: string | null) {
  const [extras, setExtras] = useState<{
    key: string;
    volumes: IpcResponse<'project:readVolumes'> | null;
    road: RoadModel | null;
  } | null>(null);
  useEffect(() => {
    if (!projectId) return;
    const alive = { current: true };
    void (async () => {
      const v = await bridge.call('project:readVolumes', { projectId });
      let road: RoadModel | null = null;
      try {
        const r = await fetch(assetUrl(projectId, { path: 'road.json' }));
        if (r.ok) {
          const parsed = parseRoadModel(await r.json());
          road = parsed.ok ? parsed.value : null;
        }
      } catch {
        road = null;
      }
      if (alive.current) setExtras({ key: projectId, volumes: v.ok ? v.value : null, road });
    })();
    return () => {
      alive.current = false;
    };
  }, [projectId]);
  return extras?.key === projectId ? extras : null;
}

function PreviewDialog({ preview, project }: { preview: Preview; project: string }) {
  const [always, setAlways] = useState(false);
  const send = useRef<HTMLButtonElement>(null);
  const dlg = useRef<HTMLDivElement>(null);
  useFocusTrap(dlg, true, { initial: () => send.current });
  return (
    <div className="dlg-scrim">
      <div
        ref={dlg}
        className="dlg wide"
        role="dialog"
        aria-modal="true"
        aria-labelledby="nar-prev-h"
        data-testid="narrative-preview"
        onKeyDown={(e) => {
          if (e.key === 'Escape') preview.resolve(null);
        }}
      >
        <div className="dlg-h">
          <Icon name="send" size={16} />
          <h2 id="nar-prev-h">
            {tk('reports.text.previewTitle', { provider: PROVIDER_LABELS[preview.route.provider] })}
          </h2>
        </div>
        <div className="dlg-b">
          <p className="muted small">{tk('reports.text.previewText', { project })}</p>
          <dl className="nar-sent">
            <dt className="caps">{tk('reports.text.previewModel')}</dt>
            <dd className="mono">
              {PROVIDER_LABELS[preview.route.provider]} · {preview.route.model}
            </dd>
            <dt className="caps">{tk('reports.text.previewSystem')}</dt>
            <dd>
              <pre>{preview.request.system}</pre>
            </dd>
            <dt className="caps">{tk('reports.text.previewPrompt')}</dt>
            <dd>
              <pre>{preview.request.prompt}</pre>
            </dd>
          </dl>
        </div>
        <div className="dlg-f">
          <label className="nar-always grow">
            <input
              type="checkbox"
              checked={always}
              onChange={(e) => {
                setAlways(e.target.checked);
              }}
            />
            {tk('reports.text.always')}
          </label>
          <button
            type="button"
            className="btn"
            onClick={() => {
              preview.resolve(null);
            }}
          >
            {tk('reports.text.cancel')}
          </button>
          <button
            ref={send}
            type="button"
            className="btn primary"
            onClick={() => {
              preview.resolve({ always });
            }}
          >
            <Icon name="send" size={14} />
            {tk('reports.text.send')}
          </button>
        </div>
      </div>
    </div>
  );
}

export function NarrativeEditor({ onClose }: { onClose: () => void }) {
  const project = useWorkspace((s) => s.project);
  const issues = useWorkspace((s) => s.issues);
  const projectId = project?.id ?? null;
  const extras = useExtras(projectId);
  const [file, setFile] = useState<NarrativeFile | null>(null);
  const [readOnly, setReadOnly] = useState(false);
  const [loaded, setLoaded] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Drafts | null>(null);
  const [busy, setBusy] = useState<NarrativeSectionId[] | null>(null);
  const [note, setNote] = useState<{ kind: 'info' | 'error'; text: string } | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const run = useRef<string | null>(null);

  const facts: NarrativeFacts | null = useMemo(() => {
    if (!project || !extras) return null;
    return narrativeFacts(
      houseReportModel({
        manifest: project.manifest,
        issues,
        branding: resolveReportBranding(undefined, brand.productName),
        volumes: extras.volumes?.ok ? extras.volumes.volumes : null,
        edits: extras.volumes?.ok ? extras.volumes.edits : null,
        road: extras.road,
      }),
    );
  }, [project, issues, extras]);

  useEffect(() => {
    if (!projectId || !facts || loaded === projectId) return;
    let live = true;
    void bridge.call('report:readNarrative', { projectId }).then((r) => {
      if (!live) return;
      const res = r.ok ? r.value : { ok: false as const, error: r.error };
      if (!res.ok) {
        setNote({ kind: 'error', text: res.error });
        setDrafts(templateNarrative(facts, { todo: false }));
      } else {
        setFile(res.file);
        setReadOnly(res.readOnly);
        setDrafts(editorTexts(res.file, templateNarrative(facts, { todo: false })));
      }
      setLoaded(projectId);
    });
    return () => {
      live = false;
    };
  }, [projectId, facts, loaded]);

  // stop a running draft when the editor closes
  useEffect(
    () => () => {
      if (run.current) void bridge.call('ai:cancel', { runId: run.current });
    },
    [],
  );

  if (!project || !drafts || !facts) {
    return (
      <div className="nar" aria-busy="true">
        <p className="muted">{t('reports.text.title')}</p>
      </div>
    );
  }

  const persist = async (next: NarrativeFile | null): Promise<boolean> => {
    if (!next || next === file) return true;
    const r = await bridge.call('report:writeNarrative', { projectId: project.id, file: next });
    const res = r.ok ? r.value : { ok: false, error: r.error };
    if (!res.ok) {
      setNote({ kind: 'error', text: res.error ?? '' });
      return false;
    }
    setFile(next);
    return true;
  };

  const saveEdits = async () => {
    const changed = changedParts(file, drafts);
    if (changed.length === 0) return;
    const texts = Object.fromEntries(changed.map((id) => [id, drafts[id]])) as Partial<Drafts>;
    const author = authorName();
    if (await persist(saveParts(file, texts, { source: 'user', ...(author ? { author } : {}) })))
      setNote({ kind: 'info', text: t('reports.text.saved') });
  };

  /** Ask before the first cloud send in a project (AI-6), unless always allowed. */
  const confirmSend = async (route: Route, request: NarrativeRequest): Promise<boolean> => {
    const state = await bridge.call('ai:project', { projectId: project.id });
    if (state.ok && state.value.alwaysAllow) return true;
    const answer = await new Promise<{ always: boolean } | null>((resolve) => {
      setPreview({ route, request, resolve });
    });
    setPreview(null);
    if (!answer) return false;
    if (answer.always)
      await bridge.call('ai:setConsent', { projectId: project.id, alwaysAllow: true });
    return true;
  };

  const draft = async (parts: readonly NarrativeSectionId[]) => {
    setNote(null);
    const status = await bridge.call('ai:status', { projectId: project.id, task: 'report' });
    const ready = status.ok && status.value.ready;
    if (!ready) {
      // Cloud AI off (or no key, no route): the template, with prompts for the author.
      const template = templateNarrative(facts, { todo: true });
      const texts = Object.fromEntries(parts.map((id) => [id, template[id]])) as Partial<Drafts>;
      const next = saveParts(file, texts, { source: 'template' });
      if (await persist(next)) {
        setDrafts({ ...drafts, ...texts });
        const why = status.ok && status.value.reason !== 'cloud-off' ? status.value.message : '';
        setNote({
          kind: 'info',
          text: [t('reports.text.templateNote'), why].filter(Boolean).join(' '),
        });
      }
      return;
    }
    const route = status.value.route;
    const request = narrativeRequest(facts, parts);
    if (route && status.value.cloud && !(await confirmSend(route, request))) return;
    const runId = globalThis.crypto.randomUUID().slice(0, 32);
    run.current = runId;
    setBusy([...parts]);
    try {
      const r = await bridge.call('ai:draftText', {
        runId,
        projectId: project.id,
        task: 'report',
        ...request,
      });
      const res = r.ok ? r.value : { ok: false as const, error: r.error };
      if (!res.ok) {
        setNote({ kind: 'error', text: res.error });
        return;
      }
      const parsed = parseNarrativeReply(res.text, parts);
      if (!parsed.ok) {
        setNote({ kind: 'error', text: parsed.error });
        return;
      }
      const next = saveParts(file, parsed.parts, {
        source: 'ai',
        provider: res.provider,
        model: res.model,
      });
      if (await persist(next)) setDrafts({ ...drafts, ...parsed.parts });
    } finally {
      run.current = null;
      setBusy(null);
    }
  };

  const restore = async (id: NarrativeSectionId, index: number) => {
    if (!file) return;
    const next = restoreVersion(file, id, index);
    const text = next.parts[id]?.versions.at(-1)?.text;
    if ((await persist(next)) && text !== undefined) setDrafts({ ...drafts, [id]: text });
  };

  const changed = changedParts(file, drafts);
  const locked = readOnly || busy !== null;

  return (
    <section className="nar" aria-label={t('reports.text.title')} data-testid="narrative-editor">
      <header className="nar-h">
        <button type="button" className="btn ghost sm" onClick={onClose}>
          <Icon name="back" size={14} />
          {t('reports.text.close')}
        </button>
        <h2>{t('reports.text.title')}</h2>
        <span className="grow" />
        <button
          type="button"
          className="btn sm"
          disabled={locked}
          onClick={() => void draft(NARRATIVE_SECTIONS)}
          data-testid="narrative-draft-all"
        >
          <Icon name="agent" size={14} />
          {busy ? t('reports.text.drafting') : t('reports.text.draft')}
        </button>
        <button
          type="button"
          className="btn primary sm"
          disabled={locked || changed.length === 0}
          onClick={() => void saveEdits()}
        >
          {t('reports.text.save')}
        </button>
      </header>
      <div className="nar-in">
        <p className="muted small">
          {readOnly ? t('reports.text.readOnly') : t('reports.text.intro')}
        </p>
        {note && (
          <p
            className={`notice${note.kind === 'error' ? ' danger' : ''}`}
            role={note.kind === 'error' ? 'alert' : 'status'}
            data-testid="narrative-note"
          >
            {note.text}
          </p>
        )}
        {NARRATIVE_SECTIONS.map((id) => {
          const versions = versionsOf(file, id);
          const dirty = changed.includes(id);
          return (
            <div key={id} className="nar-part" data-part={id}>
              <div className="nar-part-h">
                <h3 className="caps">{tk(PART_TITLE[id])}</h3>
                <span className={`nar-state${dirty ? ' dirty' : ''}`}>
                  {versions.length === 0
                    ? t('reports.text.unsaved')
                    : dirty
                      ? t('reports.text.unsaved')
                      : t('reports.text.saved')}
                </span>
                <span className="grow" />
                <button
                  type="button"
                  className="btn ghost sm"
                  disabled={locked}
                  onClick={() => void draft([id])}
                  aria-label={`${t('reports.text.draft')}: ${tk(PART_TITLE[id])}`}
                >
                  <Icon name="agent" size={12} />
                  {busy?.includes(id) ? t('reports.text.drafting') : t('reports.text.draft')}
                </button>
              </div>
              <textarea
                className="nar-text"
                value={drafts[id]}
                readOnly={locked}
                rows={8}
                aria-label={tk(PART_TITLE[id])}
                onChange={(e) => {
                  setDrafts({ ...drafts, [id]: e.target.value });
                }}
                onBlur={() => {
                  if (!readOnly && changedParts(file, drafts).includes(id)) void saveEdits();
                }}
              />
              {hasPlaceholders(drafts[id]) && (
                <p className="nar-hint small">{t('reports.text.placeholders')}</p>
              )}
              {versions.length === 0 ? (
                <p className="faint small">{t('reports.text.empty')}</p>
              ) : (
                <details className="nar-versions">
                  <summary className="small">
                    {t('reports.text.versions')} · {versions.length}
                  </summary>
                  <ol>
                    {versions.map(({ index, version }, i) => (
                      <li key={index}>
                        <span className="small">
                          {tk('reports.text.versionLine', {
                            source: tk(`reports.text.source.${version.source}`),
                            when: when(version.createdAt),
                          })}
                          {version.model ? ` · ${version.model}` : ''}
                        </span>
                        <span className="nar-snippet faint small">
                          {version.text.slice(0, 140)}
                        </span>
                        {i > 0 && !readOnly && (
                          <button
                            type="button"
                            className="btn ghost sm"
                            disabled={locked}
                            onClick={() => void restore(id, index)}
                          >
                            {t('reports.text.restore')}
                          </button>
                        )}
                      </li>
                    ))}
                  </ol>
                </details>
              )}
            </div>
          );
        })}
      </div>
      {preview && <PreviewDialog preview={preview} project={project.manifest.name} />}
    </section>
  );
}
