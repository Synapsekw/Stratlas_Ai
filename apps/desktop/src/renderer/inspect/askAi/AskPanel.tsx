/**
 * The Ask panel in Inspect's right column: a custom request, top to bottom. Saved requests (this
 * project's, then this computer's library), what to do (Find, Compare dates, Ask), the request
 * with the values to read, where it looks, the class and severity a draft carries when accepted,
 * which model answers (routing picks; the inspector may override) and Run. A cloud run shows the
 * cloud confirm first (unless the project said "Don't ask again"); a run on this PC starts at
 * once. Ask is a thread on the photo in view instead of a run. Every answer is a draft.
 */
import { ASK_MODELS, modelLabel, routeAsk, type AskRoute } from '@aio/ai';
import { useAnnotateReadOnly } from '@aio/annotate';
import type { AiRequest, AskModelChoice, ProjectManifest } from '@aio/schema';
import { Icon, useT, type MessageKey, type PhotoPick } from '@aio/ui';
import { useMemo, useRef, useState, type ReactElement } from 'react';
import { authorName } from '../../author';
import type { DetectItem } from '../../detections/convert';
import { bridge, shell, useCall } from '../../shell';
import { CloudConfirm } from './CloudConfirm';
import { askConfirmInfo, requestName, useAskStatus } from './custom';
import { DatePairPicker, type DatePair } from './DatePairPicker';
import { askAiPrefs, cloudConfirmSkipped } from './prefs';
import {
  draftRequest,
  editorProblem,
  emptyEditor,
  fromAiRequest,
  RequestEditor,
  toAiRequest,
  type EditorState,
  type FindScope,
  type RequestWhere,
} from './RequestEditor';
import { startAskRun, useAskAiRun } from './runs';
import { askThread } from './thread';
import { ThreadView } from './ThreadView';
import type { CloudConfirm as ConfirmInfo } from './backend';
import './askAi.css';
import './askPanel.css';

type PhotoItem = DetectItem & { kind: 'photo' };
const photoItem = (p: PhotoPick): PhotoItem => ({
  kind: 'photo',
  layer: p.layerId,
  photo: p.photoId,
});

const PROVIDER = { anthropic: 'Anthropic', openai: 'OpenAI' } as const;
const choiceValue = (c: AskModelChoice) => (typeof c === 'string' ? c : `${c.provider}:${c.model}`);
const usecaseValue = (where: RequestWhere, id: string) => `${where}:${id}`;

export function AskPanel({
  projectId,
  projectRoot,
  manifest,
  current,
  selected,
  all,
  onClose,
}: {
  projectId: string;
  projectRoot: string;
  manifest: ProjectManifest;
  current: PhotoPick | null;
  selected: readonly PhotoPick[];
  all: readonly PhotoPick[];
  onClose: () => void;
}): ReactElement {
  const t = useT();
  const readOnly = useAnnotateReadOnly();
  const status = useAskStatus(projectId);
  const running = useAskAiRun(
    (s) => s.run?.phase === 'running' || s.run?.phase === 'queued' || s.run?.phase === 'stopping',
  );

  const [editor, setEditor] = useState<EditorState>(emptyEditor);
  // the thread's question box, so a saved Ask request fills it and Save can keep it
  const [question, setQuestion] = useState('');
  const [rev, setRev] = useState(0);
  const listed = useCall('requests:list', { projectId }, `${projectId}|${String(rev)}`);
  const saved = listed?.ok ? listed.value : null;
  const [naming, setNaming] = useState<{ where: RequestWhere; name: string } | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [message, setMessage] = useState<{ text: string; err?: true } | null>(null);
  const [pair, setPair] = useState<{ key: string; capture: string; pair: DatePair } | null>(null);
  const [confirm, setConfirm] = useState<{ info: ConfirmInfo; go: () => void } | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const starting = useRef(false);

  const edit = (s: EditorState) => {
    setEditor(s);
    setConfirm(null);
  };
  // bumped on every load (New, a saved request, Import): the editor starts afresh, so nothing
  // typed for the previous request (a choices box mid-word) outlives it
  const [loads, setLoads] = useState(0);
  const load = (s: EditorState) => {
    edit(s);
    setLoads((n) => n + 1);
    setQuestion(s.kind === 'ask' ? s.prompt : '');
    setNaming(null);
    setDeleting(false);
  };

  // where it looks
  const currentItem = useMemo(() => (current ? photoItem(current) : null), [current]);
  const currentKey = current ? `${current.layerId}/${current.photoId}` : '';
  const findScope: FindScope =
    (editor.scope === 'selected' && selected.length === 0) ||
    (editor.scope === 'all' && all.length === 0)
      ? 'photo'
      : editor.scope;
  // a pair belongs to the photo it was picked from
  const datePair = pair?.key === currentKey ? pair : null;
  const items = useMemo<PhotoItem[]>(() => {
    if (editor.kind === 'change')
      return datePair ? [datePair.pair.before, datePair.pair.after] : [];
    if (editor.kind === 'ask') return currentItem ? [currentItem] : [];
    if (findScope === 'selected') return selected.map(photoItem);
    if (findScope === 'all') return all.map(photoItem);
    return currentItem ? [currentItem] : [];
  }, [editor.kind, datePair, findScope, selected, all, currentItem]);

  // which model answers
  const cloudUsable = status !== null && status.cloud.usable && !status.keepLocal;
  const routed = status
    ? routeAsk({
        kind: editor.kind,
        scope: editor.kind === 'change' ? 'dates' : editor.kind === 'ask' ? 'photo' : findScope,
        choice: editor.model,
        cloud: { usable: cloudUsable, providers: status.cloud.providers },
        local: { ready: status.local.ready },
      })
    : null;
  const route: AskRoute | null = routed && 'route' in routed ? routed.route : null;
  const none = routed && 'none' in routed ? routed.none : null;

  /** Why a model choice cannot be used now; null when it can. */
  const whyOff = (c: AskModelChoice): string | null => {
    if (!status) return null;
    if (c === 'auto') return null;
    if (c === 'local') return status.local.ready ? null : t('askPanel.model.why.local');
    if (status.keepLocal) return t('askPanel.model.why.keepLocal');
    if (!status.cloud.usable) return t('askPanel.model.why.cloud');
    if (!status.cloud.providers.includes(c.provider))
      return t('askPanel.model.why.key', { provider: PROVIDER[c.provider] });
    return null;
  };
  const choices: { choice: AskModelChoice; label: string }[] = [
    { choice: 'auto', label: t('askPanel.model.auto') },
    { choice: 'local', label: t('askPanel.model.thisPc') },
    ...ASK_MODELS.map((m) => ({
      choice: { provider: m.provider, model: m.model },
      label: m.best
        ? t('askPanel.model.best', { model: modelLabel(m.model) })
        : modelLabel(m.model),
    })),
  ];

  const problem = editorProblem(editor, editor.kind === 'ask' ? question : editor.prompt);
  const runOff = readOnly || running || route === null || problem !== null || items.length === 0;

  const start = async (r: AskRoute, confirmed: boolean) => {
    if (starting.current) return;
    starting.current = true;
    setRunError(null);
    const request = draftRequest(editor);
    try {
      await startAskRun({
        projectId,
        projectRoot,
        manifest,
        items,
        check: { kind: 'everything' },
        what: requestName(request),
        // a custom run goes by its route; the backend is not read
        backend: { kind: 'cloud', provider: '', model: '' },
        prefs: askAiPrefs.getState(),
        ...(confirmed ? { confirmed: true } : {}),
        custom: {
          request,
          route: r,
          ...(editor.kind === 'change' && datePair ? { pair: datePair.pair } : {}),
        },
      });
    } catch (e) {
      setRunError(e instanceof Error ? e.message : String(e));
    } finally {
      starting.current = false;
    }
  };
  const run = () => {
    if (runOff || editor.kind === 'ask') return;
    if (route.kind === 'cloud' && !cloudConfirmSkipped(projectId)) {
      const request = draftRequest(editor);
      setConfirm({
        info: askConfirmInfo({
          route,
          items,
          request,
          requests: editor.kind === 'change' ? 1 : items.length,
        }),
        go: () => {
          void start(route, true);
        },
      });
    } else void start(route, false);
  };

  // saved requests
  /** Says why a call failed; true when it did. */
  const failed = (
    res:
      | { ok: true; value: { ok: true } | { ok: false; error: string } }
      | { ok: false; error: string },
  ): boolean => {
    const error = !res.ok ? res.error : !res.value.ok ? res.value.error : null;
    if (error === null) return false;
    setMessage({ text: t('askPanel.usecase.failed', { error }), err: true });
    return true;
  };
  /** What Save keeps: the request's words, or for Ask the question box or the thread's first question. */
  const savedPrompt = () => {
    if (editor.kind !== 'ask') return editor.prompt;
    if (question.trim() !== '') return question;
    return askThread.getState().turns.find((x) => x.role === 'user')?.text ?? '';
  };
  const save = async (where: RequestWhere, name: string) => {
    const prompt = savedPrompt();
    const why = editorProblem(editor, prompt);
    if (why) {
      setMessage({ text: t(why), err: true });
      return;
    }
    let request: AiRequest;
    try {
      request = toAiRequest(editor, {
        name,
        where,
        author: authorName() || 'user',
        now: new Date().toISOString(),
        prompt,
      });
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      setMessage({ text: t('askPanel.usecase.failed', { error }), err: true });
      return;
    }
    const res = await bridge.call('requests:save', { projectId, where, request });
    if (failed(res)) return;
    setNaming(null);
    edit({ ...fromAiRequest(request, where), scope: editor.scope });
    setRev((n) => n + 1);
    setMessage({
      text: t(where === 'library' ? 'askPanel.usecase.savedLibrary' : 'askPanel.usecase.saved', {
        name: request.name,
      }),
    });
  };
  const exportIt = async () => {
    if (!editor.saved) return;
    const { where, id } = editor.saved;
    const res = await bridge.call('requests:export', { projectId, where, id });
    if (failed(res)) return;
    if (res.ok && res.value.ok && res.value.path !== undefined)
      setMessage({ text: t('askPanel.usecase.exported', { path: res.value.path }) });
  };
  const importIt = async () => {
    const res = await bridge.call('requests:import', { projectId, where: 'project' });
    if (failed(res)) return;
    const r = res.ok && res.value.ok ? res.value.request : undefined;
    if (!r) return;
    load(fromAiRequest(r, 'project'));
    setRev((n) => n + 1);
    setMessage({ text: t('askPanel.usecase.imported', { name: r.name }) });
  };
  const remove = async () => {
    if (!editor.saved) return;
    const { where, id } = editor.saved;
    const res = await bridge.call('requests:remove', { projectId, where, id });
    if (failed(res)) return;
    const name = editor.name;
    load(emptyEditor());
    setRev((n) => n + 1);
    setMessage({ text: t('askPanel.usecase.deleted', { name }) });
  };
  const pickSaved = (value: string) => {
    setMessage(null);
    if (value === '') {
      load(emptyEditor());
      return;
    }
    const hit = saved?.items.find((x) => usecaseValue(x.where, x.request.id) === value);
    if (hit) load(fromAiRequest(hit.request, hit.where));
  };
  const projectSaved = saved?.items.filter((x) => x.where === 'project') ?? [];
  const librarySaved = saved?.items.filter((x) => x.where === 'library') ?? [];

  // what to say about the route
  const modelLine =
    route === null
      ? t('askPanel.model.none')
      : route.kind === 'local'
        ? t('askPanel.model.local')
        : t('askPanel.model.cloud', { model: modelLabel(route.model) });
  const noneText = (() => {
    if (none === null || !status) return null;
    const why: [MessageKey, string | undefined] =
      none === 'nothing'
        ? ['askPanel.note.nothing', status.local.problem ?? status.cloud.message]
        : none === 'cloud'
          ? ['askPanel.note.cloud', whyOff(editor.model) ?? status.cloud.message]
          : ['askPanel.note.local', status.local.problem];
    return [t(why[0]), why[1]].filter(Boolean).join(' ');
  })();
  const weak = routed !== null && 'route' in routed && routed.weakOffline;

  const scopeButton = (s: FindScope, label: string, off: boolean) => (
    <button
      type="button"
      aria-pressed={findScope === s}
      data-testid={`ask-scope-${s}`}
      disabled={off}
      onClick={() => {
        edit({ ...editor, scope: s });
      }}
    >
      {label}
    </button>
  );

  return (
    <section className="askp" data-testid="ask-panel" aria-label={t('askPanel.title')}>
      <header className="askp-h">
        <div className="askp-h-row">
          <h3>
            <Icon name="agent" size={14} className="ask-spark" />
            {t('askPanel.title')}
          </h3>
          <button
            type="button"
            className="btn ghost icon sm"
            data-testid="ask-panel-close"
            aria-label={t('askPanel.close')}
            onClick={onClose}
          >
            <Icon name="x" size={14} />
          </button>
        </div>
        <p className="askp-sub">{t('askPanel.sub')}</p>
      </header>

      <div className="askp-body">
        <section className="askp-block askp-usecases" aria-label={t('askPanel.usecase')}>
          <select
            className="input"
            data-testid="ask-usecase"
            aria-label={t('askPanel.usecase')}
            value={editor.saved ? usecaseValue(editor.saved.where, editor.saved.id) : ''}
            onChange={(e) => {
              pickSaved(e.target.value);
            }}
          >
            <option value="">{t('askPanel.usecase.unsaved')}</option>
            {projectSaved.length > 0 && (
              <optgroup label={t('askPanel.usecase.project')}>
                {projectSaved.map((x) => (
                  <option key={x.request.id} value={usecaseValue('project', x.request.id)}>
                    {x.request.name}
                  </option>
                ))}
              </optgroup>
            )}
            {librarySaved.length > 0 && (
              <optgroup label={t('askPanel.usecase.library')}>
                {librarySaved.map((x) => (
                  <option key={x.request.id} value={usecaseValue('library', x.request.id)}>
                    {x.request.name}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
          <div className="askp-acts">
            <button
              type="button"
              className="btn ghost sm"
              data-testid="ask-usecase-new"
              onClick={() => {
                setMessage(null);
                load(emptyEditor());
              }}
            >
              {t('askPanel.usecase.new')}
            </button>
            <button
              type="button"
              className="btn ghost sm"
              data-testid="ask-usecase-save"
              disabled={readOnly}
              onClick={() => {
                setNaming({ where: 'project', name: editor.name });
              }}
            >
              {t('askPanel.usecase.save')}
            </button>
            <button
              type="button"
              className="btn ghost sm"
              data-testid="ask-usecase-save-library"
              onClick={() => {
                setNaming({ where: 'library', name: editor.name });
              }}
            >
              {t('askPanel.usecase.saveLibrary')}
            </button>
            <button
              type="button"
              className="btn ghost sm"
              data-testid="ask-usecase-export"
              disabled={!editor.saved}
              onClick={() => {
                void exportIt();
              }}
            >
              {t('askPanel.usecase.export')}
            </button>
            <button
              type="button"
              className="btn ghost sm"
              data-testid="ask-usecase-import"
              disabled={readOnly}
              onClick={() => {
                void importIt();
              }}
            >
              {t('askPanel.usecase.import')}
            </button>
            <button
              type="button"
              className={`btn ghost sm${deleting ? ' danger' : ''}`}
              data-testid="ask-usecase-delete"
              disabled={!editor.saved || (readOnly && editor.saved.where === 'project')}
              onClick={() => {
                if (deleting) {
                  setDeleting(false);
                  void remove();
                } else setDeleting(true);
              }}
              onBlur={() => {
                setDeleting(false);
              }}
            >
              {t(deleting ? 'askPanel.usecase.deleteSure' : 'askPanel.usecase.delete')}
            </button>
          </div>
          {naming && (
            <form
              className="askp-name"
              onSubmit={(e) => {
                e.preventDefault();
                void save(naming.where, naming.name);
              }}
            >
              <input
                className="input"
                data-testid="ask-usecase-name"
                aria-label={t('askPanel.usecase.name')}
                placeholder={t('askPanel.usecase.namePlaceholder')}
                maxLength={80}
                autoFocus
                value={naming.name}
                onChange={(e) => {
                  setNaming({ ...naming, name: e.target.value });
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    e.stopPropagation();
                    setNaming(null);
                  }
                }}
              />
              <button
                type="submit"
                className="btn sm primary"
                data-testid="ask-usecase-name-ok"
                disabled={naming.name.trim() === ''}
              >
                {t(
                  naming.where === 'library'
                    ? 'askPanel.usecase.saveLibrary'
                    : 'askPanel.usecase.save',
                )}
              </button>
              <button
                type="button"
                className="btn ghost sm"
                onClick={() => {
                  setNaming(null);
                }}
              >
                {t('askPanel.usecase.cancel')}
              </button>
            </form>
          )}
          {message && (
            <p
              className={`askp-note${message.err ? ' err' : ''}`}
              role={message.err ? 'alert' : 'status'}
              data-testid="ask-usecase-message"
            >
              {message.text}
            </p>
          )}
          {saved && saved.problems.length > 0 && (
            <p className="askp-note faint small">
              {t('askPanel.usecase.problems', { count: saved.problems.length })}
            </p>
          )}
        </section>

        <RequestEditor
          key={loads}
          state={editor}
          manifest={manifest}
          disabled={readOnly}
          onChange={edit}
        />

        {editor.kind === 'find' && (
          <div className="askp-block">
            <span className="askp-label">{t('askPanel.scope')}</span>
            <div className="seg askp-scope" role="group" aria-label={t('askPanel.scope')}>
              {scopeButton('photo', t('askPanel.scope.photo'), current === null)}
              {scopeButton(
                'selected',
                t('askPanel.scope.selected', { count: selected.length }),
                selected.length === 0,
              )}
              {scopeButton('all', t('askPanel.scope.all', { count: all.length }), all.length === 0)}
            </div>
          </div>
        )}
        {editor.kind === 'change' && (
          <div className="askp-block">
            <span className="askp-label">{t('askPanel.dates')}</span>
            <DatePairPicker
              open={
                current
                  ? { item: { kind: 'photo', layer: current.layerId, photo: current.photoId } }
                  : null
              }
              picked={datePair?.capture ?? null}
              onPick={(p, capture) => {
                setPair({ key: currentKey, capture, pair: p });
                setConfirm(null);
              }}
            />
          </div>
        )}
        {editor.kind === 'ask' && (
          <p className="askp-note faint" data-testid="ask-scope-ask">
            {t('askPanel.scope.askPhoto')}
          </p>
        )}
        {editor.kind === 'ask' && (
          <ThreadView
            projectId={projectId}
            manifest={manifest}
            item={currentItem}
            route={route}
            disabled={route === null}
            text={question}
            onText={setQuestion}
            onNeedConfirm={(text, send) => {
              if (route?.kind !== 'cloud' || !currentItem) return;
              setConfirm({
                info: askConfirmInfo({
                  route,
                  items: [currentItem],
                  request: { name: editor.name, kind: 'ask', prompt: text, fields: [] },
                  requests: 1,
                }),
                go: send,
              });
            }}
          />
        )}
      </div>

      <footer className="askp-foot">
        <div className="askp-model">
          <span className="askp-model-line" data-testid="ask-model">
            {modelLine}
          </span>
          <select
            className="input askp-model-pick"
            data-testid="ask-model-pick"
            aria-label={t('askPanel.model.pick')}
            value={choiceValue(editor.model)}
            onChange={(e) => {
              const hit = choices.find((c) => choiceValue(c.choice) === e.target.value);
              if (hit) edit({ ...editor, model: hit.choice });
            }}
          >
            {choices.map((c) => {
              const why = whyOff(c.choice);
              return (
                <option
                  key={choiceValue(c.choice)}
                  value={choiceValue(c.choice)}
                  disabled={why !== null}
                >
                  {why === null ? c.label : t('askPanel.model.off', { label: c.label, why })}
                </option>
              );
            })}
          </select>
        </div>
        {weak && (
          <p className="askp-note" data-testid="ask-note-weak">
            {t('askPanel.note.weak')}
          </p>
        )}
        {status?.keepLocal && (
          <p className="askp-note" data-testid="ask-note-local">
            <Icon name="lock" size={12} />
            {t('askPanel.note.keepLocal')}
          </p>
        )}
        {noneText !== null && (
          <p className="askp-note" data-testid="ask-note-none">
            <span>{noneText}</span>
            <button
              type="button"
              className="btn link sm"
              data-testid="ask-settings"
              onClick={() => {
                shell.getState().openSettingsPage('ai');
              }}
            >
              {t('askPanel.note.settings')}
            </button>
          </p>
        )}
        {editor.kind === 'find' && findScope === 'photo' && current === null && (
          <p className="askp-note faint" data-testid="ask-no-photo">
            {t('askPanel.note.noPhoto')}
          </p>
        )}
        {readOnly && (
          <p className="askp-note faint" data-testid="ask-readonly">
            {t('inspect.readOnly')}
          </p>
        )}

        {confirm && !readOnly && (
          <CloudConfirm
            projectId={projectId}
            layers={manifest.layers}
            confirm={confirm.info}
            onSend={() => {
              const go = confirm.go;
              setConfirm(null);
              go();
            }}
            onCancel={() => {
              setConfirm(null);
            }}
          />
        )}

        {editor.kind !== 'ask' && (
          <>
            {problem !== null &&
              !readOnly &&
              (editor.prompt !== '' || editor.fields.length > 0) && (
                <p className="askp-note faint" data-testid="ask-problem">
                  {t(problem)}
                </p>
              )}
            {runError !== null && (
              <p className="askp-note err" role="alert" data-testid="ask-run-error">
                {t('askPanel.run.failed', { error: runError })}
              </p>
            )}
            <button
              type="button"
              className="btn primary askp-run"
              data-testid="ask-run"
              disabled={runOff || confirm !== null}
              onClick={run}
            >
              <Icon name="agent" size={14} />
              {t(running ? 'askPanel.running' : 'askPanel.run')}
            </button>
          </>
        )}
      </footer>
    </section>
  );
}
